const { logger } = require("../../../packages/core/logger/logger");
const { query } = require("../../../packages/database/postgresClient");

const MARGIN_REQUIREMENTS = {
  CASHANDCARRY: 0.2,
  INTRADAY: 0.1,
  DELIVERY: 0.25,
  OPTION_SELLING: 0.15,
  OPTION_BUYING: 0.1,
  FUTURES: 0.15,
};

class MarginTracker {
  constructor(clientId = null) {
    this.clientId = clientId;
    this.totalMargin = 0;
    this.usedMargin = 0;
    this.availableMargin = 0;
    this.positions = new Map();
    this.pendingOrders = new Map();
  }

  async initialize(clientId) {
    this.clientId = clientId;
    await this.loadFromDatabase();
    logger.info("MarginTracker initialized", { clientId });
  }

  async loadFromDatabase() {
    if (!this.clientId) return;

    try {
      const result = await query(
        `SELECT available_margin, used_margin FROM client_accounts WHERE client_id = $1`,
        [this.clientId],
      );

      if (result.rows.length > 0) {
        this.availableMargin = parseFloat(result.rows[0].available_margin) || 0;
        this.usedMargin = parseFloat(result.rows[0].used_margin) || 0;
        this.totalMargin = this.availableMargin + this.usedMargin;
      }

      const positionsResult = await query(
        `SELECT instrument, position FROM positions WHERE client_id = $1`,
        [this.clientId],
      );

      for (const row of positionsResult.rows) {
        this.positions.set(row.instrument, {
          instrument: row.instrument,
          position: parseInt(row.position),
        });
      }
    } catch (error) {
      logger.error("Failed to load margin data", {
        clientId: this.clientId,
        error: error.message,
      });
    }
  }

  calculatePositionMargin(
    position,
    currentPrice,
    productType = "CASHANDCARRY",
  ) {
    const marginPercent = MARGIN_REQUIREMENTS[productType] || 0.2;
    const positionValue = Math.abs(position) * currentPrice;
    return positionValue * marginPercent;
  }

  calculateOrderMargin(order) {
    const { quantity, price, productType = "CASHANDCARRY" } = order;
    const marginPercent = MARGIN_REQUIREMENTS[productType] || 0.2;
    return quantity * price * marginPercent;
  }

  async reserveMargin(order) {
    const requiredMargin = this.calculateOrderMargin(order);

    if (requiredMargin > this.availableMargin) {
      logger.warn("Insufficient margin", {
        clientId: this.clientId,
        required: requiredMargin,
        available: this.availableMargin,
      });
      return { success: false, reason: "insufficient_margin" };
    }

    this.usedMargin += requiredMargin;
    this.availableMargin -= requiredMargin;
    this.totalMargin = this.availableMargin + this.usedMargin;
    this.pendingOrders.set(order.id || `temp_${Date.now()}`, {
      orderId: order.id,
      margin: requiredMargin,
      timestamp: Date.now(),
    });

    return { success: true, reserved: requiredMargin };
  }

  async releaseMargin(orderId) {
    const pending = this.pendingOrders.get(orderId);
    if (!pending) return;

    this.usedMargin -= pending.margin;
    this.availableMargin += pending.margin;
    this.totalMargin = this.availableMargin + this.usedMargin;
    this.pendingOrders.delete(orderId);

    await this.saveToDatabase();
  }

  async onOrderFill(order, fillPrice) {
    const orderMargin = this.pendingOrders.get(order.id);

    if (orderMargin) {
      this.pendingOrders.delete(order.id);
    }

    const positionMargin = this.calculatePositionMargin(
      order.side === "BUY" ? order.quantity : -order.quantity,
      fillPrice,
      order.productType || "CASHANDCARRY",
    );

    const previousPosition = this.positions.get(order.instrument);
    let previousMargin = 0;

    if (previousPosition) {
      previousMargin = this.calculatePositionMargin(
        previousPosition.position,
        previousPosition.averagePrice || fillPrice,
        order.productType || "CASHANDCARRY",
      );
    }

    const netMarginChange = positionMargin - previousMargin;
    this.usedMargin += netMarginChange;
    this.availableMargin -= netMarginChange;
    this.totalMargin = this.availableMargin + this.usedMargin;

    this.positions.set(order.instrument, {
      instrument: order.instrument,
      position:
        order.side === "BUY"
          ? (previousPosition?.position || 0) + order.quantity
          : (previousPosition?.position || 0) - order.quantity,
      averagePrice: fillPrice,
    });

    await this.saveToDatabase();

    logger.info("Margin updated on order fill", {
      clientId: this.clientId,
      orderId: order.id,
      usedMargin: this.usedMargin,
      availableMargin: this.availableMargin,
    });
  }

  getMarginSummary() {
    return {
      total: this.totalMargin,
      used: this.usedMargin,
      available: this.availableMargin,
      utilizationPercent:
        this.totalMargin > 0 ? (this.usedMargin / this.totalMargin) * 100 : 0,
    };
  }

  checkMarginAvailable(order) {
    const required = this.calculateOrderMargin(order);
    return {
      available: this.availableMargin >= required,
      required,
      availableMargin: this.availableMargin,
      shortfall: Math.max(0, required - this.availableMargin),
    };
  }

  async saveToDatabase() {
    if (!this.clientId) return;

    try {
      await query(
        `UPDATE client_accounts 
         SET available_margin = $1, used_margin = $2, updated_at = NOW()
         WHERE client_id = $3`,
        [this.availableMargin, this.usedMargin, this.clientId],
      );
    } catch (error) {
      logger.error("Failed to save margin data", {
        clientId: this.clientId,
        error: error.message,
      });
    }
  }

  async syncWithBroker() {
    if (!this.clientId) return;

    try {
      const { getBrokerAPI } = require("../../../packages/broker-adapters/angel-one/angelOneBroker");
      const brokerAPI = getBrokerAPI();

      if (!brokerAPI.isConnected) {
        logger.warn("Broker not connected for margin sync", {
          clientId: this.clientId,
        });
        return;
      }

      const rms = await brokerAPI.getRMS();

      if (rms.success && rms.rms) {
        this.availableMargin = parseFloat(rms.rms.available_margin || 0);
        this.usedMargin = parseFloat(rms.rms.used_margin || 0);
        this.totalMargin = this.availableMargin + this.usedMargin;

        await this.saveToDatabase();

        logger.info("Margin synced with broker", {
          clientId: this.clientId,
          available: this.availableMargin,
          used: this.usedMargin,
        });
      }
    } catch (error) {
      logger.error("Failed to sync margin with broker", {
        clientId: this.clientId,
        error: error.message,
      });
    }
  }
}

const marginTrackers = new Map();

function getMarginTracker(clientId) {
  if (!clientId) {
    throw new Error("clientId is required");
  }

  if (!marginTrackers.has(clientId)) {
    marginTrackers.set(clientId, new MarginTracker(clientId));
  }
  return marginTrackers.get(clientId);
}

module.exports = {
  MarginTracker,
  getMarginTracker,
  MARGIN_REQUIREMENTS,
};
