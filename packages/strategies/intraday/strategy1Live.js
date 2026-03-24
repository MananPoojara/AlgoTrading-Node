const fs = require("fs");
const path = require("path");
const { logger } = require("../../core/logger/logger");
const { BaseStrategy } = require("../baseStrategy");
const { evaluateStrategy1 } = require("./strategy1Core");
const { resolveAtmOptionInstrument } = require("./atmOptionResolver");
const { formatIST } = require("../../core/utils/time");
const { query } = require("../../database/postgresClient");
const {
  buildSignalFingerprint,
} = require("../../core/utils/signalFingerprint");
const {
  normalizeRuntimeState,
} = require("../../../apps/strategy-engine/src/strategyRuntimeStore");

const DEFAULT_HISTORY_PATH = path.resolve(process.cwd(), "Data", "idx_data.csv");
const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const IST_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

class Strategy1Live extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: "STRATEGY1_LIVE",
      evaluationMode:
        config.evaluationMode || config.parameters?.evaluationMode || "1m_close",
      signalCooldown: config.signalCooldown ?? 60_000,
    });

    this.parameters = {
      quantity: 25,
      symbol: "NIFTY 50",
      candlePeriod: "1min",
      evaluationMode: "1m_close",
      fixedMax: true,
      maxRed: 3,
      historyPath: config.historyPath || DEFAULT_HISTORY_PATH,
      useHistoricalApi: false,
      ...config.parameters,
    };

    this.barHistory = [];
    this.currentBar = null;
    this.entryContext = null;
    this.pendingEntryContext = null;
    this.pendingExitContext = null;
    this.historyBootstrapSource = "none";
    this.lastEvaluation = null;
    this.lastEvaluatedBarTime = null;
    this.persistRuntimeState =
      config.persistRuntimeState || (async () => null);
    this.runtimeState = normalizeRuntimeState(config.runtimeState || {});
  }

  async onInit() {
    const bootstrap = await this.loadBootstrapBars();
    this.barHistory = bootstrap.bars;
    this.historyBootstrapSource = bootstrap.source;
    this.restoreRuntimeState(this.runtimeState);

    logger.info("Initialized STRATEGY1_LIVE", {
      instanceId: this.instanceId,
      symbol: this.parameters.symbol,
      historyBars: this.barHistory.length,
      historyPath: this.parameters.historyPath,
      historyBootstrapSource: this.historyBootstrapSource,
    });
  }

  async loadBootstrapBars() {
    const retainedBars = await this.loadRetainedBars();
    if (retainedBars.length > 0) {
      return {
        bars: retainedBars,
        source: "market_ohlc_1m",
      };
    }

    const bars = this.loadHistoricalBars(
      this.parameters.historyPath,
      this.parameters.symbol,
    );

    return {
      bars,
      source: bars.length > 0 ? "csv_fallback" : "none",
    };
  }

  async loadRetainedBars() {
    try {
      const result = await query(
        `SELECT candle_time, open, high, low, close
         FROM market_ohlc_1m
         WHERE symbol = $1
           AND trading_day = (
             SELECT MAX(trading_day)
             FROM market_ohlc_1m
             WHERE symbol = $1
           )
         ORDER BY candle_time ASC`,
        [this.parameters.symbol],
      );

      return result.rows
        .map((row) =>
          this.createBarRecord({
            timestamp: row.candle_time,
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
          }),
        )
        .filter(Boolean);
    } catch (error) {
      logger.warn("Failed to load retained Strategy1 bars", {
        instanceId: this.instanceId,
        symbol: this.parameters.symbol,
        error: error.message,
      });
      return [];
    }
  }

  loadHistoricalBars(historyPath, symbol) {
    if (!historyPath || !fs.existsSync(historyPath)) {
      logger.warn("Strategy1 history file not found", {
        instanceId: this.instanceId,
        historyPath,
      });
      return [];
    }

    const rawContent = fs.readFileSync(historyPath, "utf8").trim();
    if (!rawContent) {
      return [];
    }

    const [headerLine, ...lines] = rawContent.split(/\r?\n/);
    const headers = headerLine.split(",");
    const columnIndex = Object.fromEntries(
      headers.map((header, index) => [header, index]),
    );

    if (columnIndex.Time === undefined) {
      logger.warn("Strategy1 history file does not contain intraday Time column", {
        instanceId: this.instanceId,
        historyPath,
      });
      return [];
    }

    return lines
      .map((line) => line.split(","))
      .filter((columns) => columns.length >= 7)
      .filter((columns) => columns[columnIndex.Ticker] === symbol)
      .map((columns) =>
        this.createBarRecord({
          date: columns[columnIndex.Date],
          time: columns[columnIndex.Time],
          open: Number(columns[columnIndex.Open]),
          high: Number(columns[columnIndex.High]),
          low: Number(columns[columnIndex.Low]),
          close: Number(columns[columnIndex.Close]),
        }),
      )
      .filter(Boolean)
      .sort((left, right) => left.barTime.localeCompare(right.barTime));
  }

  async onMarketTick() {}

  async onTick(tick, candleUpdate = {}) {
    if (!tick || !tick.ltp || !candleUpdate.lastClosedCandle) {
      return null;
    }

    const lastClosedBar = this.createBarRecordFromStrategyCandle(
      candleUpdate.lastClosedCandle,
    );
    const currentBar = this.createBarRecordFromStrategyCandle(
      candleUpdate.currentCandle,
    );

    this.currentBar = currentBar;

    if (!lastClosedBar) {
      return null;
    }

    this.barHistory = this.upsertBar(this.barHistory, lastClosedBar);

    const bars = this.getEvaluationBars();
    const state = {
      inPosition: Boolean(this.entryContext),
      entryDate: this.entryContext?.entryDate || null,
      lastEvaluatedDate: this.lastEvaluatedBarTime,
      symbol: this.parameters.symbol,
    };
    const evaluation = evaluateStrategy1(bars, state, {
      ticker: this.parameters.symbol,
      fixedMax: this.parameters.fixedMax,
      maxRed: this.parameters.maxRed,
    });

    this.lastEvaluatedBarTime = lastClosedBar.barTime;

    // Keep trailingStop in entryContext so it survives a restart even if
    // bar history is temporarily incomplete on recovery.
    if (this.entryContext && evaluation.trailingStop != null) {
      this.entryContext = { ...this.entryContext, trailingStop: evaluation.trailingStop };
    }

    this.recordEvaluation(evaluation, tick, bars, state, lastClosedBar);
    await this.persistState();

    if (evaluation.action === "BUY") {
      if (this.pendingEntryContext) {
        return null;
      }

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
        Number(lastClosedBar.close),
        this.buildSignalMetadata({
          action: "BUY",
          instrument: optionContract.instrument,
          instrumentToken: optionContract.instrumentToken,
          lastClosedBar,
          referencePrice: Number(lastClosedBar.close),
          resolverSource: optionContract.source,
          instrumentResolutionStatus:
            optionContract.source === "database" ? "resolved" : "unresolved",
        }),
      );

      if (signal) {
        this.pendingEntryContext = {
          eventId: signal.event_id,
          entryDate: evaluation.entryDate,
          instrument: optionContract.instrument,
          instrumentToken: optionContract.instrumentToken,
          entryPrice: Number(lastClosedBar.close),
        };
        await this.persistState();
        return signal;
      }
    }

    if (evaluation.action === "SELL" && this.entryContext && !this.pendingExitContext) {
      const signal = this.emitSignal(
        "SELL",
        this.entryContext.instrument,
        Math.max(1, this.parameters.quantity || 25),
        "MARKET",
        Number(lastClosedBar.close),
        this.buildSignalMetadata({
          action: "SELL",
          instrument: this.entryContext.instrument,
          instrumentToken: this.entryContext.instrumentToken,
          lastClosedBar,
          referencePrice: Number(lastClosedBar.close),
          exitReason: evaluation.reason,
          instrumentResolutionStatus: "resolved",
        }),
      );

      if (signal) {
        this.pendingExitContext = {
          eventId: signal.event_id,
          instrument: this.entryContext.instrument,
          reason: evaluation.reason,
        };
        await this.persistState();
        return signal;
      }
    }

    return null;
  }

  createBarRecordFromStrategyCandle(candle) {
    if (!candle || candle.time === undefined || candle.time === null) {
      return null;
    }

    return this.createBarRecord({
      timestamp: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    });
  }

  createBarRecord({ timestamp, date, time, open, high, low, close }) {
    const barTime = timestamp
      ? this.formatIstBarTime(new Date(timestamp))
      : this.formatIstBarTimeFromParts(date, time);

    if (!barTime) {
      return null;
    }

    return {
      date: barTime.slice(0, 10),
      barTime,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
    };
  }

  formatIstBarTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    const tradeDate = IST_DATE_FORMATTER.format(date);
    const tradeTime = IST_TIME_FORMATTER.format(date);
    return `${tradeDate}T${tradeTime}+05:30`;
  }

  formatIstBarTimeFromParts(date, time) {
    if (!date || !time) {
      return null;
    }

    const normalizedTime = String(time).padStart(8, "0");
    return `${date}T${normalizedTime}+05:30`;
  }

  upsertBar(bars, nextBar) {
    const existingIndex = bars.findIndex((bar) => bar.barTime === nextBar.barTime);
    if (existingIndex >= 0) {
      return bars.map((bar, index) => (index === existingIndex ? nextBar : bar));
    }

    return [...bars, nextBar].sort((left, right) =>
      left.barTime.localeCompare(right.barTime),
    );
  }

  getEvaluationBars() {
    return [...this.barHistory];
  }

  recordEvaluation(evaluation, tick, bars, state, lastClosedBar) {
    const latestIndex = bars.length - 1;
    const indicators = evaluation.indicators || {};
    const redCounts = indicators.redCounts || [];
    const atrValues = indicators.atr || [];
    const snapshot = {
      timestamp: formatIST(tick.timestamp),
      symbol: this.parameters.symbol,
      action: evaluation.action || null,
      reason: evaluation.reason || "unknown",
      inPosition: Boolean(state.inPosition),
      entryDate: state.entryDate || null,
      tradeDate: lastClosedBar?.barTime || null,
      price: Number(lastClosedBar?.close ?? tick.ltp),
      evaluationTimeframe: "1m",
      historyBootstrapSource: this.historyBootstrapSource,
      historyBars: this.barHistory.length,
      currentBar: this.currentBar ? { ...this.currentBar } : null,
      lastCompletedBar: lastClosedBar ? { ...lastClosedBar } : null,
      redCount: redCounts[latestIndex] ?? null,
      maxRed: Number(this.parameters.maxRed ?? 3),
      atr: this.toRoundedNumber(atrValues[latestIndex]),
      trailingStop: this.toRoundedNumber(evaluation.trailingStop),
      referencePrice: this.toRoundedNumber(evaluation.referencePrice),
      lastClose: lastClosedBar ? this.toRoundedNumber(lastClosedBar.close) : null,
    };

    this.lastEvaluation = snapshot;
    logger.info(
      `Strategy1 evaluation action=${snapshot.action || "NONE"} reason=${snapshot.reason} symbol=${snapshot.symbol} tradeDate=${snapshot.tradeDate || "NA"} redCount=${snapshot.redCount ?? "NA"} atr=${snapshot.atr ?? "NA"} trailingStop=${snapshot.trailingStop ?? "NA"}`,
      {
        instanceId: this.instanceId,
        strategyId: this.strategyId,
        ...snapshot,
      },
    );
  }

  toRoundedNumber(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return null;
    }

    return Math.round(Number(value) * 100) / 100;
  }

  getDiagnostics() {
    return {
      instanceId: this.instanceId,
      strategyId: this.strategyId,
      symbol: this.parameters.symbol,
      evaluationTimeframe: "1m",
      historyBootstrapSource: this.historyBootstrapSource,
      historyBars: this.barHistory.length,
      currentBar: this.currentBar ? { ...this.currentBar } : null,
      entryContext: this.entryContext ? { ...this.entryContext } : null,
      pendingEntryContext: this.pendingEntryContext
        ? { ...this.pendingEntryContext }
        : null,
      pendingExitContext: this.pendingExitContext ? { ...this.pendingExitContext } : null,
      lastEvaluation: this.lastEvaluation ? { ...this.lastEvaluation } : null,
    };
  }

  restoreRuntimeState(runtimeState = {}) {
    const normalizedState = normalizeRuntimeState(runtimeState);
    this.lastEvaluatedBarTime = normalizedState.lastEvaluatedBarTime;
    this.entryContext = normalizedState.entryContext;
    this.pendingEntryContext = normalizedState.pendingEntryContext;
    this.pendingExitContext = normalizedState.pendingExitContext;
  }

  getRuntimeState() {
    return normalizeRuntimeState({
      lastEvaluatedBarTime: this.lastEvaluatedBarTime,
      lastSignalFingerprint: this.lastEvaluation?.signalFingerprint || null,
      entryContext: this.entryContext,
      pendingEntryContext: this.pendingEntryContext,
      pendingExitContext: this.pendingExitContext,
    });
  }

  async persistState() {
    try {
      await this.persistRuntimeState(this.instanceId, this.getRuntimeState());
    } catch (error) {
      logger.error("Failed to persist Strategy1 runtime state", {
        instanceId: this.instanceId,
        error: error.message,
      });
    }
  }

  buildSignalMetadata({
    action,
    instrument,
    instrumentToken,
    lastClosedBar,
    referencePrice,
    resolverSource = null,
    exitReason = null,
    instrumentResolutionStatus = "resolved",
  }) {
    const triggerBarTime =
      lastClosedBar?.barTime || this.lastEvaluatedBarTime || null;
    const signalFingerprint = buildSignalFingerprint({
      strategyInstanceId: this.instanceId,
      symbol: this.parameters.symbol,
      action,
      triggerBarTime,
    });

    if (this.lastEvaluation) {
      this.lastEvaluation = {
        ...this.lastEvaluation,
        signalFingerprint,
      };
    }

    return {
      instrument_token: instrumentToken || null,
      resolver_source: resolverSource,
      exit_reason: exitReason,
      trigger_bar_time: triggerBarTime,
      signal_fingerprint: signalFingerprint,
      instrument_resolution_status: instrumentResolutionStatus,
      metadata: {
        trigger_bar_time: triggerBarTime,
        signal_fingerprint: signalFingerprint,
        instrument_resolution_status: instrumentResolutionStatus,
        resolver_source: resolverSource,
        exit_reason: exitReason,
        reference_price: referencePrice,
        instrument,
      },
    };
  }

  handleExecutionUpdate(update = {}) {
    if (!update || update.strategy_instance_id !== this.instanceId) {
      return;
    }

    const eventId = update.event_id || null;
    const side = String(update.side || update.action || "").toUpperCase();
    const status = String(update.newState || update.status || "").toLowerCase();

    if (
      side === "BUY" &&
      this.pendingEntryContext &&
      this.pendingEntryContext.eventId === eventId
    ) {
      if (status === "filled") {
        this.entryContext = {
          entryDate: this.pendingEntryContext.entryDate,
          instrument: this.pendingEntryContext.instrument,
          instrumentToken: this.pendingEntryContext.instrumentToken,
          entryPrice: this.pendingEntryContext.entryPrice,
        };
        this.pendingEntryContext = null;
        void this.persistState();
        return;
      }

      if (["rejected", "cancelled", "failed"].includes(status)) {
        this.pendingEntryContext = null;
        void this.persistState();
        return;
      }
    }

    if (
      side === "SELL" &&
      this.pendingExitContext &&
      this.pendingExitContext.eventId === eventId
    ) {
      if (status === "filled") {
        this.pendingExitContext = null;
        this.entryContext = null;
        void this.persistState();
        return;
      }

      if (["rejected", "cancelled", "failed"].includes(status)) {
        this.pendingExitContext = null;
        void this.persistState();
      }
    }
  }

  async onStop() {
    await this.onSquareOff("manual_stop");
    this.pendingExitContext = null;
    this.pendingEntryContext = null;
    this.entryContext = null;
    await this.persistState();
  }

  async onSquareOff(reason = "intraday_square_off") {
    if (!this.entryContext || this.pendingExitContext) {
      return;
    }

    const signal = this.emitSignal(
      "SELL",
      this.entryContext.instrument,
      Math.max(1, this.parameters.quantity || 25),
      "MARKET",
      Number(this.lastTick?.ltp || this.entryContext.entryPrice || 0),
      this.buildSignalMetadata({
        action: "SELL",
        instrument: this.entryContext.instrument,
        instrumentToken: this.entryContext.instrumentToken,
        lastClosedBar: this.currentBar,
        referencePrice: Number(this.lastTick?.ltp || this.entryContext.entryPrice || 0),
        exitReason: reason,
        instrumentResolutionStatus: "resolved",
      }),
    );

    if (signal) {
      this.pendingExitContext = {
        eventId: signal.event_id,
        instrument: this.entryContext.instrument,
        reason,
      };
      await this.persistState();
    }
  }
}

Strategy1Live.description =
  "Intraday consecutive-red strategy using completed 1-minute candles and ATM CE paper signals";

module.exports = { Strategy1Live };
