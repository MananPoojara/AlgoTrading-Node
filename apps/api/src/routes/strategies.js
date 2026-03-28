const express = require("express");
const { query } = require("../../../../packages/database/postgresClient");
const { logger } = require("../../../../packages/core/logger/logger");
const { sanitizeError, handleApiError } = require("../utils/errorHandler");
const {
  getWorkerManager,
} = require("../../../strategy-engine/src/workerManager");
const {
  normalizeRuntimeState,
} = require("../../../strategy-engine/src/strategyRuntimeStore");
const config = require("../../../../config/default");
const {
  formatIST,
  getTodayIST,
  getISTParts,
} = require("../../../../packages/core/utils/time");
const {
  buildRecordedSessionBreakdown,
  buildStrategy1ReplayPerformance,
  buildStrategy1VwapGateSummary,
  compareStrategy1Session,
  inspectCandleContinuity,
  isValidationWindowOpen,
  replayStrategy1DailyFromMinuteHistory,
  replayStrategy1DailyHistory,
  replayStrategy1Session,
  toBarTime,
  toDailyBarTime,
} = require("../../../../packages/strategies/intraday/strategy1Validation");
const {
  aggregateStrategy1Bars,
  calculateSessionVwapSeries,
  normalizeStrategy1Timeframe,
} = require("../../../../packages/strategies/intraday/strategy1Timeframe");

const router = express.Router();

function deriveStrategyKey(row) {
  if (row.file_path) {
    const normalizedPath = row.file_path.replace(/\\/g, "/");
    const pathParts = normalizedPath.split("/");
    const fileName = pathParts[pathParts.length - 1].replace(/\.js$/i, "");
    const category =
      pathParts.length > 1 ? pathParts[pathParts.length - 2] : row.type;
    return `${category}_${fileName}`.toUpperCase();
  }

  return `${row.type || "strategy"}_${(row.name || "unknown")
    .replace(/\s+/g, "_")
    .toUpperCase()}`;
}

const SYMBOL_ALIASES = {
  NIFTY: ["NIFTY", "NIFTY 50", "NIFTY50"],
  "NIFTY 50": ["NIFTY 50", "NIFTY", "NIFTY50"],
  BANKNIFTY: ["BANKNIFTY", "NIFTYBANK", "BANK NIFTY"],
  NIFTYBANK: ["NIFTYBANK", "BANKNIFTY", "BANK NIFTY"],
};

function normalizeSymbolCandidates(symbol) {
  const normalized = String(symbol || "")
    .trim()
    .toUpperCase();
  const aliases = SYMBOL_ALIASES[normalized];
  return aliases
    ? aliases.map((entry) => entry.toUpperCase())
    : [normalized].filter(Boolean);
}

function toValidationCandle(row, tradeDate) {
  const barTime = toBarTime(row.barTime || row.candle_time);
  if (!barTime) {
    return null;
  }

  return {
    time: barTime,
    barTime,
    date: String(tradeDate),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume || 0),
    instrument_token: row.instrument_token || null,
    symbol: row.symbol || null,
  };
}

async function loadRetainedValidationCandles(tradeDate, symbolCandidates) {
  const candleResult = await query(
    `SELECT candle_time, open, high, low, close, volume, instrument_token, symbol
     FROM market_ohlc_1m
     WHERE trading_day = $1::date
       AND UPPER(symbol) = ANY($2::text[])
     ORDER BY candle_time ASC`,
    [tradeDate, symbolCandidates],
  );

  return candleResult.rows
    .map((row) => toValidationCandle(row, tradeDate))
    .filter(Boolean);
}

async function loadHistoricalValidationCandles(tradeDate, symbol) {
  const {
    AngelHistoricalDataClient,
  } = require("../../../market-data-service/src/angelHistoricalDataClient");
  const historicalClient = new AngelHistoricalDataClient();
  const bars = await historicalClient.fetchIntradayBarsForSymbol({
    symbol,
    tradeDate,
    sessionStart: config.marketHours.open,
    sessionEnd: config.marketHours.close,
  });

  return bars.map((row) => toValidationCandle(row, tradeDate)).filter(Boolean);
}

async function loadValidationCandles({ tradeDate, symbol, symbolCandidates }) {
  const retainedCandles = await loadRetainedValidationCandles(
    tradeDate,
    symbolCandidates,
  );
  let selectedCandles = retainedCandles;
  let selectedSource = "market_ohlc_1m";
  let historicalCandles = [];
  let sourceWarning = null;

  try {
    historicalCandles = await loadHistoricalValidationCandles(
      tradeDate,
      symbol,
    );
    if (historicalCandles.length > 0) {
      selectedCandles = historicalCandles;
      selectedSource = "angel_historical";
    } else if (retainedCandles.length === 0) {
      sourceWarning =
        "Angel historical API returned no candles for the selected day";
    }
  } catch (error) {
    sourceWarning = error.message;
    logger.warn(
      "Historical validation candle fetch failed; using retained feed candles",
      {
        symbol,
        tradeDate,
        error: error.message,
      },
    );
  }

  return {
    candles: selectedCandles,
    source: {
      selected: selectedSource,
      retained_count: retainedCandles.length,
      historical_count: historicalCandles.length,
      retained_audit: inspectCandleContinuity(retainedCandles),
      historical_audit: inspectCandleContinuity(historicalCandles),
      warning: sourceWarning,
    },
  };
}

function toDailyValidationCandle(row, symbol = null) {
  const tradeDate = String(
    row.date || row.trading_day || row.barTime || row.candle_time || "",
  ).slice(0, 10);
  const barTime = toDailyBarTime(tradeDate);
  if (!tradeDate || !barTime) {
    return null;
  }

  return {
    time: barTime,
    barTime,
    date: tradeDate,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume || 0),
    symbol: row.symbol || symbol || null,
  };
}

async function loadHistoricalDailyValidationCandles({ symbol, lookbackDays }) {
  const {
    AngelHistoricalDataClient,
  } = require("../../../market-data-service/src/angelHistoricalDataClient");
  const historicalClient = new AngelHistoricalDataClient();
  const bars = await historicalClient.fetchDailyBarsForSymbol({
    symbol,
    lookbackDays,
  });

  return bars
    .map((row) => toDailyValidationCandle(row, symbol))
    .filter(Boolean);
}

async function loadRetainedDailyValidationCandles({
  fromDate,
  toDateExclusive,
  symbolCandidates,
}) {
  const candleResult = await query(
    `SELECT trading_day, candle_time, open, high, low, close, volume, symbol
     FROM market_ohlc_1m
     WHERE trading_day >= $1::date
       AND trading_day < $2::date
       AND UPPER(symbol) = ANY($3::text[])
     ORDER BY candle_time ASC`,
    [fromDate, toDateExclusive, symbolCandidates],
  );

  const minuteCandles = candleResult.rows
    .map((row) => toValidationCandle(row, row.trading_day))
    .filter(Boolean);

  return aggregateStrategy1Bars(minuteCandles, "1day")
    .map((bar) =>
      toDailyValidationCandle(bar, bar.symbol || symbolCandidates[0] || null),
    )
    .filter(Boolean);
}

function selectCompletedTradingBars(
  candles = [],
  completedBars = 30,
  today = getTodayIST(),
) {
  return [...candles]
    .filter((bar) => bar?.date && String(bar.date) < today)
    .sort((left, right) =>
      String(left.barTime).localeCompare(String(right.barTime)),
    )
    .slice(-completedBars);
}

async function loadMonthlyDailyValidationCandles({
  symbol,
  symbolCandidates,
  completedBars = 30,
}) {
  const calendarLookback = Math.max(60, completedBars * 2 + 10);
  const today = getTodayIST();
  const fromDate = new Date(`${today}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - calendarLookback);
  const fromDateValue = fromDate.toISOString().slice(0, 10);

  const retainedDailyCandles = selectCompletedTradingBars(
    await loadRetainedDailyValidationCandles({
      fromDate: fromDateValue,
      toDateExclusive: today,
      symbolCandidates,
    }),
    completedBars,
    today,
  );

  let selectedCandles = retainedDailyCandles;
  let selectedSource = "market_ohlc_1m_daily";
  let historicalDailyCandles = [];
  let sourceWarning = null;

  try {
    historicalDailyCandles = selectCompletedTradingBars(
      await loadHistoricalDailyValidationCandles({
        symbol,
        lookbackDays: calendarLookback,
      }),
      completedBars,
      today,
    );

    const historicalCompleteEnough =
      historicalDailyCandles.length >= Math.min(completedBars, 20);
    const retainedPreferred =
      retainedDailyCandles.length > historicalDailyCandles.length;

    if (historicalCompleteEnough && !retainedPreferred) {
      selectedCandles = historicalDailyCandles;
      selectedSource = "angel_historical_daily";
    } else if (retainedDailyCandles.length > 0) {
      selectedCandles = retainedDailyCandles;
      selectedSource = "market_ohlc_1m_daily";
      if (historicalDailyCandles.length > 0) {
        sourceWarning = "Angel daily history returned " + historicalDailyCandles.length + " completed bars; using retained daily aggregation with " + retainedDailyCandles.length + " bars instead";
      }
    } else if (historicalDailyCandles.length > 0) {
      selectedCandles = historicalDailyCandles;
      selectedSource = "angel_historical_daily";
      sourceWarning = "Angel daily history returned only " + historicalDailyCandles.length + " completed bars";
    } else {
      sourceWarning =
        "Angel historical API returned no completed daily bars for the selected range";
    }
  } catch (error) {
    sourceWarning = error.message;
    logger.warn(
      "Historical daily validation fetch failed; using retained daily bars",
      {
        symbol,
        completedBars,
        error: error.message,
      },
    );
  }

  return {
    candles: selectedCandles,
    source: {
      selected: selectedSource,
      retained_count: retainedDailyCandles.length,
      historical_count: historicalDailyCandles.length,
      warning: sourceWarning,
    },
    window: {
      lookback_trading_days: completedBars,
      excludes_today: true,
      first_bar_date: selectedCandles[0]?.date || null,
      last_bar_date: selectedCandles[selectedCandles.length - 1]?.date || null,
    },
  };
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}


function buildLogicalBarAnchor(timeframe = "1day", barTime = toBarTime(new Date())) {
  const normalizedTimeframe = normalizeStrategy1Timeframe(timeframe);
  const normalizedBarTime = String(barTime || toBarTime(new Date()) || "");
  const tradeDate = normalizedBarTime.slice(0, 10);
  const hour = Number(normalizedBarTime.slice(11, 13));
  const minute = Number(normalizedBarTime.slice(14, 16));

  if (!tradeDate || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }

  if (normalizedTimeframe === "1day") {
    return `${tradeDate}T09:15:00+05:30`;
  }

  if (normalizedTimeframe === "5min") {
    const bucketMinute = Math.floor(minute / 5) * 5;
    return `${tradeDate}T${String(hour).padStart(2, "0")}:${String(bucketMinute).padStart(2, "0")}:00+05:30`;
  }

  if (normalizedTimeframe === "15min") {
    const bucketMinute = Math.floor(minute / 15) * 15;
    return `${tradeDate}T${String(hour).padStart(2, "0")}:${String(bucketMinute).padStart(2, "0")}:00+05:30`;
  }

  return `${tradeDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`;
}

function buildDefaultOperator(req) {
  const username =
    req.body?.operator_username ||
    req.user?.username ||
    (req.user?.clientId ? `client_${req.user.clientId}` : null);

  return {
    id: req.user?.clientId || null,
    username,
  };
}

async function loadManualPositionCorrections(instanceId, tradeDate = null) {
  const params = [instanceId];
  let dateClause = "";

  if (tradeDate) {
    params.push(tradeDate);
    dateClause =
      " AND (timestamp AT TIME ZONE 'Asia/Kolkata')::date = $2::date";
  }

  const result = await query(
    `SELECT *
     FROM operator_audit_log
     WHERE action = 'strategy_manual_position_correction'
       AND target_type = 'strategy_instance'
       AND target_id = $1${dateClause}
     ORDER BY timestamp DESC`,
    params,
  );

  return result.rows.map((row) => ({
    ...row,
    metadata: row.metadata || {},
  }));
}

async function loadPositionMismatchForInstance(instance) {
  const runtimeState = normalizeRuntimeState(instance.runtime_state || {});
  const positionResult = await query(
    `SELECT *
     FROM positions
     WHERE strategy_instance_id = $1
       AND quantity <> 0
     ORDER BY updated_at DESC NULLS LAST, id DESC`,
    [instance.id],
  );
  const orderResult = await query(
    `SELECT id, event_id, side, status, instrument, quantity, average_fill_price, average_price, price, updated_at
     FROM orders
     WHERE strategy_instance_id = $1
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 10`,
    [instance.id],
  );

  const activePositions = positionResult.rows || [];
  const activePosition = activePositions[0] || null;
  const runtimeInPosition = Boolean(runtimeState.entryContext);
  const databaseInPosition = Boolean(
    activePosition && Number(activePosition.quantity || 0) > 0,
  );
  const reasons = [];

  if (activePositions.length > 1) {
    reasons.push("multiple_active_positions");
  }
  if (runtimeInPosition !== databaseInPosition) {
    reasons.push("runtime_database_position_presence_mismatch");
  }
  if (
    runtimeInPosition &&
    databaseInPosition &&
    runtimeState.entryContext?.instrument &&
    activePosition?.instrument &&
    runtimeState.entryContext.instrument !== activePosition.instrument
  ) {
    reasons.push("runtime_database_instrument_mismatch");
  }
  if (runtimeState.pendingEntryContext && databaseInPosition) {
    reasons.push("pending_entry_while_database_position_open");
  }
  if (runtimeState.pendingExitContext && !databaseInPosition && !runtimeInPosition) {
    reasons.push("pending_exit_without_open_position");
  }

  return {
    has_mismatch: reasons.length > 0,
    reasons,
    runtime_state: runtimeState,
    active_position: activePosition,
    active_positions: activePositions,
    recent_orders: orderResult.rows || [],
  };
}

async function syncRunningStrategyRuntimeState(instanceId, runtimeState) {
  const manager = getWorkerManager();
  const workerId = manager.strategyToWorker.get(Number(instanceId));
  if (!workerId) {
    return false;
  }

  const worker = manager.getWorker(workerId);
  if (!worker || typeof worker.restoreState !== "function") {
    return false;
  }

  await worker.restoreState(Number(instanceId), runtimeState);
  return true;
}

function summarizeMinuteValidationDay({ tradeDate, candles = [], source = {} }) {
  const audit = inspectCandleContinuity(candles);
  const totalVolume = candles.reduce(
    (sum, candle) => sum + Number(candle.volume || 0),
    0,
  );
  const vwapAvailable = calculateSessionVwapSeries(candles).length > 0;

  return {
    trade_date: tradeDate,
    selected: source.selected,
    count: candles.length,
    gap_count: audit.gapCount || 0,
    missing_minutes: audit.totalMissingMinutes || 0,
    total_volume: totalVolume,
    vwap_available: vwapAvailable,
    warning:
      source.warning ||
      (candles.length === 0
        ? `No minute candles found for ${tradeDate}`
        : totalVolume <= 0
          ? `No positive-volume minute candles found for ${tradeDate}`
          : null),
  };
}

async function loadMonthlyMinuteValidationDataset({
  symbol,
  symbolCandidates,
  completedBars = 30,
}) {
  const dailyBaseline = await loadMonthlyDailyValidationCandles({
    symbol,
    symbolCandidates,
    completedBars,
  });

  const tradeDates = Array.from(
    new Set(
      [
        ...(dailyBaseline.historical_candles || []),
        ...(dailyBaseline.retained_candles || []),
        ...(dailyBaseline.candles || []),
      ]
        .map((candle) => candle?.date)
        .filter(Boolean),
    ),
  )
    .sort((left, right) => String(left).localeCompare(String(right)))
    .slice(-completedBars);
  const allMinuteCandles = [];
  const perDaySources = [];

  for (const tradeDate of tradeDates) {
    const { candles, source } = await loadValidationCandles({
      tradeDate,
      symbol,
      symbolCandidates,
    });

    if (candles.length > 0) {
      allMinuteCandles.push(...candles);
    }

    perDaySources.push(
      summarizeMinuteValidationDay({
        tradeDate,
        candles,
        source,
      }),
    );
  }

  const aggregatedDailyCandles = aggregateStrategy1Bars(allMinuteCandles, "1day")
    .map((bar) => toDailyValidationCandle(bar, bar.symbol || symbol))
    .filter(Boolean)
    .filter((bar) => tradeDates.includes(bar.date));

  const historicalDays = perDaySources.filter(
    (entry) => entry.selected === "angel_historical" && entry.count > 0,
  ).length;
  const retainedDays = perDaySources.filter(
    (entry) => entry.selected === "market_ohlc_1m" && entry.count > 0,
  ).length;
  const warnings = perDaySources
    .map((entry) => entry.warning)
    .filter(Boolean);
  const daysWithMissingCandles = perDaySources
    .filter((entry) => entry.count === 0)
    .map((entry) => entry.trade_date);
  const daysWithMissingVolume = perDaySources
    .filter((entry) => entry.count > 0 && !entry.vwap_available)
    .map((entry) => entry.trade_date);
  const vwapAvailableDays = perDaySources
    .filter((entry) => entry.vwap_available)
    .map((entry) => entry.trade_date);
  const sourceQuality =
    perDaySources.length === 0 || perDaySources.every((entry) => entry.count === 0)
      ? "empty"
      : daysWithMissingCandles.length > 0 || daysWithMissingVolume.length > 0
        ? "partial"
        : "complete";

  return {
    candles: aggregatedDailyCandles,
    minuteCandles: allMinuteCandles,
    source: {
      ...dailyBaseline.source,
      selected: historicalDays >= retainedDays ? "angel_historical_intraday" : "market_ohlc_1m_intraday",
      daily_source: dailyBaseline.source.selected,
      minute_days_requested: tradeDates.length,
      minute_days_loaded: perDaySources.filter((entry) => entry.count > 0).length,
      minute_days_historical: historicalDays,
      minute_days_retained: retainedDays,
      source_quality: sourceQuality,
      days_with_missing_candles: daysWithMissingCandles,
      days_with_missing_volume: daysWithMissingVolume,
      vwap_available_days: vwapAvailableDays,
      per_day: perDaySources,
      warning: warnings[0] || dailyBaseline.source.warning || null,
      warnings,
    },
    window: {
      ...dailyBaseline.window,
      first_bar_date: tradeDates[0] || null,
      last_bar_date: tradeDates[tradeDates.length - 1] || null,
      replay_source: "minute_history",
    },
  };
}

async function applyManualPositionCorrection(instance, req) {
  const correctedQuantity = Math.max(0, Math.trunc(Number(req.body?.corrected_quantity ?? 0)));
  const correctedAveragePrice = Number(req.body?.corrected_average_price ?? 0);
  const reason = String(req.body?.reason || "").trim();
  const note = String(req.body?.note || "").trim() || null;
  const operator = buildDefaultOperator(req);
  const timeframe = normalizeStrategy1Timeframe(instance.parameters?.timeframe);
  const symbol =
    String(req.body?.symbol || instance.parameters?.symbol || "NIFTY 50").trim() ||
    "NIFTY 50";

  const existingPositionResult = await query(
    `SELECT *
     FROM positions
     WHERE strategy_instance_id = $1
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [instance.id],
  );
  const existingPosition = existingPositionResult.rows[0] || null;
  const instrument =
    String(req.body?.instrument || existingPosition?.instrument || "").trim() || null;

  if (!instrument) {
    return {
      status: 400,
      body: {
        success: false,
        error: "instrument is required for manual position correction",
      },
    };
  }

  if (!reason) {
    return {
      status: 400,
      body: {
        success: false,
        error: "reason is required for manual position correction",
      },
    };
  }

  if (!Number.isFinite(correctedAveragePrice) || correctedAveragePrice < 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: "corrected_average_price must be a valid non-negative number",
      },
    };
  }

  const currentQuantity = Number(existingPosition?.quantity || 0);
  const currentAveragePrice = Number(existingPosition?.avg_entry_price || 0);
  const auditResult = await query(
    `INSERT INTO operator_audit_log (
       operator_id, operator_username, action, target_type, target_id, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      operator.id,
      operator.username,
      "strategy_manual_position_correction",
      "strategy_instance",
      instance.id,
      JSON.stringify({
        instrument,
        symbol,
        corrected_quantity: correctedQuantity,
        corrected_average_price: correctedAveragePrice,
        previous_quantity: currentQuantity,
        previous_average_price: currentAveragePrice,
        reason,
        note,
        mode: config.paperMode ? "paper" : "live",
      }),
    ],
  );
  const correctionRecord = auditResult.rows[0];

  const tradeQuantity = Math.max(
    Math.abs(correctedQuantity - currentQuantity),
    correctedQuantity,
    currentQuantity,
  );
  const tradeSide = correctedQuantity >= currentQuantity ? "BUY" : "SELL";
  let manualTrade = null;

  if (tradeQuantity > 0) {
    const tradeResult = await query(
      `INSERT INTO trades (
         order_id, client_id, symbol, instrument, side, quantity, price, broker_trade_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        null,
        instance.client_id,
        symbol,
        instrument,
        tradeSide,
        tradeQuantity,
        correctedAveragePrice,
        `MANUAL_CORRECTION:${correctionRecord.id}`,
      ],
    );
    manualTrade = tradeResult.rows[0] || null;
  }

  await query(
    `INSERT INTO positions (
       client_id, strategy_instance_id, symbol, instrument, quantity,
       avg_entry_price, current_price, unrealized_pnl, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NOW())
     ON CONFLICT (client_id, symbol, instrument, strategy_instance_id)
     DO UPDATE SET
       quantity = EXCLUDED.quantity,
       avg_entry_price = EXCLUDED.avg_entry_price,
       current_price = EXCLUDED.current_price,
       unrealized_pnl = EXCLUDED.unrealized_pnl,
       updated_at = NOW()`,
    [
      instance.client_id,
      instance.id,
      symbol,
      instrument,
      correctedQuantity,
      correctedAveragePrice,
      correctedAveragePrice,
    ],
  );

  const logicalAnchor =
    buildLogicalBarAnchor(timeframe, toBarTime(new Date())) ||
    normalizeRuntimeState(instance.runtime_state || {}).lastEvaluatedBarTime ||
    null;
  const nextRuntimeState = normalizeRuntimeState(instance.runtime_state || {});
  nextRuntimeState.lastEvaluatedBarTime = logicalAnchor;
  nextRuntimeState.pendingEntryContext = null;
  nextRuntimeState.pendingExitContext = null;
  nextRuntimeState.entryContext =
    correctedQuantity > 0
      ? {
          entryDate:
            nextRuntimeState.entryContext?.entryDate || logicalAnchor,
          instrument,
          instrumentToken: nextRuntimeState.entryContext?.instrumentToken || null,
          entryPrice: correctedAveragePrice,
          trailingStop: nextRuntimeState.entryContext?.trailingStop || null,
        }
      : null;

  await query(
    `UPDATE strategy_instances
     SET runtime_state = $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [instance.id, JSON.stringify(nextRuntimeState)],
  );

  await syncRunningStrategyRuntimeState(instance.id, nextRuntimeState);

  return {
    status: 201,
    body: {
      success: true,
      data: {
        correction: correctionRecord,
        manual_trade: manualTrade,
        runtime_state: nextRuntimeState,
        position: {
          symbol,
          instrument,
          quantity: correctedQuantity,
          avg_entry_price: correctedAveragePrice,
        },
      },
    },
  };
}

async function loadSignalOperatorActivity(tradeDate, signalIds = []) {
  const normalizedIds = (signalIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));

  if (normalizedIds.length === 0) {
    return [];
  }

  const result = await query(
    `SELECT *
     FROM operator_audit_log
     WHERE target_type = 'signal'
       AND target_id = ANY($1::int[])
       AND (timestamp AT TIME ZONE 'Asia/Kolkata')::date = $2::date
     ORDER BY timestamp ASC`,
    [normalizedIds, tradeDate],
  );

  return result.rows;
}


async function loadDashboardCandles(symbol, limit = 180) {
  const candidates = normalizeSymbolCandidates(symbol);
  const maxRows = Math.min(Math.max(parseInt(limit, 10) || 180, 60), 360);
  const instrumentResult = await query(
    `SELECT instrument_token, symbol
     FROM instruments
     WHERE (
       UPPER(symbol) = ANY($1::text[])
       OR UPPER(COALESCE(underlying_symbol, '')) = ANY($1::text[])
     )
       AND COALESCE(instrument_type, 'INDEX') = 'INDEX'
     ORDER BY CASE WHEN UPPER(symbol) = $2 THEN 0 ELSE 1 END, instrument_token
     LIMIT 1`,
    [candidates, candidates[0] || String(symbol).toUpperCase()],
  );

  if (instrumentResult.rows.length === 0) {
    return {
      symbol,
      instrumentToken: null,
      candles: [],
      source: 'market_ohlc_1m',
    };
  }

  const instrument = instrumentResult.rows[0];
  const result = await query(
    `SELECT candle_time AS time, open, high, low, close, volume
     FROM market_ohlc_1m
     WHERE instrument_token = $1
     ORDER BY candle_time DESC
     LIMIT $2`,
    [instrument.instrument_token, maxRows],
  );

  const candles = result.rows
    .slice()
    .reverse()
    .map((row) => ({
      time: toBarTime(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0),
    }))
    .filter((row) => row.time);

  return {
    symbol: instrument.symbol,
    instrumentToken: instrument.instrument_token,
    candles,
    source: 'market_ohlc_1m',
  };
}

function buildDashboardMarkers({
  strategySignals = [],
  strategyOrders = [],
  manualOverrides = [],
  manualCorrections = [],
} = {}) {
  return [
    ...strategySignals.map((signal) => ({
      timestamp: signal.trigger_bar_time || signal.timestamp,
      action: signal.action,
      price: signal.price,
      kind: 'signal',
      label: signal.reason || null,
    })),
    ...strategyOrders.map((order) => ({
      timestamp: order.created_at,
      action: order.side,
      price: order.average_fill_price || order.average_price || order.price,
      kind: 'strategy_order',
      label: order.status || null,
    })),
    ...manualOverrides.map((override) => ({
      timestamp: override.timestamp,
      action: override.action,
      price: override.price,
      kind: 'manual_override',
      label: override.reason || null,
    })),
    ...manualCorrections.map((correction) => ({
      timestamp: correction.timestamp,
      action:
        Number(correction.metadata?.corrected_quantity || 0) >=
        Number(correction.metadata?.previous_quantity || 0)
          ? 'BUY'
          : 'SELL',
      price: correction.metadata?.corrected_average_price,
      kind: 'manual_correction',
      label: correction.metadata?.reason || 'Manual correction',
    })),
  ];
}

function buildTrailingStopSeries(candles = [], trailingStop = null) {
  if (!Number.isFinite(Number(trailingStop)) || (candles || []).length === 0) {
    return [];
  }

  return candles.map((candle) => ({
    time: candle.time,
    value: Number(trailingStop),
  }));
}

router.get("/", async (req, res) => {
  try {
    const { type, limit = 50, offset = 0 } = req.query;

    let sql = "SELECT * FROM strategies";
    const params = [];
    let paramIndex = 1;

    if (type) {
      sql += ` WHERE type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    sql += ` ORDER BY name LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);

    res.json({
      success: true,
      data: result.rows,
      meta: {
        count: result.rows.length,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    logger.error("Failed to fetch strategies", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/start", async (req, res) => {
  try {
    const { instance_id } = req.body;
    if (!instance_id) {
      return res.status(400).json({
        success: false,
        error: "instance_id is required",
      });
    }

    const result = await query(
      `SELECT
         si.id as instance_id,
         si.client_id,
         si.strategy_id,
         si.parameters,
         s.name as strategy_name,
         s.type as strategy_type,
         s.file_path
       FROM strategy_instances si
       JOIN strategies s ON s.id = si.strategy_id
       WHERE si.id = $1`,
      [instance_id],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    const row = result.rows[0];
    const manager = getWorkerManager();
    await manager.initialize();

    const strategyKey = deriveStrategyKey(row);
    await manager.startStrategy(row.instance_id, {
      strategyKey,
      clientId: row.client_id,
      strategyId: row.strategy_id,
      parameters: row.parameters || {},
      group: row.strategy_type || "default",
    });

    const workerId = manager.strategyToWorker.get(row.instance_id) || null;
    await query(
      `UPDATE strategy_instances
       SET status = 'running', worker_id = $1, started_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [workerId, row.instance_id],
    );

    return res.json({
      success: true,
      data: {
        instance_id: row.instance_id,
        worker_id: workerId,
        strategy_key: strategyKey,
        status: "running",
      },
    });
  } catch (error) {
    logger.error("Failed to start strategy", { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/stop", async (req, res) => {
  try {
    const { instance_id } = req.body;
    if (!instance_id) {
      return res.status(400).json({
        success: false,
        error: "instance_id is required",
      });
    }

    const manager = getWorkerManager();
    await manager.stopStrategy(instance_id);
    await query(
      `UPDATE strategy_instances
       SET status = 'stopped', worker_id = NULL, stopped_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [instance_id],
    );

    return res.json({
      success: true,
      data: {
        instance_id,
        status: "stopped",
      },
    });
  } catch (error) {
    logger.error("Failed to stop strategy", { error: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/:id(\\d+)", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query("SELECT * FROM strategies WHERE id = $1", [id]);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy not found" });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to fetch strategy", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/instances", async (req, res) => {
  try {
    const { client_id, status, limit = 50, offset = 0 } = req.query;

    let sql = `
      SELECT si.*, s.name as strategy_name, s.type as strategy_type, c.name as client_name, c.risk_limits
      FROM strategy_instances si
      JOIN strategies s ON si.strategy_id = s.id
      JOIN clients c ON si.client_id = c.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (client_id) {
      sql += ` AND si.client_id = $${paramIndex}`;
      params.push(client_id);
      paramIndex++;
    }

    if (status) {
      sql += ` AND si.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    sql += ` ORDER BY si.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);

    res.json({
      success: true,
      data: result.rows,
      meta: {
        count: result.rows.length,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    logger.error("Failed to fetch strategy instances", {
      error: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/instances/:id/dashboard-surface", async (req, res) => {
  try {
    const { id } = req.params;
    const instanceResult = await query(
      `SELECT si.*, s.name as strategy_name, s.type as strategy_type, s.parameters as strategy_parameters, c.risk_limits, c.name as client_name
       FROM strategy_instances si
       JOIN strategies s ON si.strategy_id = s.id
       JOIN clients c ON c.id = si.client_id
       WHERE si.id = $1`,
      [id],
    );

    if (instanceResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    const instance = instanceResult.rows[0];
    const symbol =
      instance.parameters?.symbol ||
      instance.strategy_parameters?.symbol ||
      "NIFTY 50";
    const timeframe = normalizeStrategy1Timeframe(instance.parameters?.timeframe);
    const runtimeState = normalizeRuntimeState(instance.runtime_state || {});
    const chartSurface = await loadDashboardCandles(symbol, req.query.limit || 180);
    const chartTradeDate =
      chartSurface.candles[chartSurface.candles.length - 1]?.time?.slice(0, 10) ||
      getTodayIST();

    const signalResult = await query(
      `SELECT *
       FROM signals
       WHERE strategy_instance_id = $1
       ORDER BY timestamp DESC
       LIMIT 20`,
      [id],
    );

    const orderResult = await query(
      `SELECT *
       FROM orders
       WHERE strategy_instance_id = $1
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT 20`,
      [id],
    );

    const sessionSignalResult = await query(
      `SELECT *
       FROM signals
       WHERE strategy_instance_id = $1
         AND (COALESCE(trigger_bar_time, timestamp) AT TIME ZONE 'Asia/Kolkata')::date = $2::date
       ORDER BY COALESCE(trigger_bar_time, timestamp) ASC`,
      [id, chartTradeDate],
    );

    const sessionOrderResult = await query(
      `SELECT *
       FROM orders
       WHERE strategy_instance_id = $1
         AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
       ORDER BY created_at ASC`,
      [id, chartTradeDate],
    );

    const sessionBreakdown = buildRecordedSessionBreakdown({
      actualSignals: sessionSignalResult.rows,
      actualOrders: sessionOrderResult.rows,
    });
    const manualCorrections = await loadManualPositionCorrections(instance.id, chartTradeDate);
    const positionMismatch = await loadPositionMismatchForInstance(instance);
    const vwapSeries = calculateSessionVwapSeries(
      chartSurface.candles.map((candle) => ({
        ...candle,
        barTime: candle.time,
        date: String(candle.time || '').slice(0, 10),
      })),
    ).map((point) => ({
      time: point.barTime,
      value: point.vwap,
    }));

    const configuredTimeframe = normalizeStrategy1Timeframe(instance.parameters?.timeframe);
    const rawLastEvaluation = instance.runtime_state?.lastEvaluation || {};
    const runningTimeframe = normalizeStrategy1Timeframe(
      runtimeState.lastEvaluation?.evaluationTimeframe ||
        runtimeState.lastEvaluation?.timeframe ||
        rawLastEvaluation.evaluationTimeframe ||
        rawLastEvaluation.timeframe ||
        configuredTimeframe,
    );
    const pendingRestart =
      String(instance.status || '').toLowerCase() === 'running' &&
      configuredTimeframe !== runningTimeframe;

    return res.json({
      success: true,
      data: {
        generated_at: formatIST(),
        strategy: {
          instance_id: instance.id,
          strategy_id: instance.strategy_id,
          strategy_name: instance.strategy_name,
          strategy_type: instance.strategy_type,
          client_name: instance.client_name,
          client_id: instance.client_id,
          status: instance.status,
          symbol,
          timeframe: configuredTimeframe,
          running_timeframe: runningTimeframe,
          pending_restart: pendingRestart,
          parameters: instance.parameters || {},
          risk_limits: instance.risk_limits || {},
          worker_id: instance.worker_id || null,
        },
        runtime: {
          ...runtimeState,
          lifecycle:
            runtimeState.pendingExitContext
              ? 'PENDING_EXIT'
              : runtimeState.entryContext
                ? 'IN_POSITION'
                : runtimeState.pendingEntryContext
                  ? 'PENDING_ENTRY'
                  : 'IDLE',
          last_evaluation: runtimeState.lastEvaluation || null,
          trailing_stop:
            runtimeState.entryContext?.trailingStop ??
            runtimeState.lastEvaluation?.trailingStop ??
            null,
        },
        chart: {
          source: chartSurface.source,
          instrument_token: chartSurface.instrumentToken,
          candles: chartSurface.candles,
          vwap_series: vwapSeries,
          trailing_stop_series: buildTrailingStopSeries(
            chartSurface.candles,
            runtimeState.entryContext?.trailingStop ??
              runtimeState.lastEvaluation?.trailingStop ??
              null,
          ),
          markers: buildDashboardMarkers({
            strategySignals: sessionBreakdown.strategySignals,
            strategyOrders: sessionBreakdown.strategyOrders,
            manualOverrides: sessionBreakdown.manualOverrides,
            manualCorrections,
          }),
          trade_date: chartTradeDate,
        },
        signals: signalResult.rows,
        orders: orderResult.rows,
        manual_corrections: manualCorrections,
        position_mismatch: positionMismatch,
        links: {
          validation: `/validation?instance_id=${instance.id}&trade_date=${chartTradeDate}`,
        },
      },
    });
  } catch (error) {
    logger.error("Failed to build strategy dashboard surface", {
      error: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/instances/:id/validation", async (req, res) => {
  try {
    const { id } = req.params;
    const targetDate = String(req.query.trade_date || getTodayIST());

    const instanceResult = await query(
      `SELECT si.*, s.name as strategy_name, s.type as strategy_type, s.parameters as strategy_parameters, c.risk_limits, c.name as client_name
       FROM strategy_instances si
       JOIN strategies s ON si.strategy_id = s.id
       JOIN clients c ON c.id = si.client_id
       WHERE si.id = $1`,
      [id],
    );

    if (instanceResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    const instance = instanceResult.rows[0];
    if (
      String(instance.strategy_name || "").toUpperCase() !== "STRATEGY1_LIVE"
    ) {
      return res.status(400).json({
        success: false,
        error: "Validation is currently supported only for Strategy1",
      });
    }

    const symbol =
      instance.parameters?.symbol ||
      instance.strategy_parameters?.symbol ||
      "NIFTY 50";
    const symbolCandidates = normalizeSymbolCandidates(symbol);
    const fixedMax = instance.parameters?.fixedMax !== false;
    const maxRed = Number(instance.parameters?.maxRed ?? 3);
    const timeframe = normalizeStrategy1Timeframe(
      instance.parameters?.timeframe,
    );
    const mode = String(
      req.query.mode || (timeframe === "1day" ? "daily_30d" : "session_day"),
    );

    if (mode === "daily_30d") {
      const {
        candles,
        minuteCandles,
        source: candleSource,
        window,
      } = await loadMonthlyMinuteValidationDataset({
        symbol,
        symbolCandidates,
        completedBars: 30,
      });

      if (candles.length === 0 || minuteCandles.length === 0) {
        return res.status(404).json({
          success: false,
          error: `No completed daily validation bars found for ${symbol}`,
          data: {
            mode,
            candle_source: candleSource,
            window,
          },
        });
      }

      const replay = replayStrategy1DailyFromMinuteHistory({
        bars: minuteCandles,
        symbol,
        fixedMax,
        maxRed,
      });
      const vwapGateSummary = buildStrategy1VwapGateSummary(replay);
      const replayPerformance = buildStrategy1ReplayPerformance(replay, {
        startingCapital: Number(
          instance.parameters?.capital ?? instance.risk_limits?.capital ?? 0,
        ),
      });
      const positionMismatch = await loadPositionMismatchForInstance(instance);

      return res.json({
        success: true,
        data: {
          generated_at: formatIST(),
          mode,
          strategy: {
            instance_id: instance.id,
            strategy_id: instance.strategy_id,
            strategy_name: instance.strategy_name,
            client_name: instance.client_name,
            status: instance.status,
            symbol,
            maxRed,
            fixedMax,
            timeframe,
          },
          window,
          default_session_date:
            replay.events[replay.events.length - 1]?.barTime?.slice(0, 10) ||
            window.last_bar_date ||
            null,
          candle_source: candleSource,
          candles,
          replay: {
            ...replay,
            vwap_gate_summary: vwapGateSummary,
            synthetic_orders: replayPerformance.syntheticOrders,
            equity_curve: replayPerformance.equityCurve,
            stats: replayPerformance.stats,
          },
          position_mismatch: positionMismatch,
          manual_corrections: await loadManualPositionCorrections(instance.id),
          notes: [
            "Replay reconstructed from per-day 1-minute candles",
            "Today is excluded from monthly daily validation",
            "Daily BUY decisions are replayed with the 15:00-15:15 IST VWAP gate",
          ],
        },
      });
    }

    if (!isValidationWindowOpen(targetDate, new Date())) {
      return res.status(409).json({
        success: false,
        error:
          "Validation for the current trading day is available only after 16:15 IST",
        data: {
          trade_date: targetDate,
          available_after_ist: "16:15",
          generated_at: formatIST(),
          mode: "session_day",
        },
      });
    }

    const { candles, source: candleSource } = await loadValidationCandles({
      tradeDate: targetDate,
      symbol,
      symbolCandidates,
    });

    if (candles.length === 0) {
      return res.status(404).json({
        success: false,
        error: `No validation candles found for ${symbol} on ${targetDate}`,
        data: {
          mode: "session_day",
          candle_source: candleSource,
        },
      });
    }

    const signalResult = await query(
      `SELECT *
       FROM signals
       WHERE strategy_instance_id = $1
         AND (COALESCE(trigger_bar_time, timestamp) AT TIME ZONE 'Asia/Kolkata')::date = $2::date
       ORDER BY COALESCE(trigger_bar_time, timestamp) ASC`,
      [id, targetDate],
    );

    const orderResult = await query(
      `SELECT *
       FROM orders
       WHERE strategy_instance_id = $1
         AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
       ORDER BY created_at ASC`,
      [id, targetDate],
    );

    const replay = replayStrategy1Session({
      bars: candles,
      symbol,
      fixedMax,
      maxRed,
      timeframe,
    });
    const candleAudit = inspectCandleContinuity(candles);
    const sessionBreakdown = buildRecordedSessionBreakdown({
      actualSignals: signalResult.rows,
      actualOrders: orderResult.rows,
    });
    const operatorActivity = await loadSignalOperatorActivity(
      targetDate,
      sessionBreakdown.allSignals.map((signal) => signal.id),
    );
    const manualCorrections = await loadManualPositionCorrections(
      instance.id,
      targetDate,
    );
    const positionMismatch = await loadPositionMismatchForInstance(instance);
    const comparison = compareStrategy1Session({
      replay,
      actualSignals: sessionBreakdown.strategySignals,
      actualOrders: sessionBreakdown.strategyOrders,
    });

    return res.json({
      success: true,
      data: {
        generated_at: formatIST(),
        mode: "session_day",
        trade_date: targetDate,
        available_after_ist: "16:15",
        strategy: {
          instance_id: instance.id,
          strategy_id: instance.strategy_id,
          strategy_name: instance.strategy_name,
          client_name: instance.client_name,
          status: instance.status,
          symbol,
          maxRed,
          fixedMax,
          timeframe,
        },
        candle_audit: candleAudit,
        candle_source: candleSource,
        candles,
        replay,
        actual: {
          signals: sessionBreakdown.allSignals,
          strategy_signals: sessionBreakdown.strategySignals,
          orders: orderResult.rows,
          strategy_orders: sessionBreakdown.strategyOrders,
          manual_overrides: sessionBreakdown.manualOverrides,
          manual_corrections: manualCorrections,
          operator_trades: sessionBreakdown.operatorTrades,
          operator_activity: operatorActivity,
        },
        position_mismatch: positionMismatch,
        comparison,
      },
    });
  } catch (error) {
    logger.error("Failed to build strategy validation", {
      error: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/instances/:id/position-mismatch", async (req, res) => {
  try {
    const { id } = req.params;
    const instanceResult = await query(
      `SELECT si.*, s.name as strategy_name, s.type as strategy_type, s.parameters as strategy_parameters, c.risk_limits, c.name as client_name
       FROM strategy_instances si
       JOIN strategies s ON si.strategy_id = s.id
       JOIN clients c ON c.id = si.client_id
       WHERE si.id = $1`,
      [id],
    );

    if (instanceResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    const instance = instanceResult.rows[0];
    const mismatch = await loadPositionMismatchForInstance(instance);
    return res.json({
      success: true,
      data: {
        instance_id: instance.id,
        strategy_name: instance.strategy_name,
        generated_at: formatIST(),
        ...mismatch,
      },
    });
  } catch (error) {
    logger.error("Failed to load strategy position mismatch", {
      error: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/instances/:id/manual-position-corrections", async (req, res) => {
  try {
    const { id } = req.params;
    const corrections = await loadManualPositionCorrections(id);
    return res.json({
      success: true,
      data: corrections,
      meta: {
        count: corrections.length,
      },
    });
  } catch (error) {
    logger.error("Failed to load manual position corrections", {
      error: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/instances/:id/manual-position-corrections", async (req, res) => {
  try {
    if (!config.paperMode) {
      return res.status(409).json({
        success: false,
        error: "Manual position correction is enabled only in paper mode",
      });
    }

    const { id } = req.params;
    const instanceResult = await query(
      `SELECT si.*, s.name as strategy_name, s.type as strategy_type, s.parameters as strategy_parameters, c.risk_limits, c.name as client_name
       FROM strategy_instances si
       JOIN strategies s ON si.strategy_id = s.id
       JOIN clients c ON c.id = si.client_id
       WHERE si.id = $1`,
      [id],
    );

    if (instanceResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    const instance = instanceResult.rows[0];
    const result = await applyManualPositionCorrection(instance, req);
    return res.status(result.status).json(result.body);
  } catch (error) {
    logger.error("Failed to apply manual position correction", {
      error: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/instances/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT si.*, s.name as strategy_name, s.type as strategy_type, s.parameters as strategy_parameters, c.risk_limits, c.name as client_name
       FROM strategy_instances si
       JOIN strategies s ON si.strategy_id = s.id
       JOIN clients c ON c.id = si.client_id
       WHERE si.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to fetch strategy instance", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/instances", async (req, res) => {
  try {
    const { client_id, strategy_id, parameters } = req.body;

    if (!client_id || !strategy_id) {
      return res.status(400).json({
        success: false,
        error: "client_id and strategy_id are required",
      });
    }

    const result = await query(
      `INSERT INTO strategy_instances (client_id, strategy_id, parameters, status)
       VALUES ($1, $2, $3, 'created')
       RETURNING *`,
      [client_id, strategy_id, JSON.stringify(parameters || {})],
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to create strategy instance", {
      error: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch("/instances/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, parameters } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (status) {
      updates.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (parameters) {
      updates.push(`parameters = $${paramIndex}`);
      params.push(JSON.stringify(parameters));
      paramIndex++;
    }

    if (updates.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No fields to update" });
    }

    params.push(id);

    const result = await query(
      `UPDATE strategy_instances SET ${updates.join(", ")}, updated_at = NOW() 
       WHERE id = $${paramIndex}
       RETURNING *`,
      params,
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to update strategy instance", {
      error: error.message,
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch("/instances/:id/settings", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      symbol,
      quantity,
      maxRed,
      capital,
      stopLoss,
      maxDailyLoss,
      timeframe,
    } = req.body || {};

    const instanceResult = await query(
      `SELECT si.*, c.risk_limits
       FROM strategy_instances si
       JOIN clients c ON c.id = si.client_id
       WHERE si.id = $1`,
      [id],
    );

    if (instanceResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    const instance = instanceResult.rows[0];
    const nextParameters = {
      ...(instance.parameters || {}),
    };
    const nextRiskLimits = {
      ...(instance.risk_limits || {}),
    };
    const nextQuantity = parseOptionalNumber(quantity);
    const nextMaxRed = parseOptionalNumber(maxRed);
    const nextCapital = parseOptionalNumber(capital);
    const nextStopLoss = parseOptionalNumber(stopLoss);
    const nextMaxDailyLoss = parseOptionalNumber(maxDailyLoss);
    const nextTimeframe =
      timeframe === undefined
        ? undefined
        : normalizeStrategy1Timeframe(timeframe);

    if (symbol !== undefined) {
      nextParameters.symbol = symbol;
    }
    if (nextQuantity !== undefined) {
      nextParameters.quantity = nextQuantity;
    }
    if (nextMaxRed !== undefined) {
      nextParameters.maxRed = nextMaxRed;
    }
    if (nextCapital !== undefined) {
      nextParameters.capital = nextCapital;
      nextRiskLimits.capital = nextCapital;
    }
    if (nextStopLoss !== undefined) {
      nextParameters.stopLoss = nextStopLoss;
    }
    if (nextMaxDailyLoss !== undefined) {
      nextParameters.maxDailyLoss = nextMaxDailyLoss;
      nextRiskLimits.max_daily_loss = nextMaxDailyLoss;
    }
    if (nextTimeframe !== undefined) {
      nextParameters.timeframe = nextTimeframe;
    }

    const restartRequired = nextTimeframe !== undefined;

    const updatedInstanceResult = await query(
      `UPDATE strategy_instances
       SET parameters = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(nextParameters), id],
    );

    await query(
      `UPDATE clients
       SET risk_limits = $1, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(nextRiskLimits), instance.client_id],
    );

    return res.json({
      success: true,
      data: {
        ...updatedInstanceResult.rows[0],
        parameters: nextParameters,
        risk_limits: nextRiskLimits,
        restart_required: restartRequired,
      },
    });
  } catch (error) {
    logger.error("Failed to update strategy settings", {
      error: error.message,
    });
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.delete("/instances/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE strategy_instances SET status = 'stopped', updated_at = NOW() 
       WHERE id = $1
       RETURNING *`,
      [id],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Strategy instance not found" });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to stop strategy instance", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/signals", async (req, res) => {
  try {
    const { strategy_instance_id, status, limit = 50, offset = 0 } = req.query;

    let sql = "SELECT * FROM signals WHERE 1=1";
    const params = [];
    let paramIndex = 1;

    if (strategy_instance_id) {
      sql += ` AND strategy_instance_id = $${paramIndex}`;
      params.push(strategy_instance_id);
      paramIndex++;
    }

    if (status) {
      sql += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);

    res.json({
      success: true,
      data: result.rows,
      meta: {
        count: result.rows.length,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    logger.error("Failed to fetch signals", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
