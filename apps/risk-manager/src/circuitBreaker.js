const { logger } = require("../../../packages/core/logger/logger");
const { formatIST } = require("../../../packages/core/utils/time");

const CIRCUIT_STATES = {
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
};

const TRIGGER_REASONS = {
  CONSECUTIVE_LOSSES: "consecutive_losses",
  DAILY_LOSS_LIMIT: "daily_loss_limit",
  EXCESSIVE_DRAWDOWN: "excessive_drawdown",
  MARGIN_CALL: "margin_call",
  MANUAL: "manual",
};

class CircuitBreaker {
  constructor(options = {}) {
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;

    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeoutDuration = options.timeoutDuration || 60000;

    this.state = CIRCUIT_STATES.CLOSED;
    this.triggerReason = null;
    this.triggeredAt = null;
    this.autoReset = options.autoReset !== false;
  }

  async executeOperation(operation) {
    if (this.state === CIRCUIT_STATES.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CIRCUIT_STATES.HALF_OPEN;
        logger.info("Circuit breaker entering half-open state");
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.successCount++;
    this.failureCount = 0;

    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      if (this.successCount >= this.successThreshold) {
        this.reset();
      }
    }
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;

    if (this.failureCount >= this.failureThreshold) {
      this.trigger(TRIGGER_REASONS.CONSECUTIVE_LOSSES);
    }
  }

  shouldAttemptReset() {
    if (!this.lastFailureTime) return true;
    return Date.now() - this.lastFailureTime >= this.timeoutDuration;
  }

  trigger(reason) {
    this.state = CIRCUIT_STATES.OPEN;
    this.triggerReason = reason;
    this.triggeredAt = formatIST();

    logger.error("Circuit breaker triggered", {
      reason,
      failureCount: this.failureCount,
      threshold: this.failureThreshold,
    });
  }

  reset() {
    this.state = CIRCUIT_STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.triggerReason = null;
    this.triggeredAt = null;

    logger.info("Circuit breaker reset");
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      triggerReason: this.triggerReason,
      triggeredAt: this.triggeredAt,
    };
  }

  isOpen() {
    return this.state === CIRCUIT_STATES.OPEN;
  }

  isHalfOpen() {
    return this.state === CIRCUIT_STATES.HALF_OPEN;
  }
}

class RiskCircuitBreaker {
  constructor(options = {}) {
    this.circuitBreakers = new Map();
    this.globalCircuit = new CircuitBreaker({
      failureThreshold: options.globalFailureThreshold || 10,
      timeoutDuration: options.globalTimeout || 300000,
    });
  }

  getCircuit(circuitId) {
    if (!this.circuitBreakers.has(circuitId)) {
      this.circuitBreakers.set(circuitId, new CircuitBreaker());
    }
    return this.circuitBreakers.get(circuitId);
  }

  async execute(circuitId, operation) {
    const circuit = this.getCircuit(circuitId);
    return circuit.executeOperation(operation);
  }

  triggerCircuit(circuitId, reason) {
    const circuit = this.getCircuit(circuitId);
    circuit.trigger(reason);
  }

  resetCircuit(circuitId) {
    const circuit = this.circuitBreakers.get(circuitId);
    if (circuit) {
      circuit.reset();
    }
  }

  resetAll() {
    for (const circuit of this.circuitBreakers.values()) {
      circuit.reset();
    }
    this.globalCircuit.reset();
  }

  getAllStates() {
    const states = {};
    for (const [id, circuit] of this.circuitBreakers.entries()) {
      states[id] = circuit.getState();
    }
    states.global = this.globalCircuit.getState();
    return states;
  }

  triggerGlobal(reason) {
    this.globalCircuit.trigger(reason);
  }

  isGlobalOpen() {
    return this.globalCircuit.isOpen();
  }
}

let circuitBreakerInstance = null;

function getCircuitBreaker() {
  if (!circuitBreakerInstance) {
    circuitBreakerInstance = new RiskCircuitBreaker();
  }
  return circuitBreakerInstance;
}

module.exports = {
  CircuitBreaker,
  RiskCircuitBreaker,
  getCircuitBreaker,
  CIRCUIT_STATES,
  TRIGGER_REASONS,
};
