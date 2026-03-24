const { query } = require("../../../packages/database/postgresClient");

function calculateNextPositionState(currentPosition, fillSide, fillQuantity, fillPrice) {
  const existingPosition = Number(currentPosition?.position || 0);
  const existingAveragePrice = Number(currentPosition?.average_price || 0);
  const existingRealizedPnL = Number(currentPosition?.realized_pnl || 0);
  const signedFillQuantity = fillSide === "BUY" ? Number(fillQuantity) : -Number(fillQuantity);

  if (!signedFillQuantity) {
    return {
      position: existingPosition,
      averagePrice: existingAveragePrice,
      realizedPnL: existingRealizedPnL,
      realizedDelta: 0,
    };
  }

  if (existingPosition === 0 || Math.sign(existingPosition) === Math.sign(signedFillQuantity)) {
    const nextPosition = existingPosition + signedFillQuantity;
    const totalExistingValue = Math.abs(existingPosition) * existingAveragePrice;
    const totalFillValue = Math.abs(signedFillQuantity) * fillPrice;
    const nextAveragePrice =
      nextPosition === 0 ? 0 : (totalExistingValue + totalFillValue) / Math.abs(nextPosition);

    return {
      position: nextPosition,
      averagePrice: nextAveragePrice,
      realizedPnL: existingRealizedPnL,
      realizedDelta: 0,
    };
  }

  const closingQuantity = Math.min(Math.abs(existingPosition), Math.abs(signedFillQuantity));
  const realizedDelta =
    existingPosition > 0
      ? (fillPrice - existingAveragePrice) * closingQuantity
      : (existingAveragePrice - fillPrice) * closingQuantity;
  const nextPosition = existingPosition + signedFillQuantity;

  let nextAveragePrice = existingAveragePrice;
  if (nextPosition === 0) {
    nextAveragePrice = 0;
  } else if (Math.sign(nextPosition) !== Math.sign(existingPosition)) {
    nextAveragePrice = fillPrice;
  }

  return {
    position: nextPosition,
    averagePrice: nextAveragePrice,
    realizedPnL: existingRealizedPnL + realizedDelta,
    realizedDelta,
  };
}

class PaperPortfolioWriter {
  constructor(options = {}) {
    this.query = options.query || query;
  }

  async syncAfterFill(order, fillPrice, options = {}) {
    const trade = await this.recordTrade(order, fillPrice, options);
    const position = await this.upsertPositionFromFill(order, fillPrice);
    const snapshot = await this.recordSnapshot(order.client_id);

    return { trade, position, snapshot };
  }

  async recordTrade(order, fillPrice, options = {}) {
    const result = await this.query(
      `INSERT INTO trades (
         order_id, client_id, strategy_instance_id, signal_id, symbol, instrument,
         side, quantity, price, execution_mode, broker_trade_id, timestamp
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paper', $10, COALESCE($11, NOW()))
       RETURNING *`,
      [
        order.id,
        order.client_id,
        order.strategy_instance_id || null,
        order.signal_id || null,
        order.symbol || null,
        order.instrument,
        order.side,
        order.quantity,
        fillPrice,
        options.brokerTradeId || `PAPER_TRADE_${order.id}`,
        options.timestamp || null,
      ],
    );

    return result.rows[0] || null;
  }

  async upsertPositionFromFill(order, fillPrice) {
    const existingResult = await this.query(
      `SELECT id, client_id, strategy_instance_id, symbol, instrument, position, average_price, realized_pnl
       FROM positions
       WHERE client_id = $1
         AND instrument = $2
         AND strategy_instance_id IS NOT DISTINCT FROM $3
       LIMIT 1`,
      [order.client_id, order.instrument, order.strategy_instance_id || null],
    );

    const currentPosition = existingResult.rows[0] || null;
    const nextState = calculateNextPositionState(
      currentPosition,
      order.side,
      order.quantity,
      fillPrice,
    );

    if (currentPosition?.id) {
      const updateResult = await this.query(
        `UPDATE positions
         SET symbol = $1,
             position = $2,
             average_price = $3,
             current_price = $4,
             unrealized_pnl = 0,
             realized_pnl = $5,
             updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [
          order.symbol || currentPosition.symbol || null,
          nextState.position,
          nextState.averagePrice,
          fillPrice,
          nextState.realizedPnL,
          currentPosition.id,
        ],
      );

      return updateResult.rows[0] || null;
    }

    const insertResult = await this.query(
      `INSERT INTO positions (
         client_id, strategy_instance_id, symbol, instrument, position,
         average_price, current_price, unrealized_pnl, realized_pnl, updated_at, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, NOW(), NOW())
       RETURNING *`,
      [
        order.client_id,
        order.strategy_instance_id || null,
        order.symbol || null,
        order.instrument,
        nextState.position,
        nextState.averagePrice,
        fillPrice,
        nextState.realizedPnL,
      ],
    );

    return insertResult.rows[0] || null;
  }

  async recordSnapshot(clientId) {
    const positionsResult = await this.query(
      `SELECT symbol, instrument, position, average_price, current_price, unrealized_pnl, realized_pnl, updated_at
       FROM positions
       WHERE client_id = $1
       ORDER BY instrument ASC`,
      [clientId],
    );

    const totals = positionsResult.rows.reduce(
      (acc, position) => {
        acc.realizedPnL += Number(position.realized_pnl || 0);
        acc.unrealizedPnL += Number(position.unrealized_pnl || 0);
        return acc;
      },
      { realizedPnL: 0, unrealizedPnL: 0 },
    );

    const snapshotResult = await this.query(
      `INSERT INTO portfolio_snapshots (
         client_id, total_pnl, realized_pnl, unrealized_pnl, margin_used,
         margin_available, positions_snapshot, snapshot_time, created_at
       )
       VALUES ($1, $2, $3, $4, 0, 0, $5, NOW(), NOW())
       RETURNING *`,
      [
        clientId,
        totals.realizedPnL + totals.unrealizedPnL,
        totals.realizedPnL,
        totals.unrealizedPnL,
        JSON.stringify(positionsResult.rows),
      ],
    );

    return snapshotResult.rows[0] || null;
  }
}

module.exports = {
  PaperPortfolioWriter,
  calculateNextPositionState,
};
