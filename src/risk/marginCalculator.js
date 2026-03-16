const { logger } = require("../core/logger/logger");
const config = require("../../config/default");

const MARGIN_REQUIREMENTS = {
  CASHANDCARRY: 0.2,
  INTRADAY: 0.1,
  DELIVERY: 0.25,
  OPTION_SELLING: 0.15,
  OPTION_BUYING: 0.1,
  FUTURES: 0.15,
};

const BROKERAGE_PERCENT = 0.001;

class MarginCalculator {
  constructor(options = {}) {
    this.marginRequirements = {
      ...MARGIN_REQUIREMENTS,
      ...options.marginRequirements,
    };
    this.clientMargins = new Map();
  }

  calculateOrderMargin(order) {
    const { quantity, price, productType, side } = order;

    const marginPercent = this.marginRequirements[productType] || 0.2;
    const baseMargin = quantity * price * marginPercent;

    const brokerage = quantity * price * BROKERAGE_PERCENT;
    const estimatedLoss = side === "BUY" ? 0 : quantity * price * 0.1;

    const totalMargin = baseMargin + brokerage + estimatedLoss;

    return {
      baseMargin,
      brokerage,
      estimatedLoss,
      totalMargin,
      marginPercent,
    };
  }

  calculateOptionMargin(optionType, strikePrice, quantity, premium) {
    if (optionType === "BUY") {
      return {
        premiumPaid: quantity * premium,
        totalMargin: quantity * premium,
        marginPercent: MARGIN_REQUIREMENTS.OPTION_BUYING,
      };
    }

    const spann = strikePrice * 0.03;
    const shortOptionMargin = strikePrice * 0.15 + quantity * premium;
    const totalMargin = Math.max(spann * quantity, shortOptionMargin);

    return {
      premiumReceived: quantity * premium,
      shortOptionMargin,
      spann,
      totalMargin,
      marginPercent: MARGIN_REQUIREMENTS.OPTION_SELLING,
    };
  }

  calculateFuturesMargin(futuresPrice, quantity, contractSize = 75) {
    const marginPercent = this.marginRequirements.FUTURES;
    const contractValue = futuresPrice * contractSize * quantity;
    const margin = contractValue * marginPercent;

    return {
      contractValue,
      margin,
      marginPercent,
      contractSize,
    };
  }

  getTotalRequiredMargin(orders) {
    let totalMargin = 0;
    const breakdown = [];

    for (const order of orders) {
      const margin = this.calculateOrderMargin(order);
      totalMargin += margin.totalMargin;
      breakdown.push({
        orderId: order.id,
        instrument: order.instrument,
        margin: margin.totalMargin,
      });
    }

    return { totalMargin, breakdown };
  }

  checkMarginAvailability(clientId, order) {
    const availableMargin =
      this.clientMargins.get(clientId) || config.risk?.defaultMargin || 1000000;
    const orderMargin = this.calculateOrderMargin(order);

    return {
      available: availableMargin >= orderMargin.totalMargin,
      availableMargin,
      requiredMargin: orderMargin.totalMargin,
      shortfall: Math.max(0, orderMargin.totalMargin - availableMargin),
    };
  }

  reserveMargin(clientId, amount) {
    const current =
      this.clientMargins.get(clientId) || config.risk?.defaultMargin || 1000000;
    this.clientMargins.set(clientId, current - amount);

    logger.debug("Margin reserved", {
      clientId,
      amount,
      remaining: this.clientMargins.get(clientId),
    });
  }

  releaseMargin(clientId, amount) {
    const current = this.clientMargins.get(clientId) || 0;
    const max = config.risk?.defaultMargin || 1000000;
    this.clientMargins.set(clientId, Math.min(current + amount, max));

    logger.debug("Margin released", {
      clientId,
      amount,
      available: this.clientMargins.get(clientId),
    });
  }

  setClientMargin(clientId, amount) {
    this.clientMargins.set(clientId, amount);
    logger.info("Client margin set", { clientId, amount });
  }

  getClientMargin(clientId) {
    return (
      this.clientMargins.get(clientId) || config.risk?.defaultMargin || 1000000
    );
  }

  async loadClientMarginsFromDatabase(clientId) {
    try {
      const { query } = require("../database/postgresClient");
      const result = await query(
        `SELECT available_margin FROM client_accounts WHERE client_id = $1`,
        [clientId],
      );

      if (result.rows.length > 0) {
        this.setClientMargin(
          clientId,
          parseFloat(result.rows[0].available_margin),
        );
      }
    } catch (error) {
      logger.error("Failed to load client margins", {
        clientId,
        error: error.message,
      });
    }
  }
}

let marginCalculatorInstance = null;

function getMarginCalculator() {
  if (!marginCalculatorInstance) {
    marginCalculatorInstance = new MarginCalculator();
  }
  return marginCalculatorInstance;
}

module.exports = {
  MarginCalculator,
  getMarginCalculator,
  MARGIN_REQUIREMENTS,
};
