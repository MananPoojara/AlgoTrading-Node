const { logger } = require('../../core/logger/logger');
const { query } = require('../../database/postgresClient');

class OrderValidator {
  constructor() {
    this.seenEventIds = new Set();
  }

  async validateSignal(signal) {
    const errors = [];

    if (!signal) {
      errors.push('Signal is null or undefined');
      return { valid: false, errors };
    }

    if (!signal.event_id) {
      errors.push('Missing event_id');
    }

    if (!signal.client_id) {
      errors.push('Missing client_id');
    }

    if (!signal.strategy_instance_id) {
      errors.push('Missing strategy_instance_id');
    }

    if (!signal.action || !['BUY', 'SELL'].includes(signal.action)) {
      errors.push('Invalid action - must be BUY or SELL');
    }

    if (!signal.instrument) {
      errors.push('Missing instrument');
    }

    if (!signal.quantity || signal.quantity <= 0) {
      errors.push('Invalid quantity - must be positive');
    }

    if (!signal.price_type || !['MARKET', 'LIMIT'].includes(signal.price_type)) {
      errors.push('Invalid price_type - must be MARKET or LIMIT');
    }

    if (signal.price_type === 'LIMIT' && (!signal.price || signal.price <= 0)) {
      errors.push('Limit price must be positive');
    }

    const valid = errors.length === 0;

    if (valid) {
      logger.debug('Signal validation passed', { eventId: signal.event_id });
    } else {
      logger.warn('Signal validation failed', { eventId: signal.event_id, errors });
    }

    return { valid, errors };
  }

  async checkDuplicateSignal(signal) {
    if (this.seenEventIds.has(signal.event_id)) {
      return {
        isDuplicate: true,
        existingSignalId: null,
        existingStatus: 'in_memory_cache'
      };
    }

    try {
      const result = await query(
        'SELECT id, status FROM signals WHERE event_id = $1',
        [signal.event_id]
      );

      if (result.rows.length > 0) {
        this.seenEventIds.add(signal.event_id);

        logger.warn('Duplicate signal detected', {
          eventId: signal.event_id,
          existingStatus: result.rows[0].status
        });
        return {
          isDuplicate: true,
          existingSignalId: result.rows[0].id,
          existingStatus: result.rows[0].status
        };
      }

      this.seenEventIds.add(signal.event_id);

      return { isDuplicate: false };
    } catch (error) {
      logger.error('Error checking duplicate signal', { error: error.message });
      return { isDuplicate: false, error: error.message };
    }
  }

  async checkDuplicateOrder(signal) {
    try {
      const result = await query(
        `SELECT id, status FROM orders 
         WHERE event_id = $1 
         AND status NOT IN ('filled', 'rejected', 'cancelled')`,
        [signal.event_id]
      );

      if (result.rows.length > 0) {
        logger.warn('Duplicate order detected', {
          eventId: signal.event_id,
          existingStatus: result.rows[0].status
        });
        return {
          isDuplicate: true,
          existingOrderId: result.rows[0].id,
          existingStatus: result.rows[0].status
        };
      }

      return { isDuplicate: false };
    } catch (error) {
      logger.error('Error checking duplicate order', { error: error.message });
      return { isDuplicate: false, error: error.message };
    }
  }

  async checkActiveOrdersForSymbol(clientId, symbol) {
    try {
      const result = await query(
        `SELECT id, side, quantity, filled_quantity, status, instrument 
         FROM orders 
         WHERE client_id = $1 
         AND symbol = $2 
         AND status NOT IN ('filled', 'rejected', 'cancelled')`,
        [clientId, symbol]
      );

      if (result.rows.length > 0) {
        logger.info('Active orders exist for symbol', {
          clientId,
          symbol,
          count: result.rows.length,
          orders: result.rows.map(o => ({ id: o.id, status: o.status }))
        });
        return {
          hasActiveOrders: true,
          orders: result.rows
        };
      }

      return { hasActiveOrders: false };
    } catch (error) {
      logger.error('Error checking active orders', { error: error.message });
      return { hasActiveOrders: false, error: error.message };
    }
  }

  async validateComplete(signal) {
    const validation = await this.validateSignal(signal);
    if (!validation.valid) {
      return { valid: false, reason: 'validation_failed', errors: validation.errors };
    }

    const duplicateSignal = await this.checkDuplicateSignal(signal);
    if (duplicateSignal.isDuplicate) {
      return { valid: false, reason: 'duplicate_signal', ...duplicateSignal };
    }

    const duplicateOrder = await this.checkDuplicateOrder(signal);
    if (duplicateOrder.isDuplicate) {
      return { valid: false, reason: 'duplicate_order', ...duplicateOrder };
    }

    return { valid: true };
  }

  clearCache() {
    this.seenEventIds.clear();
    logger.info('Order validator cache cleared');
  }
}

module.exports = { OrderValidator };
