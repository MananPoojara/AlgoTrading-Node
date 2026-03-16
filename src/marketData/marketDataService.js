require('dotenv').config();
const { childLogger } = require('../core/logger/logger');
const { getPublisher, CHANNELS } = require('../core/eventBus/publisher');
const { AngelWebSocket } = require('./angelWebsocket');
const { DataNormalizer } = require('./dataNormalizer');
const { InstrumentManager } = require('./instrumentManager');
const { query } = require('../database/postgresClient');
const { AngelOneBrokerAPI } = require('../execution/broker/angelOneBroker');
const { generateTOTP } = require('../core/utils/totp');
const config = require('../../config/default');

const SERVICE_NAME = 'market-data-service';
const logger = childLogger(SERVICE_NAME);
const DEFAULT_INSTRUMENT_REFRESH_MS = parseInt(
  process.env.MARKET_DATA_INSTRUMENT_REFRESH_MS,
  10,
) || 10000;
const SYMBOL_ALIASES = {
  NIFTY: ['NIFTY', 'NIFTY 50'],
  'NIFTY 50': ['NIFTY 50', 'NIFTY'],
  NIFTY50: ['NIFTY 50', 'NIFTY'],
  BANKNIFTY: ['BANKNIFTY', 'NIFTY BANK'],
  'NIFTY BANK': ['NIFTY BANK', 'BANKNIFTY'],
  FINNIFTY: ['FINNIFTY'],
  MIDCPNIFTY: ['MIDCPNIFTY'],
};

class MarketDataService {
  constructor() {
    this.isRunning = false;
    this.isStandby = false;
    this.publisher = null;
    this.ws = null;
    this.brokerApi = null;
    this.normalizer = new DataNormalizer();
    this.instrumentManager = new InstrumentManager();
    this.instrumentRefreshMs = DEFAULT_INSTRUMENT_REFRESH_MS;
    this.instrumentRefreshInterval = null;
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

    await this.refreshInstrumentSubscriptions({ reason: 'initialize' });

    logger.info('Market Data Service initialized');
  }

  async loadInstrumentsFromDatabase() {
    const strategyRows = await this.loadActiveStrategyRows();
    const requestedSymbols = this.extractRequestedSymbols(strategyRows);
    const resolvedInstruments = [];

    for (const symbol of requestedSymbols) {
      const instrument = await this.resolveInstrumentForSymbol(symbol);

      if (instrument) {
        resolvedInstruments.push(instrument);
      } else {
        logger.warn('No active instrument found for strategy subscription', {
          symbol,
        });
      }
    }

    const dedupedByToken = new Map();
    for (const instrument of resolvedInstruments) {
      dedupedByToken.set(String(instrument.token), instrument);
    }

    return Array.from(dedupedByToken.values());
  }

  async loadActiveStrategyRows() {
    const result = await query(
      `SELECT
         si.id AS instance_id,
         si.status,
         si.parameters AS instance_parameters,
         s.name AS strategy_name,
         s.file_path,
         s.parameters AS strategy_parameters
       FROM strategy_instances si
       JOIN strategies s ON s.id = si.strategy_id
       WHERE si.status IN ('running', 'paused')`,
    );

    return result.rows;
  }

  extractRequestedSymbols(rows = []) {
    const requested = new Set();

    for (const row of rows) {
      const candidates = [
        ...this.extractSymbolsFromParameters(row.instance_parameters),
        ...this.extractSymbolsFromParameters(row.strategy_parameters),
        ...this.deriveStrategyFallbackSymbols(row),
      ];

      for (const symbol of candidates) {
        requested.add(symbol);
      }
    }

    return Array.from(requested);
  }

  extractSymbolsFromParameters(parameters = {}) {
    if (!parameters || typeof parameters !== 'object') {
      return [];
    }

    const candidates = [];

    if (parameters.symbol) {
      candidates.push(parameters.symbol);
    }

    if (parameters.underlyingSymbol) {
      candidates.push(parameters.underlyingSymbol);
    }

    if (Array.isArray(parameters.symbols)) {
      candidates.push(...parameters.symbols);
    }

    return candidates
      .map((value) => this.normalizeSymbol(value))
      .filter(Boolean);
  }

  deriveStrategyFallbackSymbols(row = {}) {
    const strategyName = String(row.strategy_name || '').toUpperCase();
    const filePath = String(row.file_path || '').toUpperCase();
    const fingerprint = `${strategyName} ${filePath}`;

    if (fingerprint.includes('BANKNIFTY')) {
      return ['BANKNIFTY'];
    }

    if (fingerprint.includes('NIFTY')) {
      return ['NIFTY 50'];
    }

    return [];
  }

  normalizeSymbol(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) {
      return null;
    }

    const aliases = SYMBOL_ALIASES[normalized];
    return aliases ? aliases[0] : normalized;
  }

  expandSymbolAliases(symbol) {
    const normalized = this.normalizeSymbol(symbol);
    if (!normalized) {
      return [];
    }

    return SYMBOL_ALIASES[normalized] || [normalized];
  }

  async resolveInstrumentForSymbol(symbol) {
    const aliases = this.expandSymbolAliases(symbol);
    const result = await query(
      `SELECT
         exchange,
         symbol,
         instrument_token,
         underlying_symbol,
         instrument_type
       FROM instruments
       WHERE is_active = TRUE
         AND (
           UPPER(symbol) = ANY($1::text[])
           OR UPPER(COALESCE(underlying_symbol, '')) = ANY($1::text[])
         )
       ORDER BY
         CASE WHEN UPPER(symbol) = $2 THEN 0 ELSE 1 END,
         CASE WHEN instrument_type = 'INDEX' THEN 0 ELSE 1 END,
         symbol ASC
       LIMIT 1`,
      [aliases, aliases[0]],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      token: String(row.instrument_token),
      symbol: row.symbol,
      exchange: row.exchange,
      instrumentType: row.instrument_type,
      underlyingSymbol: row.underlying_symbol,
    };
  }

  async refreshInstrumentSubscriptions({ reason = 'periodic' } = {}) {
    const instruments = await this.loadInstrumentsFromDatabase();
    const desiredTokens = instruments.map((instrument) => String(instrument.token));
    const desiredTokenSet = new Set(desiredTokens);
    const currentTokens = this.instrumentManager.getSubscribedTokens().map(String);
    const currentTokenSet = new Set(currentTokens);

    for (const instrument of instruments) {
      this.instrumentManager.registerInstrument(
        instrument.token,
        instrument.symbol,
        instrument,
      );
    }

    const tokensToSubscribe = desiredTokens.filter(
      (token) => !currentTokenSet.has(token),
    );
    const tokensToUnsubscribe = currentTokens.filter(
      (token) => !desiredTokenSet.has(token),
    );

    if (tokensToSubscribe.length > 0) {
      this.subscribeToInstruments(tokensToSubscribe);
    }

    if (tokensToUnsubscribe.length > 0) {
      this.unsubscribeFromInstruments(tokensToUnsubscribe);
    }

    logger.info('Refreshed strategy-driven market subscriptions', {
      reason,
      desiredSymbols: instruments.map((instrument) => instrument.symbol),
      desiredTokens,
      subscribedAdded: tokensToSubscribe,
      subscribedRemoved: tokensToUnsubscribe,
    });

    return instruments;
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Market Data Service already running');
      return;
    }

    logger.info('Starting Market Data Service');
    this.stats.startedAt = new Date().toISOString();
    this.isRunning = true;

    if (!config.angelOne.apiKey) {
      this.isStandby = true;
      logger.warn('ANGEL_ONE_API_KEY is not set; market data service is running in standby mode');
      await this.publishSystemAlert('WARN', 'Market data feed credentials missing; service is in standby mode');
      return;
    }

    if (
      !config.angelOne.clientCode ||
      !config.angelOne.password ||
      !config.angelOne.totpSecret
    ) {
      this.isStandby = true;
      logger.warn(
        'Angel One client credentials are incomplete; market data service is running in standby mode',
      );
      await this.publishSystemAlert(
        'WARN',
        'Market data feed credentials incomplete; service is in standby mode',
      );
      return;
    }

    try {
      await this.initializeBrokerSession();

      this.ws = new AngelWebSocket({
        apiKey: config.angelOne.apiKey,
        clientCode: config.angelOne.clientCode,
        jwtToken: this.brokerApi.jwtToken,
        feedToken: this.brokerApi.feedToken,
        wsUrl: config.angelOne.wsUrl,
        onConnect: () => this.handleConnect(),
        onDisconnect: (code, reason) => this.handleDisconnect(code, reason),
        onError: (error) => this.handleError(error),
        onMessage: (message) => this.handleMessage(message),
      });

      await this.ws.connect();
      await this.ws.authenticate();
      
      await this.refreshInstrumentSubscriptions({ reason: 'post-connect' });
      this.startInstrumentRefresh();

    } catch (error) {
      if (config.paperMode) {
        this.isStandby = true;
        logger.warn('Market data startup failed; continuing in paper-mode standby', {
          error: error.message
        });
        await this.publishSystemAlert('WARN', `Market data standby mode: ${error.message}`);
        return;
      }

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
    this.isStandby = false;

    if (this.ws) {
      await this.ws.disconnect();
    }

    this.stopInstrumentRefresh();

    if (this.brokerApi?.isConnected) {
      await this.brokerApi.logout();
    }

    logger.info('Market Data Service stopped', { stats: this.stats });
  }

  async initializeBrokerSession() {
    this.brokerApi = new AngelOneBrokerAPI({
      apiKey: config.angelOne.apiKey,
      clientCode: config.angelOne.clientCode,
      password: config.angelOne.password,
    });

    const totp = generateTOTP(config.angelOne.totpSecret);
    const loginResult = await this.brokerApi.login(
      config.angelOne.clientCode,
      config.angelOne.password,
      totp,
    );

    if (!loginResult.success || !this.brokerApi.jwtToken || !this.brokerApi.feedToken) {
      const reason = loginResult.error || 'Angel One session initialization failed';
      throw new Error(reason);
    }

    logger.info('Angel One REST session initialized for market data');
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

  async handleMessage(message) {
    try {
      if (message.feedType === 'quote' || message.feedType === 'tick') {
        const tick = this.normalizer.normalizeTick(message);
        
        if (tick) {
          const instrument = this.instrumentManager.getInstrument(
            tick.instrument_token,
          );
          const normalizedTick = instrument?.symbol
            ? { ...tick, symbol: instrument.symbol }
            : tick;

          this.stats.ticksReceived++;
          await this.publishTick(normalizedTick);
        }
      } else if (message.feedType === 'ohlc') {
        const ohlc = this.normalizer.normalizeOHLC(message);
        if (ohlc) {
          const instrument = this.instrumentManager.getInstrument(
            ohlc.instrument_token,
          );
          const normalizedOhlc = instrument?.symbol
            ? { ...ohlc, symbol: instrument.symbol }
            : ohlc;

          this.stats.ticksReceived++;
          await this.publishTick(normalizedOhlc);
        }
      }
    } catch (error) {
      logger.error('Error handling message', { error: error.message });
      this.stats.errors++;
    }
  }

  async publishTick(tick) {
    try {
      await this.persistTick(tick);
      await this.publisher.publishMarketTick(tick);
      this.stats.ticksPublished++;
    } catch (error) {
      logger.error('Failed to publish tick', { error: error.message, tick });
    }
  }

  async persistTick(tick) {
    if (!tick?.instrument_token || !tick?.timestamp) {
      return;
    }

    await query(
      `INSERT INTO market_ticks (
         instrument_token, symbol, exchange, ltp, open, high, low, close,
         volume, bid, ask, bid_quantity, ask_quantity, timestamp
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14
       )`,
      [
        String(tick.instrument_token),
        tick.symbol || String(tick.instrument_token),
        tick.exchange || 'NSE',
        Number(tick.ltp || 0),
        Number(tick.open || 0),
        Number(tick.high || 0),
        Number(tick.low || 0),
        Number(tick.close || 0),
        Number(tick.volume || 0),
        Number(tick.bid || 0),
        Number(tick.ask || 0),
        Number(tick.bid_quantity || 0),
        Number(tick.ask_quantity || 0),
        tick.timestamp,
      ],
    );
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

  startInstrumentRefresh() {
    this.stopInstrumentRefresh();

    this.instrumentRefreshInterval = setInterval(() => {
      this.refreshInstrumentSubscriptions({ reason: 'interval' }).catch((error) => {
        logger.error('Failed to refresh instrument subscriptions', {
          error: error.message,
        });
      });
    }, this.instrumentRefreshMs);
  }

  stopInstrumentRefresh() {
    if (this.instrumentRefreshInterval) {
      clearInterval(this.instrumentRefreshInterval);
      this.instrumentRefreshInterval = null;
    }
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
      isStandby: this.isStandby,
      bufferStats: this.normalizer.getBufferStats(),
      instrumentCount: this.instrumentManager.getInstrumentCount(),
      subscriptionCount: this.instrumentManager.getSubscriptionCount(),
      wsStatus: this.ws ? this.ws.getConnectionStatus() : null
    };
  }

  getHealth() {
    return {
      status: this.isRunning ? (this.isStandby ? 'degraded' : 'healthy') : 'stopped',
      uptime: this.stats.startedAt 
        ? Date.now() - new Date(this.stats.startedAt).getTime()
        : 0,
      ticksReceived: this.stats.ticksReceived,
      ticksPublished: this.stats.ticksPublished,
      errors: this.stats.errors,
      standby: this.isStandby
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
