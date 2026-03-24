const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { input: './Data/idx_data.csv', output: './Position/New_Consecutive_Red_Candle_Daily_JS', fixedMax: false, maxRed: 3 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) args.input = argv[++i];
    else if (a === '--output' && argv[i + 1]) args.output = argv[++i];
    else if (a === '--fixed-max') args.fixedMax = true;
    else if (a === '--max-red' && argv[i + 1]) args.maxRed = Number(argv[++i]);
  }
  return args;
}

function getParams(ticker, fixedMax, manualMax) {
  let maxRed;
  if (fixedMax) maxRed = manualMax;
  else if (ticker === 'NIFTY 50') maxRed = 7;
  else if (ticker === 'NIFTYBANK') maxRed = 5;
  else maxRed = 6;

  return {
    maxRed,
    upcloseCount: ticker !== 'NIFTY 50' ? 2 : 3,
    atrPeriod: 5,
    atrFactor: ticker !== 'NIFTYMIDCAP100' ? 2 : 4,
  };
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const lines = raw.split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    if (c.length < 6) continue;
    rows.push({
      Ticker: c[idx.Ticker],
      Date: c[idx.Date],
      Open: Number(c[idx.Open]),
      High: Number(c[idx.High]),
      Low: Number(c[idx.Low]),
      Close: Number(c[idx.Close]),
    });
  }
  return rows;
}

function dedupSort(rows) {
  rows.sort((a, b) => {
    if (a.Ticker < b.Ticker) return -1;
    if (a.Ticker > b.Ticker) return 1;
    if (a.Date < b.Date) return -1;
    if (a.Date > b.Date) return 1;
    return 0;
  });

  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (out.length === 0) {
      out.push(rows[i]);
      continue;
    }
    const p = out[out.length - 1];
    const r = rows[i];
    if (p.Ticker === r.Ticker && p.Date === r.Date) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}

function groupByTicker(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.Ticker)) m.set(r.Ticker, []);
    m.get(r.Ticker).push(r);
  }
  return m;
}

function consecutiveCounts(mask) {
  const out = new Int32Array(mask.length);
  let run = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) run += 1;
    else run = 0;
    out[i] = run;
  }
  return out;
}

function rollingMean(arr, period) {
  const out = new Float64Array(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    out[i] = i >= period - 1 ? sum / period : NaN;
  }
  return out;
}

function searchFirstGe(csum, target, startIdx) {
  let lo = startIdx;
  let hi = csum.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (csum[mid] >= target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toCsvValue(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  return String(v);
}

function writeTrades(filePath, trades) {
  const header = 'Ticker,Entry Date,Exit Date,Entry Price,Exit Price,% Chg\n';
  const body = trades
    .map((t) => [t.Ticker, t['Entry Date'], t['Exit Date'], t['Entry Price'], t['Exit Price'], t['% Chg']].map(toCsvValue).join(','))
    .join('\n');
  fs.writeFileSync(filePath, header + body + (body ? '\n' : ''), 'utf8');
}

function runBacktest(rows, outputDir, fixedMax, manualMaxRed) {
  fs.mkdirSync(outputDir, { recursive: true });
  const groups = groupByTicker(dedupSort(rows));

  for (const [ticker, g] of groups.entries()) {
    const p = getParams(ticker, fixedMax, manualMaxRed);
    const n = g.length;

    const dates = new Array(n);
    const open = new Float64Array(n);
    const high = new Float64Array(n);
    const low = new Float64Array(n);
    const close = new Float64Array(n);

    for (let i = 0; i < n; i += 1) {
      const r = g[i];
      dates[i] = r.Date;
      open[i] = r.Open;
      high[i] = r.High;
      low[i] = r.Low;
      close[i] = r.Close;
    }

    const redMask = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) redMask[i] = open[i] > close[i] ? 1 : 0;
    const consecRed = consecutiveCounts(redMask);

    const entryIdx = [];
    for (let i = 0; i < n; i += 1) if (consecRed[i] >= p.maxRed) entryIdx.push(i);
    if (entryIdx.length === 0) continue;

    const upclose = new Uint8Array(n);
    for (let i = 1; i < n; i += 1) upclose[i] = close[i] > close[i - 1] ? 1 : 0;

    const csum = new Int32Array(n);
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      s += upclose[i];
      csum[i] = s;
    }

    const hl = new Float64Array(n);
    const hpc = new Float64Array(n);
    const lpc = new Float64Array(n);
    const tr = new Float64Array(n);

    hl[0] = high[0] - low[0];
    hpc[0] = NaN;
    lpc[0] = NaN;
    tr[0] = hl[0];
    for (let i = 1; i < n; i += 1) {
      hl[i] = high[i] - low[i];
      hpc[i] = Math.abs(high[i] - close[i - 1]);
      lpc[i] = Math.abs(low[i] - close[i - 1]);
      tr[i] = Math.max(hl[i], hpc[i], lpc[i]);
    }

    const atr = rollingMean(tr, p.atrPeriod);
    const finalAtrPlot = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const avg = (high[i] + low[i]) / 2;
      finalAtrPlot[i] = Number.isNaN(atr[i]) ? NaN : avg - atr[i] * p.atrFactor;
    }

    const upcloseTrades = [];
    let lastExit = -1;
    for (const e of entryIdx) {
      if (e <= lastExit) continue;
      const target = csum[e] + p.upcloseCount;
      const x = searchFirstGe(csum, target, e);
      const entryPrice = round2(close[e]);

      if (x >= n) {
        upcloseTrades.push({
          Ticker: ticker,
          'Entry Date': dates[e],
          'Exit Date': '',
          'Entry Price': entryPrice,
          'Exit Price': '',
          '% Chg': '',
        });
        break;
      }

      const exitPrice = round2(close[x]);
      upcloseTrades.push({
        Ticker: ticker,
        'Entry Date': dates[e],
        'Exit Date': dates[x],
        'Entry Price': entryPrice,
        'Exit Price': exitPrice,
        '% Chg': round2((100 * (exitPrice - entryPrice)) / entryPrice),
      });
      lastExit = x;
    }

    const atrTrades = [];
    lastExit = -1;
    for (const e of entryIdx) {
      if (e <= lastExit || Number.isNaN(finalAtrPlot[e])) continue;

      let trailing = finalAtrPlot[e];
      let exitIdx = -1;
      for (let i = e + 1; i < n; i += 1) {
        if (close[i] < trailing) {
          exitIdx = i;
          break;
        }
        trailing = Math.max(trailing, finalAtrPlot[i]);
      }

      const entryPrice = round2(close[e]);
      if (exitIdx < 0) {
        atrTrades.push({
          Ticker: ticker,
          'Entry Date': dates[e],
          'Exit Date': '',
          'Entry Price': entryPrice,
          'Exit Price': '',
          '% Chg': '',
        });
        break;
      }

      const exitPrice = round2(close[exitIdx]);
      atrTrades.push({
        Ticker: ticker,
        'Entry Date': dates[e],
        'Exit Date': dates[exitIdx],
        'Entry Price': entryPrice,
        'Exit Price': exitPrice,
        '% Chg': round2((100 * (exitPrice - entryPrice)) / entryPrice),
      });
      lastExit = exitIdx;
    }

    if (upcloseTrades.length) {
      writeTrades(path.join(outputDir, `${ticker}_${p.maxRed}_Consec_RedCandle_${p.upcloseCount}_UpClose_Exit.csv`), upcloseTrades);
    }
    if (atrTrades.length) {
      writeTrades(path.join(outputDir, `${ticker}_${p.maxRed}_Consec_RedCandle_ATR(${p.atrPeriod},${p.atrFactor})Exit.csv`), atrTrades);
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const t0 = process.hrtime.bigint();
  const rows = parseCsv(args.input);
  runBacktest(rows, args.output, args.fixedMax, args.maxRed);
  const t1 = process.hrtime.bigint();
  const elapsedMs = Number(t1 - t0) / 1e6;
  console.log(`node_backtest_elapsed_ms=${elapsedMs.toFixed(2)}`);
}

main();
