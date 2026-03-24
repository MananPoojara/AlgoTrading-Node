const express = require("express");
const { query } = require("../../../../packages/database/postgresClient");
const { getPublisher } = require("../../../../packages/core/eventBus/publisher");
const { handleApiError } = require("../utils/errorHandler");

const router = express.Router();
const publisher = getPublisher();

router.get("/warnings", async (req, res) => {
  try {
    const { client_id, limit = 50, offset = 0 } = req.query;
    const params = [];
    let paramIndex = 1;

    let sql = `
      SELECT
        id,
        level,
        service,
        client_id,
        strategy_id,
        message,
        metadata,
        timestamp
      FROM system_logs
      WHERE metadata->>'event_type' = 'risk_warning'
    `;

    if (client_id) {
      sql += ` AND client_id = $${paramIndex}`;
      params.push(Number(client_id));
      paramIndex += 1;
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await query(sql, params);

    res.json({
      success: true,
      data: result.rows,
      meta: {
        limit: Number(limit),
        offset: Number(offset),
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/api/risk/warnings" });
  }
});

router.get("/approvals", async (req, res) => {
  try {
    const { client_id, status = "pending", limit = 50, offset = 0 } = req.query;
    const params = [];
    let paramIndex = 1;

    let sql = `
      SELECT
        id,
        level,
        service,
        client_id,
        strategy_id,
        message,
        metadata,
        timestamp
      FROM system_logs
      WHERE metadata->>'event_type' = 'operator_approval_pending'
    `;

    if (client_id) {
      sql += ` AND client_id = $${paramIndex}`;
      params.push(Number(client_id));
      paramIndex += 1;
    }

    if (status) {
      sql += ` AND COALESCE(metadata->>'status', 'pending') = $${paramIndex}`;
      params.push(String(status));
      paramIndex += 1;
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await query(sql, params);
    res.json({
      success: true,
      data: result.rows,
      meta: {
        limit: Number(limit),
        offset: Number(offset),
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/api/risk/approvals" });
  }
});

router.get("/decisions", async (req, res) => {
  try {
    const { client_id, event_id, limit = 50, offset = 0 } = req.query;
    const params = [];
    let paramIndex = 1;

    let sql = `
      SELECT
        id,
        level,
        service,
        client_id,
        strategy_id,
        message,
        metadata,
        timestamp
      FROM system_logs
      WHERE metadata->>'event_type' = 'signal_decision'
    `;

    if (client_id) {
      sql += ` AND client_id = $${paramIndex}`;
      params.push(Number(client_id));
      paramIndex += 1;
    }

    if (event_id) {
      sql += ` AND metadata->>'event_id' = $${paramIndex}`;
      params.push(String(event_id));
      paramIndex += 1;
    }

    sql += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), Number(offset));

    const result = await query(sql, params);
    res.json({
      success: true,
      data: result.rows,
      meta: {
        limit: Number(limit),
        offset: Number(offset),
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/api/risk/decisions" });
  }
});

router.post("/approvals/:id/approve", async (req, res) => {
  try {
    const approvalId = Number(req.params.id);
    await publisher.publishOperatorAction({
      approval_id: approvalId,
      action: "approve",
      operator_id: req.user?.clientId || null,
      operator_username: req.body?.operator_username || null,
      source: "api",
    });

    res.json({
      success: true,
      data: {
        approval_id: approvalId,
        action: "approve",
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/api/risk/approvals/:id/approve" });
  }
});

router.post("/approvals/:id/reject", async (req, res) => {
  try {
    const approvalId = Number(req.params.id);
    await publisher.publishOperatorAction({
      approval_id: approvalId,
      action: "reject",
      operator_id: req.user?.clientId || null,
      operator_username: req.body?.operator_username || null,
      source: "api",
    });

    res.json({
      success: true,
      data: {
        approval_id: approvalId,
        action: "reject",
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/api/risk/approvals/:id/reject" });
  }
});

module.exports = router;
