const express = require("express");
const { query } = require("../../database/postgresClient");
const { logger } = require("../../core/logger/logger");
const { sanitizeError, handleApiError } = require("../utils/errorHandler");
const { getWorkerManager } = require("../../strategyEngine/workerManager");

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
      SELECT si.*, s.name as strategy_name, s.type as strategy_type, c.name as client_name
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

router.get("/instances/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT si.*, s.name as strategy_name, s.type as strategy_type, s.parameters as strategy_parameters
       FROM strategy_instances si
       JOIN strategies s ON si.strategy_id = s.id
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
