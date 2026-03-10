const { getRedisClient } = require('./redisClient');
const { logger } = require('../logger/logger');

const CHANNELS = {
  MARKET_TICKS: 'market_ticks',
  STRATEGY_SIGNALS: 'strategy_signals',
  ORDER_REQUESTS: 'order_requests',
  VALIDATED_ORDERS: 'validated_orders',
  REJECTED_ORDERS: 'rejected_orders',
  BROKER_RESPONSES: 'broker_responses',
  TRADE_EVENTS: 'trade_events',
  POSITION_UPDATES: 'position_updates',
  SYSTEM_ALERTS: 'system_alerts',
  WORKER_HEARTBEATS: 'worker_heartbeats'
};

class EventPublisher {
  constructor(redisClient = null) {
    this.redisClient = redisClient || getRedisClient();
    this.publisher = this.redisClient.getPublisher();
  }

  async publish(channel, data) {
    const message = {
      ...data,
      publishedAt: new Date().toISOString()
    };

    try {
      await this.redisClient.publish(channel, JSON.stringify(message));
      logger.debug('Event published', { channel, eventType: data.event || 'unknown' });
      return true;
    } catch (error) {
      logger.error('Failed to publish event', { channel, error: error.message });
      throw error;
    }
  }

  async publishMarketTick(tickData) {
    return this.publish(CHANNELS.MARKET_TICKS, {
      event: 'market_tick',
      ...tickData
    });
  }

  async publishStrategySignal(signalData) {
    return this.publish(CHANNELS.STRATEGY_SIGNALS, {
      event: 'strategy_signal',
      ...signalData
    });
  }

  async publishOrderRequest(orderData) {
    return this.publish(CHANNELS.ORDER_REQUESTS, {
      event: 'order_request',
      ...orderData
    });
  }

  async publishValidatedOrder(orderData) {
    return this.publish(CHANNELS.VALIDATED_ORDERS, {
      event: 'validated_order',
      ...orderData
    });
  }

  async publishRejectedOrder(orderData) {
    return this.publish(CHANNELS.REJECTED_ORDERS, {
      event: 'rejected_order',
      ...orderData
    });
  }

  async publishBrokerResponse(responseData) {
    return this.publish(CHANNELS.BROKER_RESPONSES, {
      event: 'broker_response',
      ...responseData
    });
  }

  async publishTradeEvent(tradeData) {
    return this.publish(CHANNELS.TRADE_EVENTS, {
      event: 'trade_event',
      ...tradeData
    });
  }

  async publishPositionUpdate(positionData) {
    return this.publish(CHANNELS.POSITION_UPDATES, {
      event: 'position_update',
      ...positionData
    });
  }

  async publishSystemAlert(alertData) {
    return this.publish(CHANNELS.SYSTEM_ALERTS, {
      event: 'system_alert',
      level: alertData.level || 'INFO',
      ...alertData
    });
  }

  async publishWorkerHeartbeat(heartbeatData) {
    return this.publish(CHANNELS.WORKER_HEARTBEATS, {
      event: 'worker_heartbeat',
      ...heartbeatData
    });
  }

  getChannels() {
    return CHANNELS;
  }
}

let publisher = null;

const getPublisher = (redisClient = null) => {
  if (!publisher) {
    publisher = new EventPublisher(redisClient);
  }
  return publisher;
};

module.exports = {
  EventPublisher,
  getPublisher,
  CHANNELS
};
