const { getRedisClient } = require('./redisClient');
const { StreamConsumer } = require('./streamClient');
const { logger } = require('../logger/logger');
const { CHANNELS } = require('./publisher');

class EventSubscriber {
  constructor(redisClient = null) {
    this.redisClient = redisClient || getRedisClient();
    this.subscriber = this.redisClient.getSubscriber();
    this.handlers = new Map();
    this.subscriptions = new Set();
    this.messageHandlerInitialized = false;
    this.streamConsumers = [];

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

  async subscribeToMarketDataControl(handler) {
    await this.subscribe(CHANNELS.MARKET_DATA_CONTROL, handler);
  }

  async subscribeToStrategyControl(handler) {
    await this.subscribe(CHANNELS.STRATEGY_CONTROL, handler);
  }

  async subscribeToOperatorActions(handler) {
    await this.subscribe(CHANNELS.OPERATOR_ACTIONS, handler);
  }

  async subscribeToStream(streamName, handler, options = {}) {
    const os = require('os');
    const groupName =
      options.groupName || `${String(streamName).replace(/_/g, '-')}-consumers`;
    const consumerName = options.consumerName || `${os.hostname()}-${process.pid}`;

    const consumer = new StreamConsumer(this.redisClient, {
      streamName,
      groupName,
      consumerName,
      handler,
      blockMs: options.blockMs,
      batchSize: options.batchSize,
    });

    this.streamConsumers.push(consumer);
    await consumer.start();

    logger.info('Subscribed to stream', {
      event: 'stream_subscription_started',
      streamName,
      groupName,
      consumerName,
    });

    return consumer;
  }

  async subscribeToStrategySignalsStream(handler, options = {}) {
    return this.subscribeToStream(CHANNELS.STRATEGY_SIGNALS, handler, {
      groupName: options.groupName || 'order-manager',
      consumerName: options.consumerName,
      blockMs: options.blockMs,
      batchSize: options.batchSize,
    });
  }

  async subscribeToOrderRequestsStream(handler, options = {}) {
    return this.subscribeToStream(CHANNELS.ORDER_REQUESTS, handler, {
      groupName: options.groupName || 'broker-gateway',
      consumerName: options.consumerName,
      blockMs: options.blockMs,
      batchSize: options.batchSize,
    });
  }

  async subscribeToOrderUpdatesStream(handler, options = {}) {
    return this.subscribeToStream(CHANNELS.ORDER_UPDATES, handler, {
      groupName: options.groupName || 'strategy-workers',
      consumerName: options.consumerName,
      blockMs: options.blockMs,
      batchSize: options.batchSize,
    });
  }

  async subscribeToRejectedOrdersStream(handler, options = {}) {
    return this.subscribeToStream(CHANNELS.REJECTED_ORDERS, handler, {
      groupName: options.groupName || 'strategy-workers-rejections',
      consumerName: options.consumerName,
      blockMs: options.blockMs,
      batchSize: options.batchSize,
    });
  }

  async disconnect() {
    for (const channel of this.subscriptions) {
      await this.unsubscribe(channel);
    }
    for (const consumer of this.streamConsumers) {
      consumer.stop();
    }
    this.streamConsumers = [];
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
