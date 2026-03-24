const express = require("express");
const { query } = require("../../../../packages/database/postgresClient");
const { logger } = require("../../../../packages/core/logger/logger");
const { sanitizeError, handleApiError } = require("../utils/errorHandler");
const { getWorkerManager } = require("../../../strategy-engine/src/workerManager");
const { AngelHistoricalDataClient } = require("../../../market-data-service/src/angelHistoricalDataClient");
const config = require("../../../../config/default");
const { formatIST, getTodayIST, getISTParts } = require("../../../../packages/core/utils/time");
const {
  compareStrategy1Session,
  inspectCandleContinuity,
  isValidationWindowOpen,
  replayStrategy1Session,
  toBarTime,
} = require("../../../../packages/strategies/intraday/strategy1Validation");

const router = express.Router();

function deriveStrategyKey(row) {
  if (row.file_path) {
    const normalizedPath = row.file_path.replace(/\\/g, "/");
    const pathParts = normalizedPath.split("/");
    const fileName = pathParts[pathParts.length - 1].replace(/\.js$/i, "");
    const category = pathParts.length > 1 ? pathParts[pathParts.length - 2] : row.type;
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
  const normalized = String(symbol || "").trim().toUpperCase();
  const aliases = SYMBOL_ALIASES[normalized];
  return aliases ? aliases.map((entry) => entry.toUpperCase()) : [normalized].filter(Boolean);
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
  const historicalClient = new AngelHistoricalDataClient();
  const bars = await historicalClient.fetchIntradayBarsForSymbol({
    symbol,
    tradeDate,
    sessionStart: config.marketHours.open,
    sessionEnd: config.marketHours.close,
  });

  return bars
    .map((row) => toValidationCandle(row, tradeDate))
    .filter(Boolean);
}

async function loadValidationCandles({ tradeDate, symbol, symbolCandidates }) {
  const retainedCandles = await loadRetainedValidationCandles(tradeDate, symbolCandidates);
  let selectedCandles = retainedCandles;
  let selectedSource = "market_ohlc_1m";
  let historicalCandles = [];
  let sourceWarning = null;

  try {
    historicalCandles = await loadHistoricalValidationCandles(tradeDate, symbol);
    if (historicalCandles.length > 0) {
      selectedCandles = historicalCandles;
      selectedSource = "angel_historical";
    } else if (retainedCandles.length === 0) {
      sourceWarning = "Angel historical API returned no candles for the selected day";
    }
  } catch (error) {
    sourceWarning = error.message;
    logger.warn("Historical validation candle fetch failed; using retained feed candles", {
      symbol,
      tradeDate,
      error: error.message,
    });
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

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

router.get("/instances/:id/validation", async (req, res) => {
  try {
    const { id } = req.params;
    const targetDate = String(req.query.trade_date || getTodayIST());

    if (!isValidationWindowOpen(targetDate, new Date())) {
      return res.status(409).json({
        success: false,
        error: "Validation for the current trading day is available only after 16:15 IST",
        data: {
          trade_date: targetDate,
          available_after_ist: "16:15",
          generated_at: formatIST(),
        },
      });
    }

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
    if (String(instance.strategy_name || "").toUpperCase() !== "STRATEGY1_LIVE") {
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
    });
    const candleAudit = inspectCandleContinuity(candles);
    const comparison = compareStrategy1Session({
      replay,
      actualSignals: signalResult.rows,
      actualOrders: orderResult.rows,
    });

    return res.json({
      success: true,
      data: {
        generated_at: formatIST(),
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
        },
        candle_audit: candleAudit,
        candle_source: candleSource,
        candles,
        replay,
        actual: {
          signals: signalResult.rows,
          orders: orderResult.rows,
        },
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
        risk_limits: nextRiskLimits,
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
