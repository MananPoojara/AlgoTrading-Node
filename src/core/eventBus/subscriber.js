const { getRedisClient } = require('./redisClient');
const { logger } = require('../logger/logger');
const { CHANNELS } = require('./publisher');

class EventSubscriber {
  constructor(redisClient = null) {
    this.redisClient = redisClient || getRedisClient();
    this.subscriber = this.redisClient.getSubscriber();
    this.handlers = new Map();
    this.subscriptions = new Set();
    this.messageHandlerInitialized = false;
    
    this.setupMessageHandler();
  }

  setupMessageHandler() {
    if (this.messageHandlerInitialized) return;
    
    this.subscriber.on('message', (channel, message) => {
      const handlers = this.handlers.get(channel) || [];
      
      if (handlers.length === 0) {
        logger.debug(`No handler for channel: ${channel}`);
        return;
      }

      try {
        const data = JSON.parse(message);
        handlers.forEach((handler) => handler(data));
      } catch {
        handlers.forEach((handler) => handler(message));
      }
    });
    
    this.messageHandlerInitialized = true;
  }

  async subscribe(channel, handler) {
    const existingHandlers = this.handlers.get(channel) || [];
    if (existingHandlers.includes(handler)) {
      logger.warn(`Handler already subscribed to channel: ${channel}`);
      return;
    }

    try {
      if (!this.subscriptions.has(channel)) {
      await this.subscriber.subscribe(channel);
      this.subscriptions.add(channel);
      }
      this.handlers.set(channel, [...existingHandlers, handler]);

      logger.info(`Subscribed to channel: ${channel}`);
    } catch (error) {
      logger.error(`Failed to subscribe to channel: ${channel}`, { 
        error: error.message 
      });
      throw error;
    }
  }

  async unsubscribe(channel) {
    if (!this.subscriptions.has(channel)) {
      return;
    }

    try {
      await this.subscriber.unsubscribe(channel);
      this.subscriptions.delete(channel);
      this.handlers.delete(channel);
      logger.info(`Unsubscribed from channel: ${channel}`);
    } catch (error) {
      logger.error(`Failed to unsubscribe from channel: ${channel}`, { 
        error: error.message 
      });
      throw error;
    }
  }

  async unsubscribeHandler(channel, handler) {
    const handlers = this.handlers.get(channel) || [];
    const remainingHandlers = handlers.filter((candidate) => candidate !== handler);

    if (remainingHandlers.length === handlers.length) {
      return;
    }

    if (remainingHandlers.length === 0) {
      await this.unsubscribe(channel);
      return;
    }

    this.handlers.set(channel, remainingHandlers);
  }

  async subscribeToMarketTicks(handler) {
    await this.subscribe(CHANNELS.MARKET_TICKS, handler);
  }

  async subscribeToStrategySignals(handler) {
    await this.subscribe(CHANNELS.STRATEGY_SIGNALS, handler);
  }

  async subscribeToOrderRequests(handler) {
    await this.subscribe(CHANNELS.ORDER_REQUESTS, handler);
  }

  async subscribeToValidatedOrders(handler) {
    await this.subscribe(CHANNELS.VALIDATED_ORDERS, handler);
  }

  async subscribeToRejectedOrders(handler) {
    await this.subscribe(CHANNELS.REJECTED_ORDERS, handler);
  }

  async subscribeToBrokerResponses(handler) {
    await this.subscribe(CHANNELS.BROKER_RESPONSES, handler);
  }

  async subscribeToTradeEvents(handler) {
    await this.subscribe(CHANNELS.TRADE_EVENTS, handler);
  }

  async subscribeToPositionUpdates(handler) {
    await this.subscribe(CHANNELS.POSITION_UPDATES, handler);
  }

  async subscribeToSystemAlerts(handler) {
    await this.subscribe(CHANNELS.SYSTEM_ALERTS, handler);
  }

  async subscribeToWorkerHeartbeats(handler) {
    await this.subscribe(CHANNELS.WORKER_HEARTBEATS, handler);
  }

  async disconnect() {
    for (const channel of this.subscriptions) {
      await this.unsubscribe(channel);
    }
  }

  getSubscriptions() {
    return Array.from(this.subscriptions);
  }
}

let subscriber = null;

const getSubscriber = (redisClient = null) => {
  if (!subscriber) {
    subscriber = new EventSubscriber(redisClient);
  }
  return subscriber;
};

module.exports = {
  EventSubscriber,
  getSubscriber,
  CHANNELS
};
