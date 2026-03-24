use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::Path;
use std::time::Instant;

#[derive(Clone, Debug)]
struct Row {
    ticker: String,
    date: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
}

#[derive(Clone, Copy)]
struct Params {
    max_red: usize,
    upclose_count: i32,
    atr_period: usize,
    atr_factor: i32,
}

#[derive(Clone)]
struct Trade {
    ticker: String,
    entry_date: String,
    exit_date: Option<String>,
    entry_price: f64,
    exit_price: Option<f64>,
    pct_chg: Option<f64>,
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn parse_args() -> (String, String, bool, usize) {
    let mut input = "./Data/idx_data.csv".to_string();
    let mut output = "./Position/New_Consecutive_Red_Candle_Daily_RS".to_string();
    let mut fixed_max = false;
    let mut max_red = 3usize;

    let args: Vec<String> = env::args().collect();
    let mut i = 1usize;
    while i < args.len() {
        match args[i].as_str() {
            "--input" if i + 1 < args.len() => {
                input = args[i + 1].clone();
                i += 1;
            }
            "--output" if i + 1 < args.len() => {
                output = args[i + 1].clone();
                i += 1;
            }
            "--fixed-max" => {
                fixed_max = true;
            }
            "--max-red" if i + 1 < args.len() => {
                max_red = args[i + 1].parse().unwrap_or(3);
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }

    (input, output, fixed_max, max_red)
}

fn get_params(ticker: &str, fixed_max: bool, manual_max: usize) -> Params {
    let max_red = if fixed_max {
        manual_max
    } else if ticker == "NIFTY 50" {
        7
    } else if ticker == "NIFTYBANK" {
        5
    } else {
        6
    };

    Params {
        max_red,
        upclose_count: if ticker != "NIFTY 50" { 2 } else { 3 },
        atr_period: 5,
        atr_factor: if ticker != "NIFTYMIDCAP100" { 2 } else { 4 },
    }
}

fn parse_csv(path: &str) -> Result<Vec<Row>, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
    let mut lines = content.lines();
    let header = lines.next().ok_or("empty csv")?;
    let cols: Vec<&str> = header.split(',').collect();

    let ticker_idx = cols.iter().position(|c| *c == "Ticker").ok_or("Ticker missing")?;
    let date_idx = cols.iter().position(|c| *c == "Date").ok_or("Date missing")?;
    let open_idx = cols.iter().position(|c| *c == "Open").ok_or("Open missing")?;
    let high_idx = cols.iter().position(|c| *c == "High").ok_or("High missing")?;
    let low_idx = cols.iter().position(|c| *c == "Low").ok_or("Low missing")?;
    let close_idx = cols.iter().position(|c| *c == "Close").ok_or("Close missing")?;

    let mut rows = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() <= close_idx {
            continue;
        }
        let open = match parts[open_idx].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let high = match parts[high_idx].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let low = match parts[low_idx].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let close = match parts[close_idx].parse::<f64>() {
            Ok(v) => v,
            Err(_) => continue,
        };

        rows.push(Row {
            ticker: parts[ticker_idx].to_string(),
            date: parts[date_idx].to_string(),
            open,
            high,
            low,
            close,
        });
    }
    Ok(rows)
}

fn sort_and_dedup(mut rows: Vec<Row>) -> Vec<Row> {
    rows.sort_by(|a, b| {
        a.ticker
            .cmp(&b.ticker)
            .then_with(|| a.date.cmp(&b.date))
    });

    let mut out: Vec<Row> = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(last) = out.last_mut() {
            if last.ticker == row.ticker && last.date == row.date {
                *last = row;
                continue;
            }
        }
        out.push(row);
    }
    out
}

fn group_by_ticker(rows: Vec<Row>) -> BTreeMap<String, Vec<Row>> {
    let mut grouped = BTreeMap::new();
    for row in rows {
        grouped
            .entry(row.ticker.clone())
            .or_insert_with(Vec::new)
            .push(row);
    }
    grouped
}

fn consecutive_counts(mask: &[bool]) -> Vec<usize> {
    let mut out = vec![0usize; mask.len()];
    let mut run = 0usize;
    for (i, v) in mask.iter().enumerate() {
        if *v {
            run += 1;
        } else {
            run = 0;
        }
        out[i] = run;
    }
    out
}

fn rolling_mean(values: &[f64], period: usize) -> Vec<Option<f64>> {
    let mut out = vec![None; values.len()];
    let mut sum = 0.0f64;
    for i in 0..values.len() {
        sum += values[i];
        if i >= period {
            sum -= values[i - period];
        }
        if i + 1 >= period {
            out[i] = Some(sum / period as f64);
        }
    }
    out
}

fn search_first_ge(values: &[i32], start: usize, target: i32) -> usize {
    let mut lo = start;
    let mut hi = values.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if values[mid] >= target {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

fn write_trades(path: &Path, trades: &[Trade]) -> Result<(), String> {
    let mut out = String::from("Ticker,Entry Date,Exit Date,Entry Price,Exit Price,% Chg\n");
    for trade in trades {
        let exit_date = trade.exit_date.clone().unwrap_or_default();
        let exit_price = trade
            .exit_price
            .map(|v| round2(v).to_string())
            .unwrap_or_default();
        let pct_chg = trade
            .pct_chg
            .map(|v| round2(v).to_string())
            .unwrap_or_default();

        out.push_str(&format!(
            "{},{},{},{},{},{}\n",
            trade.ticker,
            trade.entry_date,
            exit_date,
            round2(trade.entry_price),
            exit_price,
            pct_chg
        ));
    }
    fs::write(path, out).map_err(|e| format!("write failed: {e}"))
}

fn run_backtest(rows: Vec<Row>, output_dir: &str, fixed_max: bool, manual_max: usize) -> Result<(), String> {
    fs::create_dir_all(output_dir).map_err(|e| format!("mkdir failed: {e}"))?;
    let groups = group_by_ticker(sort_and_dedup(rows));

    for (ticker, group) in groups {
        let p = get_params(&ticker, fixed_max, manual_max);
        let n = group.len();
        if n == 0 {
            continue;
        }

        let mut dates = Vec::with_capacity(n);
        let mut open = Vec::with_capacity(n);
        let mut high = Vec::with_capacity(n);
        let mut low = Vec::with_capacity(n);
        let mut close = Vec::with_capacity(n);

        for row in &group {
            dates.push(row.date.clone());
            open.push(row.open);
            high.push(row.high);
            low.push(row.low);
            close.push(row.close);
        }

        let red_mask: Vec<bool> = open.iter().zip(close.iter()).map(|(o, c)| o > c).collect();
        let consec_red = consecutive_counts(&red_mask);
        let entry_idx: Vec<usize> = consec_red
            .iter()
            .enumerate()
            .filter_map(|(i, v)| if *v >= p.max_red { Some(i) } else { None })
            .collect();
        if entry_idx.is_empty() {
            continue;
        }

        let mut upclose = vec![0i32; n];
        for i in 1..n {
            upclose[i] = if close[i] > close[i - 1] { 1 } else { 0 };
        }

        let mut csum = vec![0i32; n];
        let mut running = 0i32;
        for i in 0..n {
            running += upclose[i];
            csum[i] = running;
        }

        let mut tr = vec![0.0f64; n];
        tr[0] = high[0] - low[0];
        for i in 1..n {
            let hl = high[i] - low[i];
            let hpc = (high[i] - close[i - 1]).abs();
            let lpc = (low[i] - close[i - 1]).abs();
            tr[i] = hl.max(hpc).max(lpc);
        }

        let atr = rolling_mean(&tr, p.atr_period);
        let mut final_atr_plot = vec![None; n];
        for i in 0..n {
            if let Some(atr_val) = atr[i] {
                let avg = (high[i] + low[i]) / 2.0;
                final_atr_plot[i] = Some(avg - atr_val * p.atr_factor as f64);
            }
        }

        let mut upclose_trades = Vec::new();
        let mut last_exit = None::<usize>;
        for &e in &entry_idx {
            if last_exit.is_some() && e <= last_exit.unwrap() {
                continue;
            }
            let target = csum[e] + p.upclose_count;
            let x = search_first_ge(&csum, e, target);
            let entry_price = round2(close[e]);
            if x >= n {
                upclose_trades.push(Trade {
                    ticker: ticker.clone(),
                    entry_date: dates[e].clone(),
                    exit_date: None,
                    entry_price,
                    exit_price: None,
                    pct_chg: None,
                });
                break;
            }
            let exit_price = round2(close[x]);
            upclose_trades.push(Trade {
                ticker: ticker.clone(),
                entry_date: dates[e].clone(),
                exit_date: Some(dates[x].clone()),
                entry_price,
                exit_price: Some(exit_price),
                pct_chg: Some(round2(100.0 * (exit_price - entry_price) / entry_price)),
            });
            last_exit = Some(x);
        }

        let mut atr_trades = Vec::new();
        last_exit = None;
        for &e in &entry_idx {
            if last_exit.is_some() && e <= last_exit.unwrap() {
                continue;
            }
            let mut trailing = match final_atr_plot[e] {
                Some(v) => v,
                None => continue,
            };
            let mut exit_idx = None::<usize>;
            for i in (e + 1)..n {
                if close[i] < trailing {
                    exit_idx = Some(i);
                    break;
                }
                if let Some(v) = final_atr_plot[i] {
                    if v > trailing {
                        trailing = v;
                    }
                }
            }

            let entry_price = round2(close[e]);
            if let Some(x) = exit_idx {
                let exit_price = round2(close[x]);
                atr_trades.push(Trade {
                    ticker: ticker.clone(),
                    entry_date: dates[e].clone(),
                    exit_date: Some(dates[x].clone()),
                    entry_price,
                    exit_price: Some(exit_price),
                    pct_chg: Some(round2(100.0 * (exit_price - entry_price) / entry_price)),
                });
                last_exit = Some(x);
            } else {
                atr_trades.push(Trade {
                    ticker: ticker.clone(),
                    entry_date: dates[e].clone(),
                    exit_date: None,
                    entry_price,
                    exit_price: None,
                    pct_chg: None,
                });
                break;
            }
        }

        if !upclose_trades.is_empty() {
            let file = Path::new(output_dir).join(format!(
                "{}_{}_Consec_RedCandle_{}_UpClose_Exit.csv",
                ticker, p.max_red, p.upclose_count
            ));
            write_trades(&file, &upclose_trades)?;
        }

        if !atr_trades.is_empty() {
            let file = Path::new(output_dir).join(format!(
                "{}_{}_Consec_RedCandle_ATR({},{})Exit.csv",
                ticker, p.max_red, p.atr_period, p.atr_factor
            ));
            write_trades(&file, &atr_trades)?;
        }
    }

    Ok(())
}

fn main() {
    let (input, output, fixed_max, max_red) = parse_args();
    let started = Instant::now();

    let rows = match parse_csv(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    if let Err(e) = run_backtest(rows, &output, fixed_max, max_red) {
        eprintln!("{e}");
        std::process::exit(1);
    }

    println!("rust_backtest_elapsed_ms={:.2}", started.elapsed().as_secs_f64() * 1000.0);
}
