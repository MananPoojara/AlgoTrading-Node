const { logger } = require("../../../packages/core/logger/logger");
const { query } = require("../../../packages/database/postgresClient");
const config = require("../../../config/default");
const {
  calculateNextPositionState,
} = require("../../order-manager/src/paperPortfolioWriter");

const RISK_LIMITS = {
  MAX_POSITION_SIZE: "max_position_size",
  MAX_DAILY_LOSS: "max_daily_loss",
  MAX_EXPOSURE: "max_exposure",
  MAX_MARGIN_USAGE: "max_margin_usage",
  MAX_OPEN_ORDERS: "max_open_orders",
};

class RiskManager {
  constructor(options = {}) {
    this.clientId = options.clientId || null;
    this.limits = options.limits || this.getDefaultLimits();
    this.policyMode = options.policyMode || config.risk?.policyMode || "live_enforce";
    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.dailyLoss = 0;
    this.circuitBreakerTriggered = false;
    this.lastReset = new Date().toDateString();
    this.positions = new Map();
    this.openOrders = new Map();
    this.exposure = new Map();
  }

  getDefaultLimits() {
    return {
      [RISK_LIMITS.MAX_POSITION_SIZE]: config.risk?.maxPositionSize || 1000000,
      [RISK_LIMITS.MAX_DAILY_LOSS]: config.risk?.maxDailyLoss || 50000,
      [RISK_LIMITS.MAX_EXPOSURE]: config.risk?.maxExposure || 5000000,
      [RISK_LIMITS.MAX_MARGIN_USAGE]: config.risk?.maxMarginUsage || 0.8,
      [RISK_LIMITS.MAX_OPEN_ORDERS]: config.risk?.maxOpenOrders || 10,
    };
  }

  checkDailyReset() {
    const today = new Date().toDateString();
    if (this.lastReset !== today) {
      this.dailyPnL = 0;
      this.dailyTrades = 0;
      this.dailyLoss = 0;
      this.lastReset = today;
      logger.info("Risk manager daily metrics reset");
    }
  }

  async checkSignal(signal, options = {}) {
    const isRiskReducingExit = options.isRiskReducingExit === true;
    const warnings = [];

    if (!signal || typeof signal !== "object") {
      return {
        allowed: false,
        decision: "hard_block",
        reason: "invalid_signal",
        details: "Signal is null or not an object",
      };
    }

    if (!signal.instrument) {
      return {
        allowed: false,
        decision: "hard_block",
        reason: "invalid_signal",
        details: "Missing instrument",
      };
    }

    if (!signal.action || !["BUY", "SELL"].includes(signal.action)) {
      return {
        allowed: false,
        decision: "hard_block",
        reason: "invalid_signal",
        details: "Invalid or missing action",
      };
    }

    if (!signal.quantity || signal.quantity <= 0) {
      return {
        allowed: false,
        decision: "hard_block",
        reason: "invalid_signal",
        details: "Invalid or missing quantity",
      };
    }

    this.checkDailyReset();

    if (this.circuitBreakerTriggered && !isRiskReducingExit) {
      const breakerFailure = {
        allowed: false,
        reason: "circuit_breaker_triggered",
        details: { clientId: this.clientId },
      };

      warnings.push(breakerFailure);
    }

    const checks = [
      await this.checkPositionLimit(signal, { isRiskReducingExit }),
      await this.checkExposureLimit(signal, { isRiskReducingExit }),
      await this.checkDailyLossLimit({ isRiskReducingExit }),
      await this.checkOpenOrdersLimit(),
      await this.checkMarginSufficiency(signal, { isRiskReducingExit }),
    ];

    const failedChecks = checks.filter((check) => !check.allowed);
    if (failedChecks.length > 0) {
      warnings.push(...failedChecks);
    }

    if (warnings.length > 0) {
      if (this.policyMode === "paper_warn_only") {
        logger.warn("Signal allowed with risk warnings", {
          clientId: this.clientId,
          warnings: warnings.map((warning) => ({
            reason: warning.reason,
            details: warning.details,
          })),
        });
        return {
          allowed: true,
          decision: "soft_warn",
          warnings,
        };
      }

      if (this.policyMode === "live_enforce") {
        logger.warn("Signal requires operator approval", {
          clientId: this.clientId,
          warnings: warnings.map((warning) => ({
            reason: warning.reason,
            details: warning.details,
          })),
        });
        return {
          allowed: false,
          decision: "soft_warn",
          requiresApproval: true,
          warnings,
        };
      }

      logger.warn("Signal allowed with risk warnings", {
        clientId: this.clientId,
        warnings: warnings.map((warning) => ({
          reason: warning.reason,
          details: warning.details,
        })),
      });
      return {
        allowed: false,
        decision: "soft_warn",
        reason: warnings[0]?.reason || "risk_threshold_exceeded",
        warnings,
      };
    }

    return { allowed: true, decision: "allow" };
  }

  async checkPositionLimit(signal, options = {}) {
    if (options.isRiskReducingExit) {
      return { allowed: true };
    }

    const maxPosition = this.limits[RISK_LIMITS.MAX_POSITION_SIZE];
    const instrument = signal.instrument;

    const currentPosition = Number(
      this.positions.get(instrument)?.position || 0,
    );
    const newPosition =
      signal.action === "BUY"
        ? currentPosition + signal.quantity
        : currentPosition - signal.quantity;

    if (Math.abs(newPosition * (signal.price || 0)) > maxPosition) {
      return {
        allowed: false,
        reason: "position_limit_exceeded",
        details: {
          current: currentPosition,
          requested: signal.quantity,
          limit: maxPosition,
        },
      };
    }

    return { allowed: true };
  }

  async checkExposureLimit(signal, options = {}) {
    if (options.isRiskReducingExit) {
      return { allowed: true };
    }

    const maxExposure = this.limits[RISK_LIMITS.MAX_EXPOSURE];

    let totalExposure = 0;
    for (const [instrument, positionState] of this.positions) {
      const quantity = Number(positionState?.position || 0);
      const referencePrice =
        Number(positionState?.average_price || 0) || Number(signal.price || 0);
      totalExposure += Math.abs(quantity * referencePrice);
    }

    const newExposure = totalExposure + signal.quantity * (signal.price || 0);

    if (newExposure > maxExposure) {
      return {
        allowed: false,
        reason: "exposure_limit_exceeded",
        details: {
          current: totalExposure,
          requested: signal.quantity * (signal.price || 0),
          limit: maxExposure,
        },
      };
    }

    return { allowed: true };
  }

  async checkDailyLossLimit(options = {}) {
    if (options.isRiskReducingExit) {
      return { allowed: true };
    }

    const maxDailyLoss = this.limits[RISK_LIMITS.MAX_DAILY_LOSS];

    if (this.dailyLoss >= maxDailyLoss) {
      this.triggerCircuitBreaker("daily_loss_limit");
      return {
        allowed: false,
        reason: "daily_loss_limit_exceeded",
        details: { dailyLoss: this.dailyLoss, limit: maxDailyLoss },
      };
    }

    return { allowed: true };
  }

  async checkOpenOrdersLimit() {
    const maxOpenOrders = this.limits[RISK_LIMITS.MAX_OPEN_ORDERS];

    if (this.openOrders.size >= maxOpenOrders) {
      return {
        allowed: false,
        reason: "open_orders_limit_exceeded",
        details: { current: this.openOrders.size, limit: maxOpenOrders },
      };
    }

    return { allowed: true };
  }

  async checkMarginSufficiency(signal, options = {}) {
    if (options.isRiskReducingExit) {
      return { allowed: true };
    }

    const maxMarginUsage = this.limits[RISK_LIMITS.MAX_MARGIN_USAGE];

    const requiredMargin = signal.quantity * (signal.price || 0) * 0.2;
    const availableMargin = this.getAvailableMargin();

    if (requiredMargin > availableMargin * (1 - maxMarginUsage)) {
      return {
        allowed: false,
        reason: "insufficient_margin",
        details: { required: requiredMargin, available: availableMargin },
      };
    }

    return { allowed: true };
  }

  getAvailableMargin() {
    return config.risk?.availableMargin || 1000000;
  }

  async onOrderFilled(order, fillPrice) {
    const instrument = order.instrument;
    const currentState = this.positions.get(instrument) || {
      position: 0,
      average_price: 0,
      realized_pnl: 0,
    };
    const nextState = calculateNextPositionState(
      currentState,
      order.side,
      order.quantity,
      fillPrice,
    );

    this.positions.set(instrument, {
      position: nextState.position,
      average_price: nextState.averagePrice,
      realized_pnl: nextState.realizedPnL,
    });

    const realizedDelta = Number(nextState.realizedDelta || 0);

    this.dailyPnL += realizedDelta;
    this.dailyTrades++;
    this.dailyLoss = Math.max(0, -this.dailyPnL);

    if (this.openOrders.has(order.id)) {
      this.openOrders.delete(order.id);
    }

    logger.info("Risk metrics updated", {
      clientId: this.clientId,
      instrument,
      position: this.positions.get(instrument)?.position || 0,
      dailyPnL: this.dailyPnL,
      dailyLoss: this.dailyLoss,
    });
  }

  onOrderPlaced(orderId, order) {
    this.openOrders.set(orderId, order);
  }

  onOrderCancelled(orderId) {
    this.openOrders.delete(orderId);
  }

  getPositions() {
    return Object.fromEntries(
      Array.from(this.positions.entries()).map(([instrument, positionState]) => [
        instrument,
        positionState?.position || 0,
      ]),
    );
  }

  getMetrics() {
    return {
      dailyPnL: this.dailyPnL,
      dailyTrades: this.dailyTrades,
      dailyLoss: this.dailyLoss,
      openOrders: this.openOrders.size,
      positions: this.getPositions(),
      circuitBreakerTriggered: this.circuitBreakerTriggered,
    };
  }

  triggerCircuitBreaker(reason) {
    this.circuitBreakerTriggered = true;
    logger.error("Circuit breaker triggered", {
      clientId: this.clientId,
      reason,
      dailyLoss: this.dailyLoss,
    });
  }

  resetCircuitBreaker() {
    this.circuitBreakerTriggered = false;
    logger.info("Circuit breaker reset", { clientId: this.clientId });
  }

  async loadFromDatabase() {
    if (!this.clientId) return;

    try {
      const result = await query(
        `SELECT position, instrument, average_price, realized_pnl
         FROM positions WHERE client_id = $1`,
        [this.clientId],
      );

      for (const row of result.rows) {
        this.positions.set(row.instrument, {
          position: parseInt(row.position, 10) || 0,
          average_price: parseFloat(row.average_price || 0),
          realized_pnl: parseFloat(row.realized_pnl || 0),
        });
      }

      const ordersResult = await query(
        `SELECT id, quantity, side, instrument FROM orders 
         WHERE client_id = $1 AND status NOT IN ('filled', 'rejected', 'cancelled', 'failed')`,
        [this.clientId],
      );

      for (const row of ordersResult.rows) {
        this.openOrders.set(row.id, row);
      }

      this.dailyPnL = 0;
      this.dailyLoss = 0;

      logger.info("Risk manager loaded from database", {
        clientId: this.clientId,
        positions: this.positions.size,
        openOrders: this.openOrders.size,
        policyMode: this.policyMode,
      });
    } catch (error) {
      logger.error("Failed to load risk data from database", {
        clientId: this.clientId,
        error: error.message,
      });
    }
  }

  updateLimit(limitType, value) {
    if (this.limits.hasOwnProperty(limitType)) {
      this.limits[limitType] = value;
      logger.info("Risk limit updated", {
        clientId: this.clientId,
        limitType,
        value,
      });
    }
  }
}

const riskManagers = new Map();

function getRiskManager(clientId, options = {}) {
  if (!clientId) {
    throw new Error("clientId is required for RiskManager");
  }

  if (!riskManagers.has(clientId)) {
    riskManagers.set(clientId, new RiskManager({ ...options, clientId }));
  }
  return riskManagers.get(clientId);
}

function createRiskManager(options = {}) {
  return new RiskManager(options);
}

function clearRiskManager(clientId) {
  if (clientId) {
    riskManagers.delete(clientId);
  } else {
    riskManagers.clear();
  }
}

module.exports = {
  RiskManager,
  getRiskManager,
  createRiskManager,
  clearRiskManager,
  RISK_LIMITS,
};
