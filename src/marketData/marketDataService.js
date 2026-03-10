require('dotenv').config();
const { logger, childLogger } = require('../core/logger/logger');
const { getPublisher, CHANNELS } = require('../core/eventBus/publisher');
const { AngelWebSocket } = require('./angelWebsocket');
const { DataNormalizer } = require('./dataNormalizer');
const { InstrumentManager } = require('./instrumentManager');
const config = require('../../config/default');

const SERVICE_NAME = 'market-data-service';
const logger = childLogger(SERVICE_NAME);

class MarketDataService {
  constructor() {
    this.isRunning = false;
    this.publisher = null;
    this.ws = null;
    this.normalizer = new DataNormalizer();
    this.instrumentManager = new InstrumentManager();
    this.stats = {
      ticksReceived: 0,
      ticksPublished: 0,
      errors: 0,
      startedAt: null
    };
  }

  async initialize() {
    logger.info('Initializing Market Data Service');

    this.publisher = getPublisher();

    await this.initializeDefaultInstruments();

    logger.info('Market Data Service initialized');
  }

  async initializeDefaultInstruments() {
    // TODO: Query strategy_instances from DB to get required instruments dynamically
    // Per SRD Section 6.2, should query active strategies and collect instruments
    const defaultInstruments = [
      { token: '260105', symbol: 'NIFTY 50', exchange: 'NSE' },
      { token: '260001', symbol: 'BANKNIFTY', exchange: 'NSE' },
      { token: '26000', symbol: 'NIFTY BANK', exchange: 'NSE' }
    ];

    this.instrumentManager.registerInstruments(defaultInstruments);
    
    const tokens = defaultInstruments.map(i => i.token);
    this.subscribeToInstruments(tokens);
    
    logger.info('Default instruments registered and subscribed', { tokens });
  }

  async loadInstrumentsFromDatabase() {
    // TODO: Implement database query to load instruments from active strategy_instances
    // This will be called after Phase 3 when database integration is ready
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Market Data Service already running');
      return;
    }

    logger.info('Starting Market Data Service');
    this.stats.startedAt = new Date().toISOString();
    this.isRunning = true;

    this.ws = new AngelWebSocket({
      apiKey: config.angelOne.apiKey,
      wsUrl: config.angelOne.wsUrl,
      onConnect: () => this.handleConnect(),
      onDisconnect: (code, reason) => this.handleDisconnect(code, reason),
      onError: (error) => this.handleError(error),
      onMessage: (message) => this.handleMessage(message)
    });

    try {
      await this.ws.connect();
      await this.ws.authenticate();
      
      const tokens = this.instrumentManager.getSubscribedTokens();
      if (tokens.length > 0) {
        this.ws.subscribe(tokens);
      }

    } catch (error) {
      logger.error('Failed to start Market Data Service', { error: error.message });
      this.isRunning = false;
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping Market Data Service');
    this.isRunning = false;

    if (this.ws) {
      await this.ws.disconnect();
    }

    logger.info('Market Data Service stopped', { stats: this.stats });
  }

  handleConnect() {
    logger.info('WebSocket connected');
    
    this.publishSystemAlert('INFO', 'Market data WebSocket connected');

    const tokens = this.instrumentManager.getSubscribedTokens();
    if (tokens.length > 0) {
      this.ws.subscribe(tokens);
    }
  }

  handleDisconnect(code, reason) {
    logger.warn('WebSocket disconnected', { code, reason });
    this.publishSystemAlert('WARN', `Market data WebSocket disconnected: ${code}`);
  }

  handleError(error) {
    logger.error('WebSocket error', { error: error.message });
    this.stats.errors++;
  }

  handleMessage(message) {
    try {
      if (message.feedType === 'quote' || message.feedType === 'tick') {
        const tick = this.normalizer.normalizeTick(message);
        
        if (tick) {
          this.stats.ticksReceived++;
          this.publishTick(tick);
        }
      } else if (message.feedType === 'ohlc') {
        const ohlc = this.normalizer.normalizeOHLC(message);
        if (ohlc) {
          this.stats.ticksReceived++;
          this.publishTick(ohlc);
        }
      }
    } catch (error) {
      logger.error('Error handling message', { error: error.message });
      this.stats.errors++;
    }
  }

  async publishTick(tick) {
    try {
      await this.publisher.publishMarketTick(tick);
      this.stats.ticksPublished++;
    } catch (error) {
      logger.error('Failed to publish tick', { error: error.message, tick });
    }
  }

  async publishSystemAlert(level, message) {
    try {
      await this.publisher.publishSystemAlert({
        level,
        service: SERVICE_NAME,
        message
      });
    } catch (error) {
      logger.error('Failed to publish alert', { error: error.message });
    }
  }

  subscribeToInstruments(tokens) {
    for (const token of tokens) {
      this.instrumentManager.subscribe(token);
    }

    if (this.ws && this.ws.isConnected) {
      this.ws.subscribe(tokens);
    }

    logger.info('Subscribed to instruments', { tokens });
  }

  unsubscribeFromInstruments(tokens) {
    for (const token of tokens) {
      this.instrumentManager.unsubscribe(token);
    }

    if (this.ws && this.ws.isConnected) {
      this.ws.unsubscribe(tokens);
    }

    logger.info('Unsubscribed from instruments', { tokens });
  }

  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      bufferStats: this.normalizer.getBufferStats(),
      instrumentCount: this.instrumentManager.getInstrumentCount(),
      subscriptionCount: this.instrumentManager.getSubscriptionCount(),
      wsStatus: this.ws ? this.ws.getConnectionStatus() : null
    };
  }

  getHealth() {
    return {
      status: this.isRunning ? 'healthy' : 'stopped',
      uptime: this.stats.startedAt 
        ? Date.now() - new Date(this.stats.startedAt).getTime()
        : 0,
      ticksReceived: this.stats.ticksReceived,
      ticksPublished: this.stats.ticksPublished,
      errors: this.stats.errors
    };
  }
}

let serviceInstance = null;

const getService = () => {
  if (!serviceInstance) {
    serviceInstance = new MarketDataService();
  }
  return serviceInstance;
};

async function main() {
  const service = getService();
  
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    await service.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    await service.stop();
    process.exit(0);
  });

  try {
    await service.initialize();
    await service.start();
    
    logger.info('Market Data Service is running');
  } catch (error) {
    logger.error('Failed to start Market Data Service', { error: error.message });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { MarketDataService, getService };
