const express = require("express");
const { query } = require("../../database/postgresClient");
const { logger } = require("../../core/logger/logger");
const { sanitizeError, handleApiError } = require("../utils/errorHandler");

const router = express.Router();

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

    const result = await query(
      `SELECT 
        date_trunc($4, timestamp) as time,
        MIN(ltp) as low,
        MAX(ltp) as high,
        FIRST_VALUE(ltp) OVER (PARTITION BY date_trunc($4, timestamp) ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as open,
        LAST_VALUE(ltp) OVER (PARTITION BY date_trunc($4, timestamp) ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close,
        SUM(volume) as volume
       FROM market_ticks
       WHERE instrument_token = $1 AND timestamp BETWEEN $2 AND $3
       GROUP BY date_trunc($4, timestamp)
       ORDER BY time`,
      [token, from, to, interval],
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
      `SELECT * FROM market_ticks 
       WHERE instrument_token = $1 
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

module.exports = router;
