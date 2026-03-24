'use strict';

/**
 * Redis Streams client for durable, at-least-once delivery of critical events.
 *
 * Used for:
 *   - strategy_signals  (strategy worker → order manager)
 *   - order_requests    (order manager → broker gateway)
 *
 * Pub/Sub remains in use for:
 *   - market_ticks, heartbeats, control commands, alerts
 *   (fire-and-forget, high-frequency, no durability needed)
 *
 * Pattern:
 *   Publisher  → XADD stream:* * key value ...
 *   Consumer   → XGROUP CREATE (idempotent)
 *              → XREADGROUP BLOCK ... STREAMS stream:* >
 *              → handler(message)
 *              → XACK stream:* group messageId
 *
 * Idempotency:
 *   Consumer checks a Redis SET NX key (processed:stream:<stream_message_id>) before
 *   dispatching to the handler. This prevents double-processing of the same stream
 *   message if the consumer restarts after XACK fails while still allowing distinct
 *   lifecycle updates for one logical event_id (for example acknowledged -> filled).
 */

const { logger } = require('../logger/logger');

const STREAM_PREFIX = 'stream:';
const PROCESSED_KEY_TTL_SECONDS = 86400; // 1 trading day
const DEFAULT_BLOCK_MS = 2000;
const DEFAULT_BATCH_SIZE = 10;
const PENDING_REDELIVERY_IDLE_MS = 30000; // reclaim messages idle for 30s

class StreamPublisher {
  /**
   * @param {import('./redisClient').RedisClient} redisClient
   */
  constructor(redisClient) {
    this.redis = redisClient;
    this.client = redisClient.getClient();
  }

  /**
   * Publish a message to a Redis Stream.
   * @param {string} streamName  e.g. 'strategy_signals'
   * @param {object} data        Plain object — will be serialised as field/value pairs
   * @returns {Promise<string>}  The stream entry ID ('1234567890123-0')
   */
  async publish(streamName, data) {
    const streamKey = `${STREAM_PREFIX}${streamName}`;
    const payload = JSON.stringify(data);

    try {
      const id = await this.client.xadd(streamKey, '*', 'payload', payload);
      logger.debug('Stream event published', {
        event: 'stream_publish',
        streamKey,
        streamId: id,
        eventId: data.event_id || null,
      });
      return id;
    } catch (error) {
      logger.error('Stream publish failed', {
        event: 'stream_publish_error',
        streamKey,
        error: error.message,
      });
      throw error;
    }
  }
}

class StreamConsumer {
  /**
   * @param {import('./redisClient').RedisClient} redisClient
   * @param {object} options
   * @param {string} options.streamName      e.g. 'strategy_signals'
   * @param {string} options.groupName       e.g. 'order-manager'
   * @param {string} options.consumerName    e.g. 'order-manager-1'
   * @param {Function} options.handler       Async function called with parsed message
   * @param {number} [options.blockMs]       XREADGROUP BLOCK timeout in ms
   * @param {number} [options.batchSize]     Messages per read
   */
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.client = redisClient.getClient();
    this.streamName = options.streamName;
    this.groupName = options.groupName;
    this.consumerName = options.consumerName;
    this.handler = options.handler;
    this.blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.streamKey = `${STREAM_PREFIX}${this.streamName}`;
    this.running = false;
    this.pollLoop = null;
  }

  /**
   * Create consumer group if it does not already exist (idempotent).
   * Uses MKSTREAM so the stream is created if it doesn't exist.
   */
  async ensureGroup() {
    try {
      await this.client.xgroup('CREATE', this.streamKey, this.groupName, '$', 'MKSTREAM');
      logger.info('Consumer group created', {
        event: 'stream_group_created',
        streamKey: this.streamKey,
        groupName: this.groupName,
      });
    } catch (error) {
      if (error.message && error.message.includes('BUSYGROUP')) {
        // Group already exists — this is expected on restart
        return;
      }
      throw error;
    }
  }

  /**
   * Start the consumer loop in the background.
   * The loop reads new messages, then reclaims stuck pending messages.
   */
  async start() {
    await this.ensureGroup();
    this.running = true;
    logger.info('Stream consumer started', {
      event: 'stream_consumer_started',
      streamKey: this.streamKey,
      groupName: this.groupName,
      consumerName: this.consumerName,
    });

    this._runLoop();
  }

  stop() {
    this.running = false;
    logger.info('Stream consumer stopping', {
      event: 'stream_consumer_stopping',
      streamKey: this.streamKey,
      groupName: this.groupName,
    });
  }

  _runLoop() {
    const tick = async () => {
      if (!this.running) return;

      try {
        // Read new (undelivered) messages
        await this._readAndProcess('>');

        // Reclaim pending messages that have been idle too long (consumer crash recovery)
        await this._reclaimPending();
      } catch (error) {
        logger.error('Stream consumer loop error', {
          event: 'stream_consumer_loop_error',
          streamKey: this.streamKey,
          groupName: this.groupName,
          error: error.message,
        });
      }

      if (this.running) {
        setImmediate(tick);
      }
    };

    setImmediate(tick);
  }

  /**
   * Read messages from the stream and dispatch to handler.
   * @param {string} startId  '>' for new messages, or a message ID for pending replay
   */
  async _readAndProcess(startId) {
    const results = await this.client.xreadgroup(
      'GROUP', this.groupName, this.consumerName,
      'BLOCK', String(this.blockMs),
      'COUNT', String(this.batchSize),
      'STREAMS', this.streamKey, startId,
    );

    if (!results || results.length === 0) return;

    const [, entries] = results[0];
    if (!entries || entries.length === 0) return;

    for (const [messageId, fields] of entries) {
      await this._processEntry(messageId, fields);
    }
  }

  async _processEntry(messageId, fields) {
    // fields is an array like ['payload', '{...json...}']
    const payloadIndex = fields.indexOf('payload');
    if (payloadIndex === -1) {
      logger.warn('Stream message missing payload field', {
        event: 'stream_message_malformed',
        streamKey: this.streamKey,
        messageId,
      });
      await this._ack(messageId);
      return;
    }

    const rawPayload = fields[payloadIndex + 1];
    let data;
    try {
      data = JSON.parse(rawPayload);
    } catch {
      logger.warn('Stream message payload not valid JSON', {
        event: 'stream_message_parse_error',
        streamKey: this.streamKey,
        messageId,
      });
      await this._ack(messageId);
      return;
    }

    // Idempotency gate is message-level, not event-level. One logical order event_id
    // can legitimately produce multiple stream messages as the order moves through
    // acknowledged -> filled -> completed states.
    const eventId = data.event_id || null;
    const processedKey = messageId;
    const alreadyProcessed = await this._checkAndMarkProcessed(processedKey);
    if (alreadyProcessed) {
      logger.info('Stream message already processed — skipping', {
        event: 'stream_message_idempotent_skip',
        streamKey: this.streamKey,
        messageId,
        eventId,
      });
      await this._ack(messageId);
      return;
    }

    try {
      await this.handler(data);
      await this._ack(messageId);
      logger.debug('Stream message processed and acknowledged', {
        event: 'stream_message_ack',
        streamKey: this.streamKey,
        messageId,
        eventId,
      });
    } catch (error) {
      // Do NOT ack — message will be redelivered after PENDING_REDELIVERY_IDLE_MS
      logger.error('Stream message handler failed — will be redelivered', {
        event: 'stream_message_handler_error',
        streamKey: this.streamKey,
        messageId,
        eventId,
        error: error.message,
      });
    }
  }

  /**
   * Atomic SET NX for idempotency.
   * Returns true if the message was already processed.
   */
  async _checkAndMarkProcessed(processedKey) {
    const key = `processed:stream:${this.streamName}:${processedKey}`;
    try {
      const result = await this.redis.setNx(key, '1', PROCESSED_KEY_TTL_SECONDS);
      // 'OK' → first time seen (not processed), null → already exists (processed)
      return result === null;
    } catch {
      // Redis failure — assume not processed (safe: may cause duplicate delivery, not data loss)
      return false;
    }
  }

  async _ack(messageId) {
    try {
      await this.client.xack(this.streamKey, this.groupName, messageId);
    } catch (error) {
      logger.error('Stream XACK failed', {
        event: 'stream_xack_error',
        streamKey: this.streamKey,
        messageId,
        error: error.message,
      });
    }
  }

  /**
   * Reclaim pending messages from crashed consumers after idle timeout.
   */
  async _reclaimPending() {
    try {
      const pending = await this.client.xautoclaim(
        this.streamKey,
        this.groupName,
        this.consumerName,
        String(PENDING_REDELIVERY_IDLE_MS),
        '0-0',
        'COUNT', String(this.batchSize),
      );

      if (!pending) return;

      // XAUTOCLAIM returns [nextId, [[messageId, fields], ...]]
      const entries = Array.isArray(pending[1]) ? pending[1] : [];
      for (const [messageId, fields] of entries) {
        if (fields && fields.length > 0) {
          await this._processEntry(messageId, fields);
        }
      }
    } catch (error) {
      // XAUTOCLAIM requires Redis 6.2+ — log and skip if not available
      if (error.message && error.message.includes('ERR unknown command')) {
        logger.warn('XAUTOCLAIM not available — upgrade Redis to 6.2+ for pending message recovery', {
          event: 'stream_xautoclaim_unavailable',
          streamKey: this.streamKey,
        });
      }
      // Other errors: non-fatal, next loop iteration will retry
    }
  }
}

module.exports = { StreamPublisher, StreamConsumer };
