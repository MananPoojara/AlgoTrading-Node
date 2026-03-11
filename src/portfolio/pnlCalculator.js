const { logger } = require("../core/logger/logger");
const { query } = require("../database/postgresClient");

class PnLCalculator {
  constructor(clientId = null) {
    this.clientId = clientId;
    this.dailyStats = {
      realizedPnL: 0,
      unrealizedPnL: 0,
      trades: 0,
      volume: 0,
    };
    this.lastReset = new Date().toDateString();
    this.positions = new Map();
  }

  checkDailyReset() {
    const today = new Date().toDateString();
    if (this.lastReset !== today) {
      this.dailyStats = {
        realizedPnL: 0,
        unrealizedPnL: 0,
        trades: 0,
        volume: 0,
      };
      this.lastReset = today;
    }
  }

  updatePosition(instrument, position, averagePrice) {
    this.positions.set(instrument, { position, averagePrice });
  }

  calculateUnrealizedPnL(positions, currentPrices) {
    let totalUnrealized = 0;

    for (const [instrument, position] of Object.entries(positions)) {
      const currentPrice = currentPrices[instrument];
      if (!currentPrice || position.position === 0) continue;

      const avgPrice = position.averagePrice;
      const quantity = Math.abs(position.position);

      if (position.position > 0) {
        totalUnrealized += (currentPrice - avgPrice) * quantity;
      } else {
        totalUnrealized += (avgPrice - currentPrice) * quantity;
      }
    }

    this.dailyStats.unrealizedPnL = totalUnrealized;
    return totalUnrealized;
  }

  async calculateRealizedPnLFromTrades(
    clientId,
    startDate = null,
    endDate = null,
  ) {
    try {
      let sql = `
        SELECT 
          instrument,
          side,
          quantity,
          average_price,
          created_at
        FROM orders 
        WHERE client_id = $1 
          AND status = 'filled'
      `;

      const params = [clientId];
      let paramIndex = 2;

      if (startDate) {
        sql += ` AND created_at >= $${paramIndex}`;
        params.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        sql += ` AND created_at <= $${paramIndex}`;
        params.push(endDate);
      }

      sql += " ORDER BY created_at ASC";

      const result = await query(sql, params);

      const positionTracker = new Map();
      let realizedPnL = 0;
      const trades = [];

      for (const order of result.rows) {
        const instrument = order.instrument;
        const quantity = parseInt(order.quantity);
        const price = parseFloat(order.average_price);
        const side = order.side;

        const currentPosition = positionTracker.get(instrument) || 0;
        let tradePnL = 0;

        if (side === "BUY") {
          const newPosition = currentPosition + quantity;
          if (currentPosition < 0 && newPosition >= 0) {
            const closedQty = Math.min(quantity, Math.abs(currentPosition));
            tradePnL = (price - Math.abs(currentPosition)) * closedQty;
            tradePnL += newPosition >= 0 ? 0 : price * newPosition;
          } else if (currentPosition > 0) {
            const avgPrice =
              currentPosition > 0
                ? ((this.positions.get(instrument)?.averagePrice || price) *
                    currentPosition +
                    price * quantity) /
                  (currentPosition + quantity)
                : price;
          }
          positionTracker.set(instrument, newPosition);
        } else {
          const newPosition = currentPosition - quantity;
          if (currentPosition > 0 && newPosition <= 0) {
            const closedQty = Math.min(quantity, currentPosition);
            tradePnL = (price - currentPosition) * closedQty;
          } else if (currentPosition < 0) {
            tradePnL = (currentPosition - price) * Math.abs(quantity);
          }
          positionTracker.set(instrument, newPosition);
        }

        realizedPnL += tradePnL;

        const value = quantity * price;
        trades.push({
          instrument,
          side,
          quantity,
          price,
          pnl: tradePnL,
          value,
          date: order.created_at,
        });
      }

      this.dailyStats.realizedPnL = realizedPnL;
      this.dailyStats.trades = trades.length;
      this.dailyStats.volume = trades.reduce((sum, t) => sum + t.value, 0);

      return {
        realizedPnL,
        trades: trades.length,
        volume: this.dailyStats.volume,
        tradeDetails: trades,
      };
    } catch (error) {
      logger.error("Failed to calculate realized PnL", {
        clientId,
        error: error.message,
      });
      throw error;
    }
  }

  async recordPnLSnapshot(clientId, positions, currentPrices) {
    this.checkDailyReset();

    const unrealized = this.calculateUnrealizedPnL(positions, currentPrices);
    const realized = this.dailyStats.realizedPnL;

    const totalPnL = unrealized + realized;

    try {
      await query(
        `INSERT INTO portfolio_snapshots 
         (client_id, unrealized_pnl, realized_pnl, total_pnl, positions_snapshot, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [clientId, unrealized, realized, totalPnL, JSON.stringify(positions)],
      );

      logger.info("PnL snapshot recorded", {
        clientId,
        unrealized,
        realized,
        totalPnL,
      });
    } catch (error) {
      logger.error("Failed to record PnL snapshot", {
        clientId,
        error: error.message,
      });
      throw error;
    }
  }

  async getHistoricalPnL(clientId, days = 30) {
    const validDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);

    try {
      const result = await query(
        `SELECT 
          DATE(created_at) as date,
          SUM(unrealized_pnl) as unrealized,
          SUM(realized_pnl) as realized,
          SUM(total_pnl) as total
         FROM portfolio_snapshots
         WHERE client_id = $1 
           AND created_at >= NOW() - INTERVAL '${validDays} days'
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [clientId],
      );

      return result.rows;
    } catch (error) {
      logger.error("Failed to get historical PnL", {
        clientId,
        error: error.message,
      });
      throw error;
    }
  }

  getDailyStats() {
    this.checkDailyReset();
    return { ...this.dailyStats };
  }

  onTrade(trade) {
    this.checkDailyReset();
    this.dailyStats.trades++;

    const value = trade.quantity * trade.price;
    this.dailyStats.volume += value;

    if (trade.side === "SELL") {
      this.dailyStats.realizedPnL += value;
    } else {
      this.dailyStats.realizedPnL -= value;
    }
  }
}

const pnlCalculators = new Map();

function getPnLCalculator(clientId) {
  if (!clientId) {
    throw new Error("clientId is required");
  }

  if (!pnlCalculators.has(clientId)) {
    pnlCalculators.set(clientId, new PnLCalculator(clientId));
  }
  return pnlCalculators.get(clientId);
}

module.exports = {
  PnLCalculator,
  getPnLCalculator,
};
