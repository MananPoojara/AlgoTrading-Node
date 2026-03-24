const { logger } = require("../../../packages/core/logger/logger");
const { query } = require("../../../packages/database/postgresClient");

class PositionTracker {
  constructor(clientId = null) {
    this.clientId = clientId;
    this.positions = new Map();
  }

  async initialize(clientId) {
    this.clientId = clientId;
    await this.loadPositionsFromDB();
    logger.info("PositionTracker initialized", {
      clientId,
      positionCount: this.positions.size,
    });
  }

  async loadPositionsFromDB() {
    if (!this.clientId) return;

    try {
      const result = await query(
        `SELECT instrument, position, average_price, updated_at 
         FROM positions WHERE client_id = $1`,
        [this.clientId],
      );

      for (const row of result.rows) {
        this.positions.set(row.instrument, {
          instrument: row.instrument,
          position: parseInt(row.position),
          averagePrice: parseFloat(row.average_price),
          updatedAt: row.updated_at,
        });
      }
    } catch (error) {
      logger.error("Failed to load positions from DB", {
        clientId: this.clientId,
        error: error.message,
      });
    }
  }

  async updatePosition(instrument, quantity, price, side) {
    const current = this.positions.get(instrument);

    if (!current) {
      this.positions.set(instrument, {
        instrument,
        position: side === "BUY" ? quantity : -quantity,
        averagePrice: price,
        updatedAt: new Date(),
      });
      return this.getPosition(instrument);
    }

    let newPosition;
    let newAvgPrice;

    if (side === "BUY") {
      newPosition = current.position + quantity;
      newAvgPrice =
        (current.position * current.averagePrice + quantity * price) /
        (current.position + quantity);
    } else {
      newPosition = current.position - quantity;
      if (newPosition === 0) {
        newAvgPrice = 0;
      } else if (newPosition > 0) {
        newAvgPrice = current.averagePrice;
      } else {
        newAvgPrice =
          (current.position * current.averagePrice - quantity * price) /
          (current.position - quantity);
      }
    }

    const updated = {
      instrument,
      position: newPosition,
      averagePrice: newAvgPrice || 0,
      updatedAt: new Date(),
    };

    this.positions.set(instrument, updated);
    await this.savePosition(updated);

    return updated;
  }

  async savePosition(position) {
    if (!this.clientId) return;

    try {
      await query(
        `INSERT INTO positions (client_id, instrument, position, average_price, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (client_id, instrument) 
         DO UPDATE SET position = $3, average_price = $4, updated_at = NOW()`,
        [
          this.clientId,
          position.instrument,
          position.position,
          position.averagePrice,
        ],
      );
    } catch (error) {
      logger.error("Failed to save position", {
        clientId: this.clientId,
        instrument: position.instrument,
        error: error.message,
      });
    }
  }

  getPosition(instrument) {
    return this.positions.get(instrument) || null;
  }

  getAllPositions() {
    return Array.from(this.positions.values()).filter((p) => p.position !== 0);
  }

  async handleOrderFill(order, fillPrice) {
    if (!order.instrument || !order.quantity || !order.side) {
      logger.warn("Invalid order for position update", { orderId: order.id });
      return;
    }

    const updated = await this.updatePosition(
      order.instrument,
      order.quantity,
      fillPrice,
      order.side,
    );

    logger.info("Position updated", {
      clientId: this.clientId,
      instrument: order.instrument,
      position: updated.position,
      averagePrice: updated.averagePrice,
    });

    return updated;
  }

  async closePosition(instrument) {
    const position = this.positions.get(instrument);
    if (!position) return null;

    this.positions.delete(instrument);

    if (this.clientId) {
      await query(
        "DELETE FROM positions WHERE client_id = $1 AND instrument = $2",
        [this.clientId, instrument],
      );
    }

    return position;
  }

  getTotalPositions() {
    return this.positions.size;
  }

  clear() {
    this.positions.clear();
  }
}

const positionTrackers = new Map();

function getPositionTracker(clientId) {
  if (!clientId) {
    throw new Error("clientId is required");
  }

  if (!positionTrackers.has(clientId)) {
    const tracker = new PositionTracker();
    positionTrackers.set(clientId, tracker);
  }
  return positionTrackers.get(clientId);
}

module.exports = {
  PositionTracker,
  getPositionTracker,
};
