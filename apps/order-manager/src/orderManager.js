require("../../../packages/core/bootstrap/loadEnv").loadEnv();
const { childLogger } = require("../../../packages/core/logger/logger");
const { getSubscriber, CHANNELS } = require("../../../packages/core/eventBus/subscriber");
const {
  getPublisher,
  CHANNELS: PUB_CHANNELS,
} = require("../../../packages/core/eventBus/publisher");
const { getRedisClient } = require("../../../packages/core/eventBus/redisClient");
const {
  OrderStateMachine,
  ORDER_STATES,
  ORDER_EVENTS,
} = require("./orderStateMachine");
const { OrderValidator } = require("./orderValidator");
const { OrderQueue } = require("./orderQueue");
const { getBrokerAPI } = require("../../../packages/broker-adapters/angel-one/angelOneBroker");
const { RiskManager } = require("../../risk-manager/src/riskManager");
const { getMarginCalculator } = require("../../risk-manager/src/marginCalculator");
const { getCircuitBreaker } = require("../../risk-manager/src/circuitBreaker");
const { PaperPortfolioWriter } = require("./paperPortfolioWriter");
const { query } = require("../../../packages/database/postgresClient");
const {
  getSchemaCapability,
  markSchemaCapabilitySupported,
  markSchemaCapabilityUnsupported,
} = require("../../../packages/database/schemaCapabilities");
const { formatIST } = require("../../../packages/core/utils/time");
const {
  getSignalFingerprint,
  getSignalTriggerBarTime,
} = require("../../../packages/core/utils/signalFingerprint");
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
    this.redis = null;
    this.isRunning = false;
    this.isPaperMode = config.paperMode !== false;
    this.marketPrices = new Map();
    this.riskManager = new RiskManager({ clientId: config.defaultClientId });
    this.marginCalculator = getMarginCalculator();
    this.circuitBreaker = getCircuitBreaker();
    this.paperPortfolioWriter = new PaperPortfolioWriter();
    this.orderProcessingInterval = null;
    this.pendingApprovalInterval = null;
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
      approvalsPending: 0,
    };
  }

  async initialize() {
    logger.info("Initializing Order Manager", { paperMode: this.isPaperMode });

    this.publisher = getPublisher();
    this.redis = getRedisClient();
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
    await this.subscribeToOperatorActions();
    await this.restoreRecoverableOrders();

    this.startOrderProcessing();
    this.startApprovalTimeoutSweep();

    logger.info("Order Manager initialized");
  }

  async subscribeToBrokerResponses() {
    const subscriber = getSubscriber();

    await subscriber.subscribe("broker_responses", async (message) => {
      await this.handleBrokerResponse(message);
    });
  }

  async subscribeToOperatorActions() {
    const subscriber = getSubscriber();

    if (typeof subscriber.subscribeToOperatorActions !== "function") {
      return;
    }

    await subscriber.subscribeToOperatorActions(async (message) => {
      await this.handleOperatorAction(message);
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

  startApprovalTimeoutSweep() {
    if (this.pendingApprovalInterval) {
      return;
    }

    this.pendingApprovalInterval = setInterval(async () => {
      try {
        await this.expirePendingApprovals();
      } catch (error) {
        logger.error("Failed to expire pending approvals", {
          error: error.message,
        });
      }
    }, 1000);
  }

  stopApprovalTimeoutSweep() {
    if (this.pendingApprovalInterval) {
      clearInterval(this.pendingApprovalInterval);
      this.pendingApprovalInterval = null;
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

    // Use Redis Streams for durable at-least-once delivery of strategy signals.
    // Falls back to Pub/Sub if stream subscription fails (e.g. Redis version < 5.0).
    try {
      await subscriber.subscribeToStrategySignalsStream(async (signal) => {
        await this.handleSignal(signal);
      });
      logger.info("Subscribed to strategy signals via Redis Stream", {
        event: 'signal_subscription_stream',
      });
    } catch (streamError) {
      logger.warn("Redis Stream subscription failed — falling back to Pub/Sub", {
        event: 'signal_subscription_pubsub_fallback',
        error: streamError.message,
      });
      await subscriber.subscribeToStrategySignals(async (signal) => {
        await this.handleSignal(signal);
      });
      logger.info("Subscribed to strategy signals via Pub/Sub (fallback)");
    }
  }

  async subscribeToMarketTicks() {
    const subscriber = getSubscriber();

    await subscriber.subscribeToMarketTicks((tick) => {
      const price = Number(tick?.ltp || tick?.close || 0);
      const timestampMs = tick?.timestamp
        ? new Date(tick.timestamp).getTime()
        : Date.now();
      const keys = [tick?.symbol, tick?.instrument_token, tick?.token].filter(
        Boolean,
      );

      keys.forEach((key) => {
        this.marketPrices.set(String(key), {
          price,
          timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
        });
      });
    });

    logger.info("Subscribed to market ticks");
  }

  isHardBlockedSignal(signal, exitContext) {
    if (
      !this.isPaperMode &&
      signal?.action === "BUY" &&
      (signal?.instrument_resolution_status === "unresolved" ||
        signal?.metadata?.instrument_resolution_status === "unresolved")
    ) {
      return {
        reason: "instrument_resolution_failed",
        details: {
          resolverSource:
            signal?.resolver_source || signal?.metadata?.resolver_source || null,
          instrument: signal?.instrument || null,
        },
      };
    }

    if (
      signal?.action === "SELL" &&
      !exitContext?.isRiskReducingExit &&
      config.risk?.allowShortSelling !== true
    ) {
      return {
        reason: "naked_or_risk_increasing_sell_not_supported",
        details: {
          currentPosition: exitContext?.currentPosition || 0,
          queuedBuyQuantity: exitContext?.queuedBuyQuantity || 0,
        },
      };
    }

    return null;
  }

  buildDecisionReasons(riskCheck) {
    if (Array.isArray(riskCheck?.warnings) && riskCheck.warnings.length > 0) {
      return riskCheck.warnings.map((warning) => ({
        reason: warning.reason,
        details: warning.details || null,
      }));
    }

    if (riskCheck?.reason) {
      return [
        {
          reason: riskCheck.reason,
          details: riskCheck.details || null,
        },
      ];
    }

    return [];
  }

  /**
   * Atomic Redis SET NX dedup gate.
   * Returns true if the signal is a duplicate and should be dropped.
   * Uses SET key 1 NX EX 86400 — atomic, single operation, no GET-then-SET race.
   */
  async isSignalDuplicate(signal) {
    const fingerprint = getSignalFingerprint(signal);
    if (!fingerprint || !this.redis) {
      return false;
    }

    try {
      const key = `signal:dedup:${fingerprint}`;
      const result = await this.redis.setNx(key, '1', 86400);
      // setNx returns 'OK' on first set (not a duplicate), null when key already exists (duplicate)
      return result === null;
    } catch (error) {
      // Redis failure is non-fatal — fall through to DB-level dedup
      logger.warn('Redis dedup check failed, falling back to DB dedup', {
        event: 'signal_dedup_redis_fallback',
        eventId: signal.event_id,
        error: error.message,
      });
      return false;
    }
  }

  async handleSignal(signal) {
    this.stats.signalsReceived++;

    // Fast atomic dedup gate — check Redis before any expensive validation or DB work
    const isDuplicate = await this.isSignalDuplicate(signal);
    if (isDuplicate) {
      this.stats.duplicates++;
      logger.info('Signal dropped by atomic dedup gate', {
        event: 'Duplicate_signal_dropped',
        eventId: signal.event_id,
        action: signal.action,
        timestamp_utc: new Date().toISOString(),
      });
      return null;
    }

    logger.info("Received signal", {
      eventId: signal.event_id,
      action: signal.action,
      instrument: signal.instrument,
    });

    const validation = await this.validator.validateComplete(signal);

    if (!validation.valid) {
      this.stats.ordersRejected++;

      await this.recordSignal(signal, "rejected", validation.reason);
      await this.recordSignalDecision(signal, "hard_block", [
        {
          reason: validation.reason,
          details: validation.errors || null,
        },
      ]);
      await this.publishRejectedSignal(signal, validation.reason, validation.errors);

      logger.warn("Signal rejected", {
        eventId: signal.event_id,
        reason: validation.reason,
      });

      return null;
    }

    const exitContext = await this.getExitContext(signal);
    const hardBlock = this.isHardBlockedSignal(signal, exitContext);
    if (hardBlock) {
      this.stats.ordersRejected++;

      await this.recordSignal(signal, "rejected", hardBlock.reason);
      await this.recordSignalDecision(signal, "hard_block", [
        {
          reason: hardBlock.reason,
          details: hardBlock.details,
        },
      ]);
      await this.publishRejectedSignal(signal, hardBlock.reason, hardBlock.details);

      logger.warn("Signal hard blocked", {
        eventId: signal.event_id,
        reason: hardBlock.reason,
        details: hardBlock.details,
      });
      return null;
    }

    const riskCheck = await this.riskManager.checkSignal(signal, {
      isRiskReducingExit: exitContext.isRiskReducingExit,
    });

    const decisionReasons = this.buildDecisionReasons(riskCheck);

    if (riskCheck.requiresApproval) {
      const signalRecord = await this.recordSignal(signal, "pending");
      if (signalRecord?.duplicate) {
        logger.info("Dropped duplicate signal before approval creation", {
          eventId: signal.event_id,
          fingerprint: signalRecord.signal_fingerprint || null,
          existingEventId: signalRecord.event_id || null,
        });
        return null;
      }
      signal.signal_id = signalRecord?.id || null;
      await this.recordSignalDecision(signal, "soft_warn", decisionReasons, {
        requiresApproval: true,
      });
      const approval = await this.createPendingApproval(signal, riskCheck.warnings || []);
      this.stats.approvalsPending++;

      logger.warn("Signal pending operator approval", {
        eventId: signal.event_id,
        approvalId: approval?.id || null,
        warnings: decisionReasons,
      });

      return {
        pendingApproval: true,
        approvalId: approval?.id || null,
        eventId: signal.event_id,
      };
    }

    if (!riskCheck.allowed) {
      this.stats.riskRejected++;

      await this.recordSignal(signal, "rejected", riskCheck.reason);
      await this.recordSignalDecision(signal, "hard_block", decisionReasons);
      await this.publishRejectedSignal(signal, riskCheck.reason, riskCheck.details);

      logger.warn("Signal blocked by risk manager", {
        eventId: signal.event_id,
        reason: riskCheck.reason,
        details: riskCheck.details,
        exitContext,
      });

      return null;
    }

    if (Array.isArray(riskCheck.warnings) && riskCheck.warnings.length > 0) {
      await this.recordSignalDecision(signal, "soft_warn", decisionReasons);
      await this.publishRiskWarnings(signal, riskCheck.warnings);
    } else {
      await this.recordSignalDecision(signal, "allow", []);
    }

    if (exitContext.isRiskReducingExit) {
      logger.info("Allowing risk-reducing exit signal through risk controls", {
        eventId: signal.event_id,
        strategyInstanceId: signal.strategy_instance_id,
        instrument: signal.instrument,
        exitReason: signal.exit_reason || null,
        currentPosition: exitContext.currentPosition,
        queuedBuyQuantity: exitContext.queuedBuyQuantity,
      });
    }

    const signalRecord = await this.recordSignal(signal, "pending");
    if (signalRecord?.duplicate) {
      logger.info("Dropped duplicate signal before order creation", {
        eventId: signal.event_id,
        fingerprint: signalRecord.signal_fingerprint || null,
        existingEventId: signalRecord.event_id || null,
      });
      return null;
    }
    signal.signal_id = signalRecord?.id || null;

    const order = await this.createOrderFromSignal(signal);

    if (!order) {
      logger.error("Failed to create order from signal", {
        eventId: signal.event_id,
      });
      return null;
    }

    return order;
  }

  async getExitContext(signal) {
    const defaultContext = {
      isRiskReducingExit: false,
      currentPosition: 0,
      queuedBuyQuantity: 0,
    };

    if (
      !signal ||
      signal.action !== "SELL" ||
      !signal.client_id ||
      !signal.instrument
    ) {
      return defaultContext;
    }

    try {
      const positionsResult = await query(
        `SELECT COALESCE(SUM(position), 0) AS position
         FROM positions
         WHERE client_id = $1
           AND instrument = $2
           AND strategy_instance_id IS NOT DISTINCT FROM $3`,
        [signal.client_id, signal.instrument, signal.strategy_instance_id || null],
      );
      const currentPosition = Number(positionsResult.rows[0]?.position || 0);

      const openOrdersResult = await query(
        `SELECT COALESCE(SUM(quantity), 0) AS queued_buy_quantity
         FROM orders
         WHERE client_id = $1
           AND instrument = $2
           AND strategy_instance_id IS NOT DISTINCT FROM $3
           AND side = 'BUY'
           AND status IN ('created', 'validated', 'queued', 'sent_to_broker', 'acknowledged', 'partially_filled')`,
        [signal.client_id, signal.instrument, signal.strategy_instance_id || null],
      );
      const queuedBuyQuantity = Number(
        openOrdersResult.rows[0]?.queued_buy_quantity || 0,
      );

      const reducibleQuantity = Math.max(currentPosition, 0) + queuedBuyQuantity;
      const requestedSellQuantity = Number(signal.quantity || 0);

      return {
        isRiskReducingExit:
          reducibleQuantity > 0 && requestedSellQuantity > 0 && requestedSellQuantity <= reducibleQuantity,
        currentPosition,
        queuedBuyQuantity,
      };
    } catch (error) {
      logger.error("Failed to resolve exit context for risk evaluation", {
        eventId: signal.event_id,
        error: error.message,
      });
      return defaultContext;
    }
  }

  async recordSignal(signal, status, reason = null) {
    const signalFingerprint = getSignalFingerprint(signal);
    const triggerBarTime = getSignalTriggerBarTime(signal);
    const signalColumnsSupported = await getSchemaCapability(
      "signal_extended_columns",
    );

    try {
      if (signalColumnsSupported) {
        const result = await query(
          `INSERT INTO signals (
             event_id, client_id, strategy_id, strategy_instance_id, symbol, instrument,
             action, quantity, price_type, price, status, metadata, rejection_reason,
             trigger_bar_time, signal_fingerprint
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (event_id) DO UPDATE
           SET status = EXCLUDED.status,
               metadata = COALESCE(EXCLUDED.metadata, signals.metadata),
               rejection_reason = EXCLUDED.rejection_reason,
               trigger_bar_time = COALESCE(EXCLUDED.trigger_bar_time, signals.trigger_bar_time),
               signal_fingerprint = COALESCE(EXCLUDED.signal_fingerprint, signals.signal_fingerprint),
               processed_at = CASE
                 WHEN EXCLUDED.status IN ('processed', 'rejected', 'cancelled') THEN NOW()
                 ELSE signals.processed_at
               END
           RETURNING id, status, event_id, signal_fingerprint`,
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
            triggerBarTime,
            signalFingerprint,
          ],
        );
        markSchemaCapabilitySupported("signal_extended_columns");
        return result.rows[0] || null;
      }

      const legacyResult = await query(
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
         RETURNING id, status, event_id`,
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

      return legacyResult.rows[0] || null;
    } catch (error) {
      if (
        error?.code === "23505" &&
        String(error?.constraint || "").includes("signal_fingerprint")
      ) {
        const existing = await query(
          `SELECT id, status, event_id, signal_fingerprint
           FROM signals
           WHERE signal_fingerprint = $1
           LIMIT 1`,
          [signalFingerprint],
        );

        return {
          ...(existing.rows[0] || {}),
          duplicate: true,
        };
      }

      if (error?.code === "42703") {
        markSchemaCapabilityUnsupported("signal_extended_columns");
        try {
          const legacyResult = await query(
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
             RETURNING id, status, event_id`,
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

          return legacyResult.rows[0] || null;
        } catch (legacyError) {
          logger.error("Failed to record signal with legacy schema", {
            error: legacyError.message,
          });
        }
      } else {
        logger.error("Failed to record signal", { error: error.message });
      }

      return null;
    }
  }

  async recordSignalDecision(signal, decision, reasons = [], extra = {}) {
    const metadata = {
      event_type: "signal_decision",
      event_id: signal.event_id,
      client_id: signal.client_id || null,
      strategy_id: signal.strategy_id || null,
      strategy_instance_id: signal.strategy_instance_id || null,
      symbol: signal.symbol || null,
      instrument: signal.instrument || null,
      action: signal.action || null,
      quantity: Number(signal.quantity || 0),
      decision,
      reasons,
      execution_mode: this.isPaperMode ? "paper" : "live",
      risk_policy_mode: this.riskManager.policyMode,
      ...extra,
    };

    await this.insertSystemLog(
      "INFO",
      `Signal decision ${decision} for ${signal.event_id}`,
      metadata,
      signal.client_id || null,
      signal.strategy_id || null,
    );
  }

  async insertSystemLog(level, message, metadata, clientId = null, strategyId = null) {
    try {
      const result = await query(
        `INSERT INTO system_logs (
           level, service, client_id, strategy_id, message, metadata, timestamp
         )
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id, metadata, timestamp`,
        [
          level,
          SERVICE_NAME,
          clientId,
          strategyId,
          message,
          JSON.stringify(metadata || {}),
        ],
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error("Failed to insert system log", {
        message,
        error: error.message,
      });
      return null;
    }
  }

  async recordOperatorAudit(action, targetType, targetId, metadata = {}, operator = {}) {
    try {
      await query(
        `INSERT INTO operator_audit_log (
           operator_id, operator_username, action, target_type, target_id, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          operator.id || null,
          operator.username || null,
          action,
          targetType,
          targetId || null,
          JSON.stringify(metadata),
        ],
      );
    } catch (error) {
      logger.error("Failed to record operator audit", {
        action,
        targetType,
        targetId,
        error: error.message,
      });
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

  async createOrderFromSignal(signal) {
    const order = await this.createOrder(signal);

    if (!order) {
      return null;
    }

    order.instrument_resolution_status =
      signal.instrument_resolution_status ||
      signal.metadata?.instrument_resolution_status ||
      null;
    order.trigger_bar_time = getSignalTriggerBarTime(signal);

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
    await this.requestMarketDataRefresh(order);

    logger.info("Order created, validated and queued", {
      orderId: order.id,
      eventId: signal.event_id,
    });

    return order;
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
      const paperFill = this.resolvePaperFill(order);
      const fillPrice =
        order.price_type === "MARKET"
          ? paperFill.fillPrice
          : Number(order.price || paperFill.fillPrice || 0);

      if (paperFill.warning) {
        await this.publishRiskWarnings(
          {
            event_id: order.event_id,
            client_id: order.client_id,
            strategy_id: null,
            strategy_instance_id: order.strategy_instance_id || null,
            symbol: order.symbol || null,
            instrument: order.instrument || null,
            action: order.side,
            quantity: order.quantity,
            price_type: order.price_type,
            price: order.price,
          },
          [
            {
              reason: paperFill.warning,
              details: {
                source: paperFill.source,
                fallbackPrice: fillPrice,
                order_id: order.id,
              },
            },
          ],
        );
      }

      await this.insertSystemLog(
        paperFill.warning ? "WARN" : "INFO",
        `Paper fill source resolved for order ${order.id}`,
        {
          event_type: "paper_fill_source",
          order_id: order.id,
          event_id: order.event_id,
          client_id: order.client_id,
          strategy_instance_id: order.strategy_instance_id || null,
          instrument: order.instrument || null,
          side: order.side,
          source: paperFill.source,
          warning: paperFill.warning || null,
          fill_price_source: paperFill.source,
          fill_price_age_seconds: paperFill.ageSeconds,
          instrument_resolution_status:
            order.instrument_resolution_status || null,
          reference_price: fillPrice,
        },
        order.client_id || null,
        null,
      );

      if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
        await this.transitionOrderState(order.id, ORDER_STATES.FAILED, {
          rejectionReason: "paper_fill_missing_price",
        });
        await this.updateSignalStatus(order.id, "rejected");
        this.riskManager.onOrderCancelled(order.id);
        this.orderQueue.complete(order.id);
        logger.warn("Paper fill aborted - missing valid price", {
          orderId: order.id,
          eventId: order.event_id,
          source: paperFill.source,
        });
        return;
      }

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

  async requestMarketDataRefresh(order) {
    try {
      if (!this.publisher) {
        this.publisher = getPublisher();
      }

      if (typeof this.publisher.publishMarketDataControl !== "function") {
        return;
      }

      await this.publisher.publishMarketDataControl({
        command: "refresh_subscriptions",
        reason: "order_created",
        instrument: order.instrument,
        symbol: order.symbol,
        strategy_instance_id: order.strategy_instance_id || null,
      });
    } catch (error) {
      logger.error("Failed to request market data refresh", {
        orderId: order?.id,
        error: error.message,
      });
    }
  }

  getApprovalExpiry() {
    const timeoutSeconds = Number(
      config.risk?.operatorApprovalTimeoutSeconds || 30,
    );
    return new Date(Date.now() + timeoutSeconds * 1000);
  }

  async createPendingApproval(signal, warnings = []) {
    const expiresAt = this.getApprovalExpiry();
    const metadata = {
      event_type: "operator_approval_pending",
      status: "pending",
      signal,
      warnings,
      execution_mode: this.isPaperMode ? "paper" : "live",
      risk_policy_mode: this.riskManager.policyMode,
      expires_at: formatIST(expiresAt),
    };

    const approval = await this.insertSystemLog(
      "WARN",
      `Operator approval required for signal ${signal.event_id}`,
      metadata,
      signal.client_id || null,
      signal.strategy_id || null,
    );

    if (typeof this.publisher.publishSystemAlert === "function") {
      await this.publisher.publishSystemAlert({
        level: "WARN",
        service: SERVICE_NAME,
        event_type: "operator_approval_pending",
        approval_id: approval?.id || null,
        signal_event_id: signal.event_id,
        signal,
        warnings,
        expires_at: metadata.expires_at,
        message: `Operator approval required for signal ${signal.event_id}`,
      });
    }

    return approval;
  }

  async fetchPendingApproval(approvalId) {
    const result = await query(
      `SELECT id, client_id, strategy_id, metadata
       FROM system_logs
       WHERE id = $1
         AND metadata->>'event_type' = 'operator_approval_pending'`,
      [approvalId],
    );

    return result.rows[0] || null;
  }

  async updateApprovalStatus(approvalId, status, extra = {}) {
    const result = await query(
      `UPDATE system_logs
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = $1
       RETURNING id, metadata`,
      [
        approvalId,
        JSON.stringify({
          status,
          resolved_at: formatIST(),
          ...extra,
        }),
      ],
    );

    return result.rows[0] || null;
  }

  async handleOperatorAction(message = {}) {
    const approvalId = Number(message.approval_id || 0);
    const action = String(message.action || "").toLowerCase();

    if (!approvalId || !["approve", "reject"].includes(action)) {
      return;
    }

    const approval = await this.fetchPendingApproval(approvalId);
    if (!approval) {
      logger.warn("Operator action received for unknown approval", {
        approvalId,
        action,
      });
      return;
    }

    const metadata = approval.metadata || {};
    if (metadata.status && metadata.status !== "pending") {
      return;
    }

    const signal = metadata.signal || null;
    if (!signal) {
      logger.warn("Approval missing signal payload", { approvalId });
      return;
    }

    if (action === "approve") {
      await this.updateApprovalStatus(approvalId, "approved", {
        operator_action: message,
      });
      await this.recordOperatorAudit("approve_signal", "signal", signal.signal_id || null, {
        approval_id: approvalId,
        event_id: signal.event_id,
      }, {
        id: message.operator_id || null,
        username: message.operator_username || null,
      });
      await this.recordSignalDecision(signal, "allow", [
        {
          reason: "operator_approved",
          details: { approval_id: approvalId },
        },
      ]);
      await this.createOrderFromSignal(signal);
      return;
    }

    await this.updateApprovalStatus(approvalId, "rejected", {
      operator_action: message,
    });
    await this.recordOperatorAudit("reject_signal", "signal", signal.signal_id || null, {
      approval_id: approvalId,
      event_id: signal.event_id,
    }, {
      id: message.operator_id || null,
      username: message.operator_username || null,
    });
    await this.recordSignal(signal, "rejected", "operator_rejected");
    await this.recordSignalDecision(signal, "hard_block", [
      {
        reason: "operator_rejected",
        details: { approval_id: approvalId },
      },
    ]);
    await this.publishRejectedSignal(signal, "operator_rejected", {
      approval_id: approvalId,
    });
  }

  async expirePendingApprovals() {
    const result = await query(
      `SELECT id, metadata
       FROM system_logs
       WHERE metadata->>'event_type' = 'operator_approval_pending'
         AND COALESCE(metadata->>'status', 'pending') = 'pending'`,
    );

    for (const row of result.rows) {
      const expiresAt = row.metadata?.expires_at
        ? new Date(row.metadata.expires_at)
        : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt > new Date()) {
        continue;
      }

      const signal = row.metadata?.signal;
      await this.updateApprovalStatus(row.id, "expired");
      if (signal) {
        await this.recordSignal(signal, "rejected", "operator_approval_expired");
        await this.recordSignalDecision(signal, "hard_block", [
          {
            reason: "operator_approval_expired",
            details: { approval_id: row.id },
          },
        ]);
        await this.publishRejectedSignal(signal, "operator_approval_expired", {
          approval_id: row.id,
        });
      }
    }
  }

  async publishRejectedSignal(signal, reason, details = null) {
    try {
      if (!this.publisher) {
        this.publisher = getPublisher();
      }

      if (typeof this.publisher.publishRejectedOrder !== "function") {
        return;
      }

      await this.publisher.publishRejectedOrder({
        event_id: signal.event_id,
        client_id: signal.client_id || null,
        strategy_id: signal.strategy_id || null,
        strategy_instance_id: signal.strategy_instance_id || null,
        symbol: signal.symbol || null,
        instrument: signal.instrument || null,
        action: signal.action || null,
        quantity: signal.quantity || null,
        price_type: signal.price_type || null,
        price: signal.price || null,
        status: "rejected",
        rejection_reason: reason,
        details: details || null,
      });
    } catch (error) {
      logger.error("Failed to publish rejected signal", {
        eventId: signal?.event_id,
        error: error.message,
      });
    }
  }

  async publishRiskWarnings(signal, warnings = []) {
    if (!Array.isArray(warnings) || warnings.length === 0) {
      return;
    }

    if (!this.publisher) {
      this.publisher = getPublisher();
    }

    for (const warning of warnings) {
      const payload = {
        event_type: "risk_warning",
        event_id: signal.event_id,
        client_id: signal.client_id || null,
        strategy_id: signal.strategy_id || null,
        strategy_instance_id: signal.strategy_instance_id || null,
        symbol: signal.symbol || null,
        instrument: signal.instrument || null,
        action: signal.action || null,
        quantity: Number(signal.quantity || 0),
        price_type: signal.price_type || null,
        price: Number(signal.price || 0),
        execution_mode: this.isPaperMode ? "paper" : "live",
        risk_policy_mode: this.riskManager.policyMode,
        warning_reason: warning.reason || "unknown",
        warning_details: warning.details || null,
      };

      try {
        await query(
          `INSERT INTO system_logs (
             level, service, client_id, strategy_id, message, metadata, timestamp
           )
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            "WARN",
            SERVICE_NAME,
            signal.client_id || null,
            signal.strategy_id || null,
            `Risk warning for signal ${signal.event_id}: ${payload.warning_reason}`,
            JSON.stringify(payload),
          ],
        );
      } catch (error) {
        logger.error("Failed to persist risk warning", {
          eventId: signal.event_id,
          error: error.message,
        });
      }

      try {
        if (typeof this.publisher.publishSystemAlert === "function") {
          await this.publisher.publishSystemAlert({
            level: "WARN",
            service: SERVICE_NAME,
            message: `Risk warning: ${payload.warning_reason}`,
            ...payload,
          });
        }
      } catch (error) {
        logger.error("Failed to publish risk warning alert", {
          eventId: signal.event_id,
          error: error.message,
        });
      }
    }
  }

  async publishOrderUpdate(order, eventData = {}) {
    try {
      const payload = {
        order_id: order.id,
        ...order,
        ...eventData,
      };

      if (typeof this.publisher.publishOrderUpdate === "function") {
        await this.publisher.publishOrderUpdate(payload);
      } else {
        await this.publisher.publish("order_updates", {
          event: "order_update",
          ...payload,
        });
      }
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
        return {
          fillPrice: marketPrice,
          ageSeconds: 0,
          isStale: false,
        };
      }

      if (
        marketPrice &&
        typeof marketPrice.price === "number" &&
        marketPrice.price > 0
      ) {
        const ageMs = Date.now() - Number(marketPrice.timestampMs || Date.now());
        const ageSeconds = Math.max(0, Math.floor(ageMs / 1000));
        return {
          fillPrice: Number(marketPrice.price),
          ageSeconds,
          isStale: ageSeconds > 30,
        };
      }
    }

    return {
      fillPrice: 0,
      ageSeconds: null,
      isStale: false,
    };
  }

  resolvePaperFill(order) {
    const marketPrice = this.resolveMarketPrice(order);
    if (Number(marketPrice.fillPrice) > 0) {
      return {
        fillPrice: Number(marketPrice.fillPrice),
        source: marketPrice.isStale ? "stale_option_tick" : "live_option_tick",
        ageSeconds: marketPrice.ageSeconds,
        warning: marketPrice.isStale
          ? "paper_fill_using_stale_option_tick"
          : null,
      };
    }

    const fallbackPrice = Number(order.price || 0);
    if (fallbackPrice > 0) {
      return {
        fillPrice: fallbackPrice,
        source: "estimated_signal_price",
        ageSeconds: null,
        warning: "paper_fill_estimated_from_signal_price",
      };
    }

    return {
      fillPrice: 0,
      source: "missing_price_failed",
      ageSeconds: null,
      warning: "paper_fill_missing_price",
    };
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
