const fs = require("fs");
const path = require("path");
const { logger } = require("../../core/logger/logger");
const { BaseStrategy } = require("../baseStrategy");
const { evaluateStrategy1 } = require("./strategy1Core");
const { resolveAtmOptionInstrument } = require("./atmOptionResolver");

const DEFAULT_HISTORY_PATH = path.resolve(process.cwd(), "Data", "idx_data.csv");
const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

class Strategy1Live extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: "STRATEGY1_LIVE",
      evaluationMode: config.evaluationMode || config.parameters?.evaluationMode || "1m_close",
      signalCooldown: config.signalCooldown ?? 60_000,
    });

    this.parameters = {
      quantity: 25,
      symbol: "NIFTY 50",
      candlePeriod: "1min",
      evaluationMode: "1m_close",
      historyPath: config.historyPath || DEFAULT_HISTORY_PATH,
      ...config.parameters,
    };

    this.dailyBars = [];
    this.currentDayBar = null;
    this.entryContext = null;
  }

  async onInit() {
    this.dailyBars = this.loadHistoricalBars(
      this.parameters.historyPath,
      this.parameters.symbol,
    );

    logger.info("Initialized STRATEGY1_LIVE", {
      instanceId: this.instanceId,
      symbol: this.parameters.symbol,
      historyBars: this.dailyBars.length,
      historyPath: this.parameters.historyPath,
    });
  }

  loadHistoricalBars(historyPath, symbol) {
    if (!historyPath || !fs.existsSync(historyPath)) {
      logger.warn("Strategy1 history file not found", {
        instanceId: this.instanceId,
        historyPath,
      });
      return [];
    }

    const content = fs.readFileSync(historyPath, "utf8").trim();
    const [headerLine, ...lines] = content.split(/\r?\n/);
    const headers = headerLine.split(",");
    const columnIndex = Object.fromEntries(
      headers.map((header, index) => [header, index]),
    );

    const sourceBars = lines
      .map((line) => line.split(","))
      .filter((columns) => columns.length >= 6)
      .filter((columns) => columns[columnIndex.Ticker] === symbol)
      .map((columns) => ({
        date: columns[columnIndex.Date],
        time: columnIndex.Time === undefined ? null : columns[columnIndex.Time],
        open: Number(columns[columnIndex.Open]),
        high: Number(columns[columnIndex.High]),
        low: Number(columns[columnIndex.Low]),
        close: Number(columns[columnIndex.Close]),
      }))
      .sort((left, right) => {
        const dateCompare = left.date.localeCompare(right.date);
        if (dateCompare !== 0) {
          return dateCompare;
        }

        return String(left.time || "").localeCompare(String(right.time || ""));
      });

    return this.aggregateBarsToDaily(sourceBars);
  }

  aggregateBarsToDaily(sourceBars) {
    const dailyBars = [];

    for (const bar of sourceBars) {
      const previousBar = dailyBars[dailyBars.length - 1];

      if (!previousBar || previousBar.date !== bar.date) {
        dailyBars.push({
          date: bar.date,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        });
        continue;
      }

      dailyBars[dailyBars.length - 1] = {
        ...previousBar,
        high: Math.max(previousBar.high, bar.high),
        low: Math.min(previousBar.low, bar.low),
        close: bar.close,
      };
    }

    return dailyBars;
  }

  async onMarketTick(tick) {
    this.updateCurrentDayBar(tick);
  }

  async onTick(tick) {
    if (!tick || !tick.ltp) {
      return null;
    }

    const bars = this.getEvaluationBars();
    const state = {
      inPosition: Boolean(this.entryContext),
      entryDate: this.entryContext?.entryDate || null,
      lastEvaluatedDate: this.currentDayBar?.date || null,
      symbol: this.parameters.symbol,
    };
    const evaluation = evaluateStrategy1(bars, state, {
      ticker: this.parameters.symbol,
      fixedMax: this.parameters.fixedMax,
      maxRed: this.parameters.maxRed,
    });

    if (evaluation.action === "BUY") {
      const optionContract = await resolveAtmOptionInstrument({
        symbol: this.parameters.symbol,
        spotPrice: tick.ltp,
        optionType: "CE",
      });
      const signal = this.emitSignal(
        "BUY",
        optionContract.instrument,
        Math.max(1, this.parameters.quantity || 25),
        "MARKET",
        Number(tick.ltp),
      );

      if (signal) {
        this.entryContext = {
          entryDate: evaluation.entryDate,
          instrument: optionContract.instrument,
          instrumentToken: optionContract.instrumentToken,
          entryPrice: Number(tick.ltp),
        };
        return {
          ...signal,
          instrument_token: optionContract.instrumentToken,
          resolver_source: optionContract.source,
        };
      }
    }

    if (evaluation.action === "SELL" && this.entryContext) {
      const signal = this.emitSignal(
        "SELL",
        this.entryContext.instrument,
        Math.max(1, this.parameters.quantity || 25),
        "MARKET",
        Number(tick.ltp),
      );

      if (signal) {
        const exitSignal = {
          ...signal,
          instrument_token: this.entryContext.instrumentToken,
          exit_reason: evaluation.reason,
        };
        this.entryContext = null;
        return exitSignal;
      }
    }

    return null;
  }

  updateCurrentDayBar(tick) {
    const tradeDate = IST_DATE_FORMATTER.format(new Date(tick.timestamp));
    const price = Number(tick.ltp);

    if (!this.currentDayBar || this.currentDayBar.date !== tradeDate) {
      if (this.currentDayBar && this.currentDayBar.date !== tradeDate) {
        this.commitCompletedDayBar(this.currentDayBar);
      }

      this.currentDayBar = {
        date: tradeDate,
        open: price,
        high: price,
        low: price,
        close: price,
      };
      return;
    }

    this.currentDayBar = {
      ...this.currentDayBar,
      high: Math.max(this.currentDayBar.high, price),
      low: Math.min(this.currentDayBar.low, price),
      close: price,
    };
  }

  commitCompletedDayBar(bar) {
    if (!bar?.date) {
      return;
    }

    const completedBar = { ...bar };
    const existingIndex = this.dailyBars.findIndex(
      (dailyBar) => dailyBar.date === completedBar.date,
    );

    if (existingIndex >= 0) {
      this.dailyBars = this.dailyBars.map((dailyBar, index) =>
        index === existingIndex ? completedBar : dailyBar,
      );
      return;
    }

    this.dailyBars = [...this.dailyBars, completedBar].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
  }

  getEvaluationBars() {
    if (!this.currentDayBar) {
      return [...this.dailyBars];
    }

    const completedBars = this.dailyBars.filter(
      (bar) => bar.date !== this.currentDayBar.date,
    );
    return [...completedBars, this.currentDayBar];
  }

  async onStop() {
    if (!this.entryContext) {
      return;
    }

    this.emitSignal(
      "SELL",
      this.entryContext.instrument,
      Math.max(1, this.parameters.quantity || 25),
      "MARKET",
      Number(this.lastTick?.ltp || this.entryContext.entryPrice || 0),
    );
    this.entryContext = null;
  }
}

Strategy1Live.description =
  "Intraday proxy for the daily consecutive-red strategy using ATM CE paper signals";

module.exports = { Strategy1Live };
