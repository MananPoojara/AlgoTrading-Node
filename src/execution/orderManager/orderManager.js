require("dotenv").config();
const { childLogger } = require("../../core/logger/logger");
const { getSubscriber, CHANNELS } = require("../../core/eventBus/subscriber");
const {
  getPublisher,
  CHANNELS: PUB_CHANNELS,
} = require("../../core/eventBus/publisher");
const {
  OrderStateMachine,
  ORDER_STATES,
  ORDER_EVENTS,
} = require("./orderStateMachine");
const { OrderValidator } = require("./orderValidator");
const { OrderQueue } = require("./orderQueue");
const { getBrokerAPI } = require("../broker/angelOneBroker");
const { RiskManager } = require("../../risk/riskManager");
const { getMarginCalculator } = require("../../risk/marginCalculator");
const { getCircuitBreaker } = require("../../risk/circuitBreaker");
const { PaperPortfolioWriter } = require("./paperPortfolioWriter");
const { query } = require("../../database/postgresClient");
const config = require("../../../config/default");

const SERVICE_NAME = "order-manager";
const logger = childLogger(SERVICE_NAME);

const PAPER_SLIPPAGE_PERCENT = 0.02;

class OrderManager {
  constructor() {
    this.validator = new OrderValidator();
    this.orderQueue = new OrderQueue({ maxSize: 1000 });
    this.brokerAPI = null;
    this.publisher = null;
    this.isRunning = false;
    this.isPaperMode = config.paperMode !== false;
    this.marketPrices = new Map();
    this.riskManager = new RiskManager({ clientId: config.defaultClientId });
    this.marginCalculator = getMarginCalculator();
    this.circuitBreaker = getCircuitBreaker();
    this.paperPortfolioWriter = new PaperPortfolioWriter();
    this.orderProcessingInterval = null;
    this.stats = {
      signalsReceived: 0,
      signalsBlocked: 0,
      ordersCreated: 0,
      ordersValidated: 0,
      ordersRejected: 0,
      ordersFilled: 0,
      ordersSent: 0,
      ordersCancelled: 0,
      duplicates: 0,
      paperFills: 0,
      brokerErrors: 0,
      riskRejected: 0,
    };
  }

  async initialize() {
    logger.info("Initializing Order Manager", { paperMode: this.isPaperMode });

    this.publisher = getPublisher();
    await this.riskManager.loadFromDatabase();

    if (!this.isPaperMode) {
      this.brokerAPI = getBrokerAPI();
      logger.info("Broker API initialized");
    } else {
      logger.info("Running in paper mode - no real orders will be placed");
    }

    await this.subscribeToSignals();
    await this.subscribeToMarketTicks();
    await this.subscribeToBrokerResponses();
    await this.restoreRecoverableOrders();

    this.startOrderProcessing();

    logger.info("Order Manager initialized");
  }

  async subscribeToBrokerResponses() {
    const subscriber = getSubscriber();

    await subscriber.subscribe("broker_responses", async (message) => {
      await this.handleBrokerResponse(message);
    });
  }

  startOrderProcessing() {
    if (this.orderProcessingInterval) {
      return;
    }
    this.orderProcessingInterval = setInterval(async () => {
      try {
        await this.processQueuedOrders();
      } catch (error) {
        logger.error("Error processing queued orders", {
          error: error.message,
        });
      }
    }, 1000);
  }

  stopOrderProcessing() {
    if (this.orderProcessingInterval) {
      clearInterval(this.orderProcessingInterval);
      this.orderProcessingInterval = null;
      logger.info("Order processing stopped");
    }
  }

  async processQueuedOrders() {
    const queueItem = this.orderQueue.dequeue();
    if (!queueItem) return;

    await this.sendToBroker(queueItem.order);
  }

  async restoreRecoverableOrders() {
    try {
      const result = await query(
        `SELECT *
         FROM orders
         WHERE execution_mode = $1
           AND status IN ('created', 'validated', 'queued')
         ORDER BY created_at ASC`,
        [this.isPaperMode ? "paper" : "live"],
      );

      for (const order of result.rows) {
        const replayOrder = await this.normalizeRecoveredOrder(order);
        if (!replayOrder) {
          continue;
        }

        const enqueued = this.orderQueue.enqueue(replayOrder);
        if (!enqueued) {
          logger.warn("Skipped recovering order into queue", {
            orderId: replayOrder.id,
            eventId: replayOrder.event_id,
            status: replayOrder.status,
          });
        }
      }

      if (result.rows.length > 0) {
        logger.info("Recovered orders into processing queue", {
          count: result.rows.length,
          executionMode: this.isPaperMode ? "paper" : "live",
        });
      }
    } catch (error) {
      logger.error("Failed to restore recoverable orders", {
        error: error.message,
      });
    }
  }

  async normalizeRecoveredOrder(order) {
    const normalizedOrder = { ...order };

    if (normalizedOrder.status === ORDER_STATES.CREATED) {
      const validated = await this.transitionOrderState(
        normalizedOrder.id,
        ORDER_STATES.VALIDATED,
        { recovery: true },
      );

      if (!validated) {
        logger.warn("Failed to recover created order into validated state", {
          orderId: normalizedOrder.id,
          eventId: normalizedOrder.event_id,
        });
        return null;
      }

      normalizedOrder.status = ORDER_STATES.VALIDATED;
    }

    if (normalizedOrder.status === ORDER_STATES.VALIDATED) {
      const queued = await this.transitionOrderState(
        normalizedOrder.id,
        ORDER_STATES.QUEUED,
        { recovery: true },
      );

      if (!queued) {
        logger.warn("Failed to recover order into queued state", {
          orderId: normalizedOrder.id,
          eventId: normalizedOrder.event_id,
          status: normalizedOrder.status,
        });
        return null;
      }

      normalizedOrder.status = ORDER_STATES.QUEUED;
    }

    return normalizedOrder;
  }

  async subscribeToSignals() {
    const subscriber = getSubscriber();

    await subscriber.subscribeToStrategySignals(async (signal) => {
      await this.handleSignal(signal);
    });

    logger.info("Subscribed to strategy signals");
  }

  async subscribeToMarketTicks() {
    const subscriber = getSubscriber();

    await subscriber.subscribeToMarketTicks((tick) => {
      const price = Number(tick?.ltp || tick?.close || 0);
      const keys = [tick?.symbol, tick?.instrument_token, tick?.token].filter(
        Boolean,
      );

      keys.forEach((key) => {
        this.marketPrices.set(String(key), price);
      });
    });

    logger.info("Subscribed to market ticks");
  }

  async handleSignal(signal) {
    this.stats.signalsReceived++;

    logger.info("Received signal", {
      eventId: signal.event_id,
      action: signal.action,
      instrument: signal.instrument,
    });

    const validation = await this.validator.validateComplete(signal);

    if (!validation.valid) {
      this.stats.ordersRejected++;

      await this.recordSignal(signal, "rejected", validation.reason);

      logger.warn("Signal rejected", {
        eventId: signal.event_id,
        reason: validation.reason,
      });

      return null;
    }

    const riskCheck = await this.riskManager.checkSignal(signal);
    if (!riskCheck.allowed) {
      this.stats.riskRejected++;

      await this.recordSignal(signal, "rejected", riskCheck.reason);

      logger.warn("Signal blocked by risk manager", {
        eventId: signal.event_id,
        reason: riskCheck.reason,
        details: riskCheck.details,
      });

      return null;
    }

    const signalRecord = await this.recordSignal(signal, "pending");
    signal.signal_id = signalRecord?.id || null;

    const order = await this.createOrder(signal);

    if (!order) {
      logger.error("Failed to create order from signal", {
        eventId: signal.event_id,
      });
      return null;
    }

    this.stats.ordersCreated++;

    await this.transitionOrderState(order.id, ORDER_STATES.VALIDATED);

    await this.transitionOrderState(order.id, ORDER_STATES.QUEUED);

    const enqueued = this.orderQueue.enqueue(order);
    if (!enqueued) {
      logger.error("Failed to enqueue order", { orderId: order.id });
      await this.transitionOrderState(order.id, ORDER_STATES.FAILED, {
        error: "Queue full",
      });
      return null;
    }

    this.riskManager.onOrderPlaced(order.id, order);
    await this.publishOrderRequest(order);

    logger.info("Order created, validated and queued", {
      orderId: order.id,
      eventId: signal.event_id,
    });

    return order;
  }

  async recordSignal(signal, status, reason = null) {
    try {
      const result = await query(
        `INSERT INTO signals (
           event_id, client_id, strategy_id, strategy_instance_id, symbol, instrument,
           action, quantity, price_type, price, status, metadata, rejection_reason
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (event_id) DO UPDATE
         SET status = EXCLUDED.status,
             metadata = COALESCE(EXCLUDED.metadata, signals.metadata),
             rejection_reason = EXCLUDED.rejection_reason,
             processed_at = CASE
               WHEN EXCLUDED.status IN ('processed', 'rejected', 'cancelled') THEN NOW()
               ELSE signals.processed_at
             END
         RETURNING id, status`,
        [
          signal.event_id,
          signal.client_id || null,
          signal.strategy_id || null,
          signal.strategy_instance_id,
          signal.symbol,
          signal.instrument,
          signal.action,
          signal.quantity,
          signal.price_type,
          signal.price,
          status,
          JSON.stringify(signal.metadata || {}),
          reason,
        ],
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error("Failed to record signal", { error: error.message });
      return null;
    }
  }

  async createOrder(signal) {
    try {
      const result = await query(
        `INSERT INTO orders (
           client_id, strategy_instance_id, signal_id, event_id, symbol, instrument,
           side, quantity, price, price_type, status, execution_mode
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
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
          ORDER_STATES.CREATED,
          this.isPaperMode ? "paper" : "live",
        ],
      );

      const order = result.rows[0];

      await this.logOrderEvent(order.id, ORDER_EVENTS.ORDER_CREATED, {
        signal,
      });

      return order;
    } catch (error) {
      logger.error("Failed to create order", { error: error.message });
      return null;
    }
  }

  async sendToBroker(order) {
    if (this.isPaperMode) {
      return this.simulatePaperFill(order);
    }

    if (!this.brokerAPI || !this.brokerAPI.isConnected) {
      logger.error("Broker API not connected", { orderId: order.id });
      await this.transitionOrderState(order.id, ORDER_STATES.FAILED, {
        error: "Broker not connected",
      });
      this.stats.brokerErrors++;
      return;
    }

    try {
      await this.transitionOrderState(order.id, ORDER_STATES.SENT_TO_BROKER);

      const brokerResponse = await this.brokerAPI.placeOrder({
        symbol: order.instrument,
        exchange: "NSE",
        side: order.side,
        quantity: order.quantity,
        price: order.price,
        orderType: order.price_type,
        productType: "CASHANDCARRY",
      });

      if (brokerResponse.success) {
        await this.transitionOrderState(order.id, ORDER_STATES.ACKNOWLEDGED, {
          brokerOrderId: brokerResponse.brokerOrderId,
        });
        this.orderQueue.complete(order.id);
        this.stats.ordersSent++;
        logger.info("Order sent to broker", {
          orderId: order.id,
          brokerOrderId: brokerResponse.brokerOrderId,
        });
      } else {
        await this.transitionOrderState(order.id, ORDER_STATES.REJECTED, {
          rejectionReason: brokerResponse.error,
        });
        this.stats.brokerErrors++;
        logger.error("Order rejected by broker", {
          orderId: order.id,
          error: brokerResponse.error,
        });
      }
    } catch (error) {
      logger.error("Failed to send order to broker", {
        orderId: order.id,
        error: error.message,
      });
      await this.transitionOrderState(order.id, ORDER_STATES.FAILED, {
        error: error.message,
      });
      this.stats.brokerErrors++;
    }
  }

  simulatePaperFill(order) {
    setTimeout(async () => {
      const marketPrice = this.resolveMarketPrice(order);
      const fillPrice = order.price_type === "MARKET" ? marketPrice : Number(order.price || marketPrice || 0);

      const slippage = fillPrice * (PAPER_SLIPPAGE_PERCENT / 100);
      const filledPrice =
        order.side === "BUY" ? fillPrice + slippage : fillPrice - slippage;

      await this.transitionOrderState(order.id, ORDER_STATES.ACKNOWLEDGED, {
        brokerOrderId: `PAPER_${order.id}`,
      });
      await this.transitionOrderState(order.id, ORDER_STATES.FILLED, {
        filledPrice,
        filledQuantity: order.quantity,
        averagePrice: filledPrice,
      });

      await this.riskManager.onOrderFilled(order, filledPrice);
      await this.paperPortfolioWriter.syncAfterFill(order, filledPrice, {
        brokerTradeId: `PAPER_TRADE_${order.id}`,
      });
      await this.updateSignalStatus(order.id, "processed");
      this.orderQueue.complete(order.id);

      this.stats.paperFills++;
      this.stats.ordersFilled++;
      logger.info("Paper fill simulated", {
        orderId: order.id,
        fillPrice: filledPrice,
      });
    }, 100);
  }

  async cancelOrder(orderId) {
    try {
      const result = await query("SELECT status FROM orders WHERE id = $1", [
        orderId,
      ]);

      if (result.rows.length === 0) {
        logger.warn("Order not found", { orderId });
        return { success: false, error: "Order not found" };
      }

      const currentState = result.rows[0].status;
      const newState = ORDER_STATES.CANCELLED;
      const eventData = {};

      if (!this.brokerAPI || !this.brokerAPI.isConnected) {
        logger.error("Broker API not connected", { orderId });
        return { success: false, error: "Broker not connected" };
      }

      const brokerResult = await query(
        "SELECT broker_order_id FROM orders WHERE id = $1",
        [orderId],
      );

      const brokerOrderId = brokerResult.rows[0]?.broker_order_id;
      if (!brokerOrderId) {
        return { success: false, error: "No broker order ID" };
      }

      const cancelResult = await this.brokerAPI.cancelOrder(brokerOrderId);

      if (cancelResult.success) {
        await query(
          "UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2",
          [newState, orderId],
        );

        await this.logOrderEvent(orderId, `ORDER_${newState.toUpperCase()}`, {
          oldState: currentState,
          newState,
        });

        logger.info("Order cancelled", {
          orderId,
          brokerOrderId,
        });

        return { success: true };
      } else {
        logger.error("Failed to cancel order with broker", {
          orderId,
          error: cancelResult.error,
        });
        return { success: false, error: cancelResult.error };
      }
    } catch (error) {
      logger.error("Failed to cancel order", {
        orderId,
        error: error.message,
      });
      return { success: false, error: error.message };
    }
  }

  async transitionOrderState(orderId, newState, eventData = {}) {
    try {
      const result = await query("SELECT status FROM orders WHERE id = $1", [
        orderId,
      ]);

      if (result.rows.length === 0) {
        logger.warn("Order not found", { orderId });
        return false;
      }

      const currentState = result.rows[0].status;

      const stateMachine = new OrderStateMachine(currentState);

      try {
        stateMachine.transition(newState, eventData);
      } catch (transitionError) {
        logger.warn("Invalid state transition", {
          orderId,
          currentState,
          targetState: newState,
          error: transitionError.message,
        });
        return false;
      }

      const updateData = { status: newState, updated_at: new Date() };

      if (eventData.brokerOrderId) {
        updateData.broker_order_id = eventData.brokerOrderId;
      }
      if (eventData.filledQuantity !== undefined) {
        updateData.filled_quantity = eventData.filledQuantity;
      }
      if (eventData.averagePrice !== undefined) {
        updateData.average_price = eventData.averagePrice;
        updateData.average_fill_price = eventData.averagePrice;
      }
      if (eventData.rejectionReason) {
        updateData.rejection_reason = eventData.rejectionReason;
      }

      const updateFields = [];
      const values = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(updateData)) {
        updateFields.push(`${key} = $${paramIndex++}`);
        values.push(value);
      }

      values.push(orderId);

      await query(
        `UPDATE orders SET ${updateFields.join(", ")} WHERE id = $${paramIndex}`,
        values,
      );

      await this.logOrderEvent(orderId, `ORDER_${newState.toUpperCase()}`, {
        oldState: currentState,
        newState,
        ...eventData,
      });

      logger.info("Order state transitioned", {
        orderId,
        oldState: currentState,
        newState,
      });

      const updatedOrder = await this.getOrder(orderId);
      if (updatedOrder) {
        await this.publishOrderUpdate(updatedOrder, {
          oldState: currentState,
          newState,
        });
      }

      return true;
    } catch (error) {
      logger.error("Failed to transition order state", {
        orderId,
        error: error.message,
      });
      return false;
    }
  }

  async logOrderEvent(orderId, eventType, eventData = {}) {
    try {
      await query(
        "INSERT INTO order_events (order_id, event_type, event_data) VALUES ($1, $2, $3)",
        [orderId, eventType, JSON.stringify(eventData)],
      );
    } catch (error) {
      logger.error("Failed to log order event", {
        orderId,
        eventType,
        error: error.message,
      });
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
        status: order.status,
      });

      logger.debug("Order request published", { orderId: order.id });
    } catch (error) {
      logger.error("Failed to publish order request", {
        orderId: order.id,
        error: error.message,
      });
    }
  }

  async publishOrderUpdate(order, eventData = {}) {
    try {
      await this.publisher.publish("order_updates", {
        event: "order_update",
        order_id: order.id,
        ...order,
        ...eventData,
      });
    } catch (error) {
      logger.error("Failed to publish order update", {
        orderId: order.id,
        error: error.message,
      });
    }
  }

  resolveMarketPrice(order) {
    const lookupKeys = [
      order.instrument,
      order.symbol,
      order.instrument_token,
      order.token,
    ].filter(Boolean);

    for (const key of lookupKeys) {
      const marketPrice = this.marketPrices.get(String(key));
      if (typeof marketPrice === "number" && marketPrice > 0) {
        return marketPrice;
      }
    }

    return Number(order.price || 0);
  }

  async handleBrokerResponse(response) {
    const {
      orderId,
      status,
      filledQuantity,
      averagePrice,
      brokerOrderId,
      rejectionReason,
    } = response;

    logger.info("Received broker response", { orderId, status });

    switch (status) {
      case "acknowledged":
        await this.transitionOrderState(orderId, ORDER_STATES.ACKNOWLEDGED, {
          brokerOrderId,
        });
        break;

      case "filled":
        this.stats.ordersFilled++;
        await this.transitionOrderState(orderId, ORDER_STATES.FILLED, {
          filledQuantity,
          averagePrice,
        });

        const filledOrder = await this.getOrder(orderId);
        if (filledOrder) {
          await this.riskManager.onOrderFilled(filledOrder, averagePrice);
          await this.paperPortfolioWriter.syncAfterFill(
            filledOrder,
            averagePrice,
            { brokerTradeId: brokerOrderId || `BROKER_TRADE_${orderId}` },
          );
        }

        await this.updateSignalStatus(orderId, "processed");
        break;

      case "partially_filled":
        await this.transitionOrderState(
          orderId,
          ORDER_STATES.PARTIALLY_FILLED,
          {
            filledQuantity,
            averagePrice,
          },
        );

        const partialOrder = await this.getOrder(orderId);
        if (partialOrder) {
          await this.riskManager.onOrderFilled(partialOrder, averagePrice);
        }
        break;

      case "rejected":
        this.stats.ordersRejected++;
        await this.transitionOrderState(orderId, ORDER_STATES.REJECTED, {
          rejectionReason,
        });
        await this.updateSignalStatus(orderId, "rejected");
        break;

      case "cancelled":
        await this.transitionOrderState(orderId, ORDER_STATES.CANCELLED);
        await this.updateSignalStatus(orderId, "cancelled");
        break;

      default:
        logger.warn("Unknown broker response status", { orderId, status });
    }
  }

  async updateSignalStatus(orderId, status) {
    try {
      const result = await query("SELECT event_id FROM orders WHERE id = $1", [
        orderId,
      ]);

      if (result.rows.length > 0) {
        await query(
          "UPDATE signals SET status = $1, processed_at = NOW() WHERE event_id = $2",
          [status, result.rows[0].event_id],
        );
      }
    } catch (error) {
      logger.error("Failed to update signal status", { error: error.message });
    }
  }

  async getOrder(orderId) {
    try {
      const result = await query("SELECT * FROM orders WHERE id = $1", [
        orderId,
      ]);
      return result.rows[0] || null;
    } catch (error) {
      logger.error("Failed to get order", { error: error.message });
      return null;
    }
  }

  async getOrdersByClient(clientId, limit = 100) {
    try {
      const result = await query(
        "SELECT * FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT $2",
        [clientId, limit],
      );
      return result.rows;
    } catch (error) {
      logger.error("Failed to get orders by client", { error: error.message });
      return [];
    }
  }

  getStats() {
    return {
      ...this.stats,
      queueSize: this.orderQueue.getSize(),
      isRunning: this.isRunning,
    };
  }

  async start() {
    if (this.isRunning) {
      logger.warn("Order Manager already running");
      return;
    }

    this.isRunning = true;
    logger.info("Order Manager started");
  }

  async stop() {
    this.isRunning = false;
    logger.info("Order Manager stopped", { stats: this.stats });
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
  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down...");
    const manager = getOrderManager();
    await manager.stop();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    logger.info("Received SIGINT, shutting down...");
    const manager = getOrderManager();
    await manager.stop();
    process.exit(0);
  });

  try {
    const manager = getOrderManager();
    await manager.initialize();
    await manager.start();

    logger.info("Order Manager is running");
  } catch (error) {
    logger.error("Failed to start Order Manager", { error: error.message });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { OrderManager, getOrderManager };
