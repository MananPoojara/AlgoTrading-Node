const express = require("express");
const { query } = require("../../../../packages/database/postgresClient");
const { logger } = require("../../../../packages/core/logger/logger");
const { sanitizeError, handleApiError } = require("../utils/errorHandler");

const router = express.Router();

const SYMBOL_ALIASES = {
  NIFTY: ["NIFTY", "NIFTY 50", "NIFTY50"],
  "NIFTY 50": ["NIFTY 50", "NIFTY", "NIFTY50"],
  BANKNIFTY: ["BANKNIFTY", "NIFTYBANK", "BANK NIFTY"],
  NIFTYBANK: ["NIFTYBANK", "BANKNIFTY", "BANK NIFTY"],
};

function normalizeSymbolCandidates(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  const aliases = SYMBOL_ALIASES[normalized];

  if (aliases) {
    return aliases.map((entry) => entry.toUpperCase());
  }

  return normalized ? [normalized] : [];
}

router.get("/instruments", async (req, res) => {
  try {
    const { exchange, search, limit = 50, offset = 0 } = req.query;

    let sql = "SELECT * FROM instruments WHERE 1=1";
    const params = [];
    let paramIndex = 1;

    if (exchange) {
      sql += ` AND exchange = $${paramIndex}`;
      params.push(exchange);
      paramIndex++;
    }

    if (search) {
      sql += ` AND (symbol ILIKE $${paramIndex} OR trading_symbol ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    sql += ` ORDER BY symbol LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
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
    logger.error("Failed to fetch instruments", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/instruments/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const result = await query(
      "SELECT * FROM instruments WHERE instrument_token = $1",
      [token],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Instrument not found" });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to fetch instrument", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/ticks/latest", async (req, res) => {
  try {
    const { token, limit = 10 } = req.query;

    let sql = "SELECT * FROM market_ticks";
    const params = [];

    if (token) {
      sql += " WHERE instrument_token = $1";
      params.push(token);
      sql += " ORDER BY timestamp DESC LIMIT $2";
      params.push(parseInt(limit));
    } else {
      sql += " ORDER BY timestamp DESC LIMIT $1";
      params.push(parseInt(limit));
    }

    const result = await query(sql, params);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    logger.error("Failed to fetch ticks", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/ticks/historical", async (req, res) => {
  try {
    const { token, from, to, interval = "1min" } = req.query;

    if (!token || !from || !to) {
      return res.status(400).json({
        success: false,
        error: "token, from, and to are required",
      });
    }

    const allowedIntervals = {
      "1min": "1 minute",
      "5min": "5 minutes",
      "15min": "15 minutes",
      "1hour": "1 hour",
      "1day": "1 day",
    };
    const bucket = allowedIntervals[String(interval).toLowerCase()];

    if (!bucket) {
      return res.status(400).json({
        success: false,
        error: "Unsupported interval",
      });
    }

    const result = await query(
      `WITH base AS (
         SELECT
           instrument_token,
           symbol,
           exchange,
           date_bin($4::interval, candle_time, TIMESTAMPTZ '2001-01-01 00:00:00+05:30') AS bucket_time,
           candle_time,
           open,
           high,
           low,
           close,
           volume
         FROM market_ohlc_1m
         WHERE instrument_token = $1
           AND candle_time BETWEEN $2 AND $3
       ),
       aggregated AS (
         SELECT
           bucket_time,
           MIN(low) AS low,
           MAX(high) AS high,
           COALESCE(SUM(volume), 0) AS volume
         FROM base
         GROUP BY bucket_time
       ),
       open_rows AS (
         SELECT DISTINCT ON (bucket_time) bucket_time, open
         FROM base
         ORDER BY bucket_time, candle_time ASC
       ),
       close_rows AS (
         SELECT DISTINCT ON (bucket_time) bucket_time, close
         FROM base
         ORDER BY bucket_time, candle_time DESC
       )
       SELECT
         aggregated.bucket_time AS time,
         open_rows.open,
         aggregated.high,
         aggregated.low,
         close_rows.close,
         aggregated.volume
       FROM aggregated
       JOIN open_rows ON open_rows.bucket_time = aggregated.bucket_time
       JOIN close_rows ON close_rows.bucket_time = aggregated.bucket_time
       ORDER BY time`,
      [token, from, to, bucket],
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    logger.error("Failed to fetch historical data", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/quotes/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const result = await query(
      `SELECT *
       FROM (
         SELECT instrument_token, symbol, exchange, ltp, timestamp
         FROM market_ticks
         WHERE instrument_token = $1
         ORDER BY timestamp DESC
         LIMIT 1
       ) latest_tick
       UNION ALL
       SELECT *
       FROM (
         SELECT instrument_token, symbol, exchange, close AS ltp, candle_time AS timestamp
         FROM market_ohlc_1m
         WHERE instrument_token = $1
         ORDER BY candle_time DESC
         LIMIT 1
       ) latest_candle
       ORDER BY timestamp DESC
       LIMIT 1`,
      [token],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "No quote available" });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to fetch quote", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/chart", async (req, res) => {
  try {
    const { symbol, interval = "1min", limit = 180 } = req.query;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: "symbol is required",
      });
    }

    const candidates = normalizeSymbolCandidates(symbol);
    const maxRows = Math.min(Math.max(parseInt(limit, 10) || 180, 20), 500);
    const allowedIntervals = {
      "1min": "1 minute",
      "5min": "5 minutes",
      "15min": "15 minutes",
    };
    const bucket = allowedIntervals[String(interval).toLowerCase()] || "1 minute";

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
      return res.status(404).json({
        success: false,
        error: "Instrument token not found for chart symbol",
      });
    }

    const instrument = instrumentResult.rows[0];

    const result = await query(
      `WITH source AS (
         SELECT
           instrument_token,
           symbol,
           date_bin($2::interval, candle_time, TIMESTAMPTZ '2001-01-01 00:00:00+05:30') AS bucket_time,
           candle_time,
           open,
           high,
           low,
           close,
           volume
         FROM market_ohlc_1m
         WHERE instrument_token = $1
         ORDER BY candle_time DESC
         LIMIT $3 * 5
       ),
       aggregated AS (
         SELECT
           bucket_time,
           MIN(low) AS low,
           MAX(high) AS high,
           COALESCE(SUM(volume), 0) AS volume
         FROM source
         GROUP BY bucket_time
       ),
       open_rows AS (
         SELECT DISTINCT ON (bucket_time) bucket_time, open
         FROM source
         ORDER BY bucket_time, candle_time ASC
       ),
       close_rows AS (
         SELECT DISTINCT ON (bucket_time) bucket_time, close
         FROM source
         ORDER BY bucket_time, candle_time DESC
       )
       SELECT
         aggregated.bucket_time AS time,
         open_rows.open,
         aggregated.high,
         aggregated.low,
         close_rows.close,
         aggregated.volume
       FROM aggregated
       JOIN open_rows ON open_rows.bucket_time = aggregated.bucket_time
       JOIN close_rows ON close_rows.bucket_time = aggregated.bucket_time
       ORDER BY time DESC
       LIMIT $3`,
      [instrument.instrument_token, bucket, maxRows],
    );

    res.json({
      success: true,
      data: {
        symbol: instrument.symbol,
        instrument_token: instrument.instrument_token,
        interval: String(interval).toLowerCase(),
        candles: result.rows.reverse(),
      },
    });
  } catch (error) {
    logger.error("Failed to fetch chart data", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
