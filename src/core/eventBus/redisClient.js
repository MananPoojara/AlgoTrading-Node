const Redis = require('ioredis');
const { logger } = require('../logger/logger');

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

class RedisClient {
  constructor(options = {}) {
    this.options = {
      host: options.host || REDIS_HOST,
      port: options.port || REDIS_PORT,
      password: options.password || REDIS_PASSWORD,
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      enableReadyCheck: true,
      lazyConnect: false,
      connectTimeout: 10000,
      ...options
    };

    this.client = new Redis(this.options);
    this.subscriber = new Redis(this.options);
    this.publisher = new Redis(this.options);
    this.connected = false;
    
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    const handleError = (err, clientName) => {
      logger.error(`Redis ${clientName} error`, { 
        error: err.message,
        stack: err.stack 
      });
    };

    this.client.on('error', (err) => handleError(err, 'client'));
    this.subscriber.on('error', (err) => handleError(err, 'subscriber'));
    this.publisher.on('error', (err) => handleError(err, 'publisher'));

    this.client.on('connect', () => {
      logger.info('Redis client connected');
    });

    this.client.on('ready', () => {
      logger.info('Redis client ready');
    });

    this.client.on('close', () => {
      logger.warn('Redis client connection closed');
    });

    this.client.on('reconnecting', () => {
      logger.info('Redis client reconnecting...');
    });
  }

  async connect() {
    try {
      await this.client.connect();
      await this.subscriber.connect();
      await this.publisher.connect();
      logger.info('All Redis connections established');
    } catch (error) {
      logger.error('Failed to connect Redis', { error: error.message });
      throw error;
    }
  }

  async disconnect() {
    await Promise.all([
      this.client.quit(),
      this.subscriber.quit(),
      this.publisher.quit()
    ]);
    logger.info('All Redis connections closed');
  }

  async healthCheck() {
    try {
      const result = await this.client.ping();
      return { status: result === 'PONG' ? 'online' : 'degraded', latency: 0 };
    } catch (error) {
      return { status: 'offline', error: error.message };
    }
  }

  async publish(channel, message) {
    try {
      const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
      await this.publisher.publish(channel, messageStr);
      return true;
    } catch (error) {
      logger.error('Redis publish failed', { channel, error: error.message });
      throw error;
    }
  }

  async subscribe(channel, callback) {
    try {
      await this.subscriber.subscribe(channel);
      this.subscriber.on('message', (ch, message) => {
        if (ch === channel) {
          try {
            const parsed = JSON.parse(message);
            callback(parsed);
          } catch {
            callback(message);
          }
        }
      });
    } catch (error) {
      logger.error('Redis subscribe failed', { channel, error: error.message });
      throw error;
    }
  }

  async set(key, value, ttl = null) {
    try {
      if (ttl) {
        return await this.client.set(key, value, 'EX', ttl);
      }
      return await this.client.set(key, value);
    } catch (error) {
      logger.error('Redis set failed', { key, error: error.message });
      throw error;
    }
  }

  async get(key) {
    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error('Redis get failed', { key, error: error.message });
      throw error;
    }
  }

  async setNx(key, value, ttl = 5) {
    try {
      return await this.client.set(key, value, 'NX', 'EX', ttl);
    } catch (error) {
      logger.error('Redis setNx failed', { key, error: error.message });
      throw error;
    }
  }

  async del(key) {
    try {
      return await this.client.del(key);
    } catch (error) {
      logger.error('Redis del failed', { key, error: error.message });
      throw error;
    }
  }

  async incr(key) {
    try {
      return await this.client.incr(key);
    } catch (error) {
      logger.error('Redis incr failed', { key, error: error.message });
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      return await this.client.expire(key, seconds);
    } catch (error) {
      logger.error('Redis expire failed', { key, seconds, error: error.message });
      throw error;
    }
  }

  async hset(key, field, value) {
    try {
      return await this.client.hset(key, field, value);
    } catch (error) {
      logger.error('Redis hset failed', { key, field, error: error.message });
      throw error;
    }
  }

  async hget(key, field) {
    try {
      return await this.client.hget(key, field);
    } catch (error) {
      logger.error('Redis hget failed', { key, field, error: error.message });
      throw error;
    }
  }

  async hgetall(key) {
    try {
      return await this.client.hgetall(key);
    } catch (error) {
      logger.error('Redis hgetall failed', { key, error: error.message });
      throw error;
    }
  }

  async sadd(key, ...members) {
    try {
      return await this.client.sadd(key, ...members);
    } catch (error) {
      logger.error('Redis sadd failed', { key, error: error.message });
      throw error;
    }
  }

  async smembers(key) {
    try {
      return await this.client.smembers(key);
    } catch (error) {
      logger.error('Redis smembers failed', { key, error: error.message });
      throw error;
    }
  }

  getClient() {
    return this.client;
  }

  getSubscriber() {
    return this.subscriber;
  }

  getPublisher() {
    return this.publisher;
  }
}

let redisClient = null;

const getRedisClient = (options = {}) => {
  if (!redisClient) {
    redisClient = new RedisClient(options);
  }
  return redisClient;
};

module.exports = {
  RedisClient,
  getRedisClient
};
