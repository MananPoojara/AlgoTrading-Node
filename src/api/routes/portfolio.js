const express = require("express");
const { query } = require("../../database/postgresClient");
const { handleApiError } = require("../utils/errorHandler");

const router = express.Router();

function resolveClientId(req) {
  return req.user?.clientId || req.query.client_id || req.body?.client_id || null;
}

async function fetchPositions(clientId) {
  const result = await query(
    `SELECT
       id,
       client_id,
       strategy_instance_id,
       symbol,
       instrument,
       position,
       average_price,
       current_price,
       unrealized_pnl,
       realized_pnl,
       updated_at
     FROM positions
     WHERE client_id = $1
       AND position <> 0
     ORDER BY updated_at DESC, instrument ASC`,
    [clientId],
  );

  return result.rows.map((row) => {
    const quantity = Number(row.position || 0);
    const currentPrice = Number(row.current_price || row.average_price || 0);
    return {
      ...row,
      position: quantity,
      average_price: Number(row.average_price || 0),
      current_price: currentPrice,
      market_value: Math.abs(quantity) * currentPrice,
      pnl: Number(row.realized_pnl || 0) + Number(row.unrealized_pnl || 0),
    };
  });
}

async function fetchLatestSnapshot(clientId) {
  const result = await query(
    `SELECT *
     FROM portfolio_snapshots
     WHERE client_id = $1
     ORDER BY COALESCE(snapshot_time, created_at) DESC
     LIMIT 1`,
    [clientId],
  );

  return result.rows[0] || null;
}

router.get("/", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(400).json({ success: false, error: "client_id is required" });
    }

    const [positions, snapshot] = await Promise.all([
      fetchPositions(clientId),
      fetchLatestSnapshot(clientId),
    ]);

    const realizedPnL = Number(snapshot?.realized_pnl || 0);
    const unrealizedPnL = Number(snapshot?.unrealized_pnl || 0);

    res.json({
      success: true,
      data: {
        client_id: Number(clientId),
        positions,
        total_pnl: Number(snapshot?.total_pnl || realizedPnL + unrealizedPnL),
        realized_pnl: realizedPnL,
        unrealized_pnl: unrealizedPnL,
        total_value: positions.reduce((sum, position) => sum + Number(position.market_value || 0), 0),
        used_margin: Number(snapshot?.margin_used || 0),
        available_margin: Number(snapshot?.margin_available || 0),
        snapshot_time: snapshot?.snapshot_time || snapshot?.created_at || null,
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio" });
  }
});

router.get("/positions", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(400).json({ success: false, error: "client_id is required" });
    }

    const positions = await fetchPositions(clientId);
    res.json({ success: true, data: positions });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/positions" });
  }
});

router.get("/pnl", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const days = Math.min(Math.max(parseInt(req.query.days || 30, 10), 1), 365);

    if (!clientId) {
      return res.status(400).json({ success: false, error: "client_id is required" });
    }

    const current = await fetchLatestSnapshot(clientId);
    const historical = await query(
      `SELECT
         DATE(COALESCE(snapshot_time, created_at)) AS date,
         SUM(realized_pnl) AS realized,
         SUM(unrealized_pnl) AS unrealized,
         SUM(total_pnl) AS total
       FROM portfolio_snapshots
       WHERE client_id = $1
         AND COALESCE(snapshot_time, created_at) >= NOW() - ($2::text || ' days')::interval
       GROUP BY DATE(COALESCE(snapshot_time, created_at))
       ORDER BY date ASC`,
      [clientId, days],
    );

    res.json({
      success: true,
      data: {
        current: current || {
          client_id: Number(clientId),
          total_pnl: 0,
          realized_pnl: 0,
          unrealized_pnl: 0,
        },
        historical: historical.rows,
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/pnl" });
  }
});

router.get("/margin", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(400).json({ success: false, error: "client_id is required" });
    }

    const snapshot = await fetchLatestSnapshot(clientId);
    const used = Number(snapshot?.margin_used || 0);
    const available = Number(snapshot?.margin_available || 0);
    const total = used + available;

    res.json({
      success: true,
      data: {
        total,
        used,
        available,
        utilization_percent: total > 0 ? (used / total) * 100 : 0,
      },
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/margin" });
  }
});

router.post("/snapshot", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(400).json({ success: false, error: "client_id is required" });
    }

    const positions = await fetchPositions(clientId);
    const realizedPnL = positions.reduce((sum, position) => sum + Number(position.realized_pnl || 0), 0);
    const unrealizedPnL = positions.reduce((sum, position) => sum + Number(position.unrealized_pnl || 0), 0);

    const result = await query(
      `INSERT INTO portfolio_snapshots (
         client_id, total_pnl, realized_pnl, unrealized_pnl, margin_used,
         margin_available, positions_snapshot, snapshot_time, created_at
       )
       VALUES ($1, $2, $3, $4, 0, 0, $5, NOW(), NOW())
       RETURNING *`,
      [
        clientId,
        realizedPnL + unrealizedPnL,
        realizedPnL,
        unrealizedPnL,
        JSON.stringify(positions),
      ],
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    return handleApiError(res, error, { route: "/portfolio/snapshot" });
  }
});

module.exports = router;
