const { logger } = require('../../core/logger/logger');

const ORDER_STATES = {
  CREATED: 'created',
  VALIDATED: 'validated',
  QUEUED: 'queued',
  SENT_TO_BROKER: 'sent_to_broker',
  ACKNOWLEDGED: 'acknowledged',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  FAILED: 'failed'
};

const ORDER_EVENTS = {
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_VALIDATED: 'ORDER_VALIDATED',
  ORDER_QUEUED: 'ORDER_QUEUED',
  ORDER_SENT: 'ORDER_SENT',
  ORDER_ACKNOWLEDGED: 'ORDER_ACKNOWLEDGED',
  ORDER_PARTIALLY_FILLED: 'ORDER_PARTIALLY_FILLED',
  ORDER_FILLED: 'ORDER_FILLED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_FAILED: 'ORDER_FAILED'
};

const STATE_TRANSITIONS = {
  [ORDER_STATES.CREATED]: [ORDER_STATES.VALIDATED, ORDER_STATES.REJECTED],
  [ORDER_STATES.VALIDATED]: [ORDER_STATES.QUEUED, ORDER_STATES.REJECTED],
  [ORDER_STATES.QUEUED]: [ORDER_STATES.SENT_TO_BROKER],
  [ORDER_STATES.SENT_TO_BROKER]: [ORDER_STATES.ACKNOWLEDGED, ORDER_STATES.FAILED, ORDER_STATES.REJECTED],
  [ORDER_STATES.ACKNOWLEDGED]: [ORDER_STATES.PARTIALLY_FILLED, ORDER_STATES.FILLED, ORDER_STATES.REJECTED, ORDER_STATES.CANCELLED],
  [ORDER_STATES.PARTIALLY_FILLED]: [ORDER_STATES.FILLED, ORDER_STATES.REJECTED, ORDER_STATES.CANCELLED],
  [ORDER_STATES.FILLED]: [],
  [ORDER_STATES.REJECTED]: [],
  [ORDER_STATES.CANCELLED]: [],
  [ORDER_STATES.FAILED]: []
};

class OrderStateMachine {
  constructor() {
    this.currentState = ORDER_STATES.CREATED;
    this.eventHistory = [];
  }

  canTransition(newState) {
    const allowedTransitions = STATE_TRANSITIONS[this.currentState] || [];
    return allowedTransitions.includes(newState);
  }

  transition(newState, eventData = {}) {
    if (!this.canTransition(newState)) {
      const error = new Error(`Invalid state transition from ${this.currentState} to ${newState}`);
      logger.warn('Invalid state transition', {
        currentState: this.currentState,
        targetState: newState,
        allowed: STATE_TRANSITIONS[this.currentState]
      });
      throw error;
    }

    const oldState = this.currentState;
    this.currentState = newState;

    const event = {
      from: oldState,
      to: newState,
      data: eventData,
      timestamp: new Date().toISOString()
    };

    this.eventHistory.push(event);

    logger.info('Order state transitioned', {
      oldState,
      newState,
      eventData
    });

    return event;
  }

  getState() {
    return this.currentState;
  }

  getEventHistory() {
    return [...this.eventHistory];
  }

  isTerminalState() {
    return [
      ORDER_STATES.FILLED,
      ORDER_STATES.REJECTED,
      ORDER_STATES.CANCELLED,
      ORDER_STATES.FAILED
    ].includes(this.currentState);
  }

  isActive() {
    return !this.isTerminalState();
  }

  static getInitialState() {
    return ORDER_STATES.CREATED;
  }

  static getValidStates() {
    return Object.values(ORDER_STATES);
  }

  static getValidEvents() {
    return Object.values(ORDER_EVENTS);
  }
}

module.exports = {
  OrderStateMachine,
  ORDER_STATES,
  ORDER_EVENTS,
  STATE_TRANSITIONS
};
