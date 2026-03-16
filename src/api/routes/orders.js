const express = require("express");
const { query } = require("../../database/postgresClient");
const { logger } = require("../../core/logger/logger");
const { sanitizeError, handleApiError } = require("../utils/errorHandler");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { client_id, status, limit = 50, offset = 0 } = req.query;

    let sql = "SELECT * FROM orders WHERE 1=1";
    const params = [];
    let paramIndex = 1;

    if (client_id) {
      sql += ` AND client_id = $${paramIndex}`;
      params.push(client_id);
      paramIndex++;
    }

    if (status) {
      sql += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);

    let countSql = "SELECT COUNT(*) FROM orders WHERE 1=1";
    const countParams = [];
    let countIndex = 1;

    if (client_id) {
      countSql += ` AND client_id = $${countIndex}`;
      countParams.push(client_id);
      countIndex++;
    }

    if (status) {
      countSql += ` AND status = $${countIndex}`;
      countParams.push(status);
    }

    const countResult = await query(countSql, countParams);

    res.json({
      success: true,
      data: result.rows,
      meta: {
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/orders" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query("SELECT * FROM orders WHERE id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Order not found" });
    }

    const eventsResult = await query(
      "SELECT * FROM order_events WHERE order_id = $1 ORDER BY timestamp ASC",
      [id],
    );

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        events: eventsResult.rows,
      },
    });
  } catch (error) {
    logger.error("Failed to fetch order", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const {
      client_id,
      strategy_instance_id,
      symbol,
      instrument,
      side,
      quantity,
      price,
      price_type,
    } = req.body;

    if (!client_id || !instrument || !side || !quantity) {
      return res.status(400).json({
        success: false,
        error: "client_id, instrument, side, and quantity are required",
      });
    }

    const result = await query(
      `INSERT INTO orders (client_id, strategy_instance_id, symbol, instrument, side, quantity, price, price_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'created')
       RETURNING *`,
      [
        client_id,
        strategy_instance_id,
        symbol,
        instrument,
        side,
        quantity,
        price || 0,
        price_type || "MARKET",
      ],
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to create order", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE orders SET status = 'cancelled', updated_at = NOW() 
       WHERE id = $1 AND status NOT IN ('filled', 'rejected', 'cancelled', 'failed')
       RETURNING *`,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Order not found or cannot be cancelled",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to cancel order", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/:id/events", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      "SELECT * FROM order_events WHERE order_id = $1 ORDER BY timestamp ASC",
      [id],
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    logger.error("Failed to fetch order events", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/stats/summary", async (req, res) => {
  try {
    const { client_id, date } = req.query;

    const targetDate = date || new Date().toISOString().split("T")[0];

    let sql = `
      SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'filled' THEN 1 END) as filled,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
        COALESCE(SUM(CASE WHEN status = 'filled' THEN quantity * average_price ELSE 0 END), 0) as total_volume
      FROM orders 
      WHERE DATE(created_at) = $1
    `;
    const params = [targetDate];

    if (client_id) {
      sql += " AND client_id = $2";
      params.push(client_id);
    }

    const result = await query(sql, params);

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error("Failed to fetch order stats", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
