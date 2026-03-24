const { logger } = require('../../../packages/core/logger/logger');
const { formatIST } = require('../../../packages/core/utils/time');

class OrderQueue {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 1000;
    this.orders = new Map();
    this.queue = [];
    this.processing = false;
    this.processingOrder = null;
  }

  enqueue(order) {
    if (this.queue.length >= this.maxSize) {
      logger.warn('Order queue full', { maxSize: this.maxSize });
      return false;
    }

    const orderKey = this.getOrderKey(order);
    
    if (this.orders.has(orderKey)) {
      logger.warn('Order already in queue', { orderKey });
      return false;
    }

    const queueItem = {
      order,
      enqueuedAt: formatIST(),
      priority: order.priority || 0,
      retries: 0
    };

    this.orders.set(orderKey, queueItem);
    this.queue.push(queueItem);
    this.queue.sort((a, b) => b.priority - a.priority);

    logger.info('Order enqueued', {
      orderId: order.id,
      eventId: order.event_id,
      queueSize: this.queue.length
    });

    return true;
  }

  dequeue() {
    if (this.queue.length === 0) {
      return null;
    }

    const item = this.queue.shift();
    item.processingAt = formatIST();
    this.processingOrder = item;

    logger.info('Order dequeued', {
      orderId: item.order.id,
      eventId: item.order.event_id,
      remaining: this.queue.length
    });

    return item;
  }

  complete(orderId) {
    const orderKey = this.getOrderKeyById(orderId);
    
    if (this.processingOrder && this.processingOrder.order.id === orderId) {
      this.orders.delete(orderKey);
      this.processingOrder = null;
      logger.info('Order completed', { orderId });
      return true;
    }

    const item = this.queue.find(i => i.order.id === orderId);
    if (item) {
      this.queue = this.queue.filter(i => i.order.id !== orderId);
      this.orders.delete(orderKey);
      logger.info('Order removed from queue', { orderId });
      return true;
    }

    return false;
  }

  remove(orderId) {
    const orderKey = this.getOrderKeyById(orderId);
    
    this.orders.delete(orderKey);
    this.queue = this.queue.filter(i => i.order.id !== orderId);
    
    if (this.processingOrder && this.processingOrder.order.id === orderId) {
      this.processingOrder = null;
    }

    logger.info('Order removed', { orderId, remaining: this.queue.length });
  }

  retry(orderId) {
    const orderKey = this.getOrderKeyById(orderId);
    const item = this.orders.get(orderKey);

    if (item) {
      item.retries++;
      item.lastRetryAt = formatIST();
      
      this.queue.push(item);
      this.queue.sort((a, b) => b.priority - a.priority);
      
      logger.info('Order requeued for retry', { orderId, retries: item.retries });
      return true;
    }

    return false;
  }

  getOrderKey(order) {
    if (order?.id !== undefined && order?.id !== null) {
      return `order_id_${order.id}`;
    }

    if (order?.event_id) {
      return `event_id_${order.event_id}`;
    }

    return `${order.client_id}_${order.symbol}_${order.side}`;
  }

  getOrderKeyById(orderId) {
    for (const [key, item] of this.orders) {
      if (item.order.id === orderId) {
        return key;
      }
    }
    return null;
  }

  getSize() {
    return this.queue.length;
  }

  getProcessingOrder() {
    return this.processingOrder?.order || null;
  }

  isEmpty() {
    return this.queue.length === 0 && !this.processingOrder;
  }

  isFull() {
    return this.queue.length >= this.maxSize;
  }

  getAll() {
    return {
      queue: this.queue.map(i => i.order),
      processing: this.processingOrder?.order || null,
      size: this.queue.length
    };
  }

  clear() {
    this.orders.clear();
    this.queue = [];
    this.processingOrder = null;
    logger.info('Order queue cleared');
  }
}

module.exports = { OrderQueue };
