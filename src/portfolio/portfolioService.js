const { logger } = require("../core/logger/logger");
const { getPositionTracker } = require("./positionTracker");
const { getPnLCalculator } = require("./pnlCalculator");
const { getMarginTracker } = require("./marginTracker");

class PortfolioService {
  constructor(clientId) {
    this.clientId = clientId;
    this.positionTracker = getPositionTracker(clientId);
    this.pnlCalculator = getPnLCalculator(clientId);
    this.marginTracker = getMarginTracker(clientId);
    this.currentPrices = new Map();
  }

  async initialize() {
    await this.positionTracker.initialize(this.clientId);
    await this.marginTracker.initialize(this.clientId);
    logger.info("PortfolioService initialized", { clientId: this.clientId });
  }

  updatePrice(instrument, price) {
    this.currentPrices.set(instrument, price);
  }

  async onOrderFilled(order, fillPrice) {
    await this.positionTracker.handleOrderFill(order, fillPrice);
    await this.marginTracker.onOrderFill(order, fillPrice);
    this.pnlCalculator.onTrade({
      side: order.side,
      quantity: order.quantity,
      price: fillPrice,
    });

    logger.info("Portfolio updated on order fill", {
      clientId: this.clientId,
      orderId: order.id,
      instrument: order.instrument,
    });
  }

  getPositions() {
    const positions = this.positionTracker.getAllPositions();

    return positions.map((pos) => {
      const currentPrice =
        this.currentPrices.get(pos.instrument) || pos.averagePrice;
      const marketValue = Math.abs(pos.position) * currentPrice;
      const pnl =
        pos.position > 0
          ? (currentPrice - pos.averagePrice) * pos.position
          : (pos.averagePrice - currentPrice) * Math.abs(pos.position);

      return {
        ...pos,
        currentPrice,
        marketValue,
        pnl,
        pnlPercent:
          pos.averagePrice > 0
            ? ((currentPrice - pos.averagePrice) / pos.averagePrice) * 100
            : 0,
      };
    });
  }

  getPnL() {
    const positions = {};
    for (const [instrument, pos] of this.positionTracker.positions) {
      positions[instrument] = pos;
    }

    const currentPrices = {};
    for (const [instrument, price] of this.currentPrices) {
      currentPrices[instrument] = price;
    }

    const unrealized = this.pnlCalculator.calculateUnrealizedPnL(
      positions,
      currentPrices,
    );
    const daily = this.pnlCalculator.getDailyStats();

    return {
      unrealizedPnL: unrealized,
      realizedPnL: daily.realizedPnL,
      totalPnL: unrealized + daily.realizedPnL,
      dailyTrades: daily.trades,
      dailyVolume: daily.volume,
    };
  }

  getMargin() {
    return this.marginTracker.getMarginSummary();
  }

  async getFullPortfolio() {
    return {
      clientId: this.clientId,
      positions: this.getPositions(),
      pnl: this.getPnL(),
      margin: this.getMargin(),
      timestamp: new Date().toISOString(),
    };
  }

  async createSnapshot() {
    const positions = {};
    for (const [instrument, pos] of this.positionTracker.positions) {
      positions[instrument] = pos;
    }

    const currentPrices = {};
    for (const [instrument, price] of this.currentPrices) {
      currentPrices[instrument] = price;
    }

    await this.pnlCalculator.recordPnLSnapshot(
      this.clientId,
      positions,
      currentPrices,
    );
  }
}

const portfolioServices = new Map();

function getPortfolioService(clientId) {
  if (!clientId) {
    throw new Error("clientId is required");
  }

  if (!portfolioServices.has(clientId)) {
    portfolioServices.set(clientId, new PortfolioService(clientId));
  }
  return portfolioServices.get(clientId);
}

module.exports = {
  PortfolioService,
  getPortfolioService,
};
