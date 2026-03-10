require('dotenv').config();
const { logger, childLogger } = require('../../core/logger/logger');
const { getSubscriber, CHANNELS } = require('../../core/eventBus/subscriber');
const { getPublisher, CHANNELS: PUB_CHANNELS } = require('../../core/eventBus/publisher');
const { OrderStateMachine, ORDER_STATES, ORDER_EVENTS } = require('./orderStateMachine');
const { OrderValidator } = require('./orderValidator');
const { OrderQueue } = require('./orderQueue');
const { query } = require('../../database/postgresClient');
const config = require('../../../config/default');

const SERVICE_NAME = 'order-manager';
const logger = childLogger(SERVICE_NAME);

const PAPER_SLIPPAGE_PERCENT = 0.02;

class OrderManager {
  constructor() {
    this.validator = new OrderValidator();
    this.orderQueue = new OrderQueue({ maxSize: 1000 });
    this.publisher = null;
    this.isRunning = false;
    this.marketPrices = new Map();
    this.stats = {
      signalsReceived: 0,
      ordersCreated: 0,
      ordersValidated: 0,
      ordersRejected: 0,
      ordersFilled: 0,
      duplicates: 0,
      paperFills: 0
    };
  }

  async initialize() {
    logger.info('Initializing Order Manager', { paperMode: config.paperMode });
    
    this.publisher = getPublisher();
    
    await this.subscribeToSignals();
    await this.subscribeToMarketTicks();
    
    logger.info('Order Manager initialized');
  }

  async subscribeToSignals() {
    const subscriber = getSubscriber();
    
    await subscriber.subscribeToStrategySignals(async (signal) => {
      await this.handleSignal(signal);
    });
    
    logger.info('Subscribed to strategy signals');
  }

  async subscribeToMarketTicks() {
    const subscriber = getSubscriber();
    
    await subscriber.subscribeToMarketTicks((tick) => {
      this.marketPrices.set(tick.symbol, tick);
    });
    
    logger.info('Subscribed to market ticks');
  }

  async handleSignal(signal) {
    this.stats.signalsReceived++;
    
    logger.info('Received signal', {
      eventId: signal.event_id,
      action: signal.action,
      instrument: signal.instrument
    });

    const validation = await this.validator.validateComplete(signal);
    
    if (!validation.valid) {
      this.stats.ordersRejected++;
      
      await this.recordSignal(signal, 'rejected', validation.reason);
      
      logger.warn('Signal rejected', {
        eventId: signal.event_id,
        reason: validation.reason
      });
      
      return null;
    }

    const duplicateCheck = await this.validator.checkDuplicateSignal(signal);
    if (duplicateCheck.isDuplicate) {
      this.stats.duplicates++;
      
      logger.warn('Duplicate signal ignored', {
        eventId: signal.event_id,
        existingStatus: duplicateCheck.existingStatus
      });
      
      return null;
    }

    await this.recordSignal(signal, 'pending');
    
    const order = await this.createOrder(signal);
    
    if (!order) {
      logger.error('Failed to create order from signal', { eventId: signal.event_id });
      return null;
    }

    this.stats.ordersCreated++;
    
    await this.transitionOrderState(order.id, ORDER_STATES.VALIDATED);
    
    await this.publishOrderRequest(order);
    
    logger.info('Order created and validated', {
      orderId: order.id,
      eventId: signal.event_id
    });
    
    return order;
  }

  async recordSignal(signal, status, reason = null) {
    try {
      await query(
        `INSERT INTO signals (event_id, strategy_instance_id, symbol, instrument, action, quantity, price_type, price, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (event_id) DO UPDATE SET status = $9`,
        [
          signal.event_id,
          signal.strategy_instance_id,
          signal.symbol,
          signal.instrument,
          signal.action,
          signal.quantity,
          signal.price_type,
          signal.price,
          status
        ]
      );
    } catch (error) {
      logger.error('Failed to record signal', { error: error.message });
    }
  }

  async createOrder(signal) {
    try {
      const result = await query(
        `INSERT INTO orders (client_id, strategy_instance_id, signal_id, event_id, symbol, instrument, side, quantity, price, price_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          signal.client_id,
          signal.strategy_instance_id,
          signal.signal_id,
          signal.event_id,
          signal.symbol,
          signal.instrument,
          signal.action,
          signal.quantity,
          signal.price,
          signal.price_type,
          ORDER_STATES.CREATED
        ]
      );

      const order = result.rows[0];
      
      await this.logOrderEvent(order.id, ORDER_EVENTS.ORDER_CREATED, { signal });
      
      return order;
    } catch (error) {
      logger.error('Failed to create order', { error: error.message });
      return null;
    }
  }

  async transitionOrderState(orderId, newState, eventData = {}) {
    try {
      const result = await query(
        'SELECT status FROM orders WHERE id = $1',
        [orderId]
      );

      if (result.rows.length === 0) {
        logger.warn('Order not found', { orderId });
        return false;
      }

      const currentState = result.rows[0].status;
      
      await query(
        'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
        [newState, orderId]
      );

      await this.logOrderEvent(orderId, `ORDER_${newState.toUpperCase()}`, {
        oldState: currentState,
        newState,
        ...eventData
      });

      logger.info('Order state transitioned', {
        orderId,
        oldState: currentState,
        newState
      });

      return true;
    } catch (error) {
      logger.error('Failed to transition order state', { orderId, error: error.message });
      return false;
    }
  }

  async logOrderEvent(orderId, eventType, eventData = {}) {
    try {
      await query(
        'INSERT INTO order_events (order_id, event_type, event_data) VALUES ($1, $2, $3)',
        [orderId, eventType, JSON.stringify(eventData)]
      );
    } catch (error) {
      logger.error('Failed to log order event', { orderId, eventType, error: error.message });
    }
  }

  async publishOrderRequest(order) {
    try {
      await this.publisher.publishOrderRequest({
        orderId: order.id,
        clientId: order.client_id,
        eventId: order.event_id,
        symbol: order.symbol,
        instrument: order.instrument,
        side: order.side,
        quantity: order.quantity,
        price: order.price,
        priceType: order.price_type,
        status: order.status
      });
      
      logger.debug('Order request published', { orderId: order.id });
    } catch (error) {
      logger.error('Failed to publish order request', { orderId: order.id, error: error.message });
    }
  }

  async handleBrokerResponse(response) {
    const { orderId, status, filledQuantity, averagePrice, brokerOrderId, rejectionReason } = response;
    
    logger.info('Received broker response', { orderId, status });

    switch (status) {
      case 'acknowledged':
        await this.transitionOrderState(orderId, ORDER_STATES.ACKNOWLEDGED, { brokerOrderId });
        break;
        
      case 'filled':
        this.stats.ordersFilled++;
        await this.transitionOrderState(orderId, ORDER_STATES.FILLED, {
          filledQuantity,
          averagePrice
        });
        await this.updateSignalStatus(orderId, 'processed');
        break;
        
      case 'partially_filled':
        await this.transitionOrderState(orderId, ORDER_STATES.PARTIALLY_FILLED, {
          filledQuantity,
          averagePrice
        });
        break;
        
      case 'rejected':
        this.stats.ordersRejected++;
        await this.transitionOrderState(orderId, ORDER_STATES.REJECTED, { rejectionReason });
        await this.updateSignalStatus(orderId, 'rejected');
        break;
        
      case 'cancelled':
        await this.transitionOrderState(orderId, ORDER_STATES.CANCELLED);
        await this.updateSignalStatus(orderId, 'cancelled');
        break;
        
      default:
        logger.warn('Unknown broker response status', { orderId, status });
    }
  }

  async updateSignalStatus(orderId, status) {
    try {
      const result = await query(
        'SELECT event_id FROM orders WHERE id = $1',
        [orderId]
      );

      if (result.rows.length > 0) {
        await query(
          'UPDATE signals SET status = $1, processed_at = NOW() WHERE event_id = $2',
          [status, result.rows[0].event_id]
        );
      }
    } catch (error) {
      logger.error('Failed to update signal status', { error: error.message });
    }
  }

  async getOrder(orderId) {
    try {
      const result = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to get order', { error: error.message });
      return null;
    }
  }

  async getOrdersByClient(clientId, limit = 100) {
    try {
      const result = await query(
        'SELECT * FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT $2',
        [clientId, limit]
      );
      return result.rows;
    } catch (error) {
      logger.error('Failed to get orders by client', { error: error.message });
      return [];
    }
  }

  getStats() {
    return {
      ...this.stats,
      queueSize: this.orderQueue.getSize(),
      isRunning: this.isRunning
    };
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Order Manager already running');
      return;
    }

    this.isRunning = true;
    logger.info('Order Manager started');
  }

  async stop() {
    this.isRunning = false;
    logger.info('Order Manager stopped', { stats: this.stats });
  }
}

let managerInstance = null;

const getOrderManager = () => {
  if (!managerInstance) {
    managerInstance = new OrderManager();
  }
  return managerInstance;
};

async function main() {
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    const manager = getOrderManager();
    await manager.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    const manager = getOrderManager();
    await manager.stop();
    process.exit(0);
  });

  try {
    const manager = getOrderManager();
    await manager.initialize();
    await manager.start();
    
    logger.info('Order Manager is running');
  } catch (error) {
    logger.error('Failed to start Order Manager', { error: error.message });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { OrderManager, getOrderManager };
