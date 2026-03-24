const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

const requireInProduction = (value, name) => {
  if (isProduction && !value) {
    throw new Error(`Required environment variable ${name} is not set in production`);
  }
  return value;
};

const clampIntradaySquareOff = (value, fallback = "15:15") => {
  const normalized = String(value || fallback);
  return normalized > fallback ? fallback : normalized;
};

const configuredSquareOff = clampIntradaySquareOff(process.env.AUTO_SQUARE_OFF_TIME);

const config = {
  env: process.env.NODE_ENV || 'development',

  api: {
    port: parseInt(process.env.API_PORT || process.env.PORT, 10) || 3001,
    host: process.env.API_HOST || process.env.HOST || '0.0.0.0',
    allowedOrigins: process.env.ALLOWED_ORIGINS || 'http://localhost:3000'
  },

  ws: {
    port: parseInt(process.env.WS_PORT, 10) || 8080
  },
  
  server: {
    port: parseInt(process.env.PORT, 10) || 3001,
    host: process.env.HOST || '0.0.0.0'
  },

  database: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT, 10) || 5432,
    database: process.env.POSTGRES_DB || 'algo_trading',
    user: process.env.POSTGRES_USER || 'algo',
    password: isProduction 
      ? requireInProduction(process.env.POSTGRES_PASSWORD, 'POSTGRES_PASSWORD')
      : (process.env.POSTGRES_PASSWORD || 'algo123'),
    pool: {
      max: 20,
      min: 2,
      idleTimeoutMillis: 30000
    }
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    }
  },

  jwt: {
    secret: isProduction
      ? requireInProduction(process.env.JWT_SECRET, 'JWT_SECRET')
      : (process.env.JWT_SECRET || 'dev-only-insecure-secret'),
    expiresIn: process.env.JWT_EXPIRY || '8h'
  },

  encryption: {
    key: isProduction
      ? requireInProduction(process.env.ENCRYPTION_KEY, 'ENCRYPTION_KEY')
      : (process.env.ENCRYPTION_KEY || 'dev-only-32-char-insecure-ky')
  },

  paperMode: process.env.PAPER_MODE === 'true',

  riskLimits: {
    defaultMaxDailyLoss: parseInt(process.env.DEFAULT_MAX_DAILY_LOSS, 10) || 50000,
    defaultMaxOpenPositions: parseInt(process.env.DEFAULT_MAX_OPEN_POSITIONS, 10) || 10,
    defaultMaxLotsPerTrade: parseInt(process.env.DEFAULT_MAX_LOTS_PER_TRADE, 10) || 5,
    defaultSignalCooldownSeconds: parseInt(process.env.DEFAULT_SIGNAL_COOLDOWN_SECONDS, 10) || 5
  },

  risk: {
    policyMode:
      process.env.RISK_POLICY_MODE ||
      (process.env.PAPER_MODE === 'true' ? 'paper_warn_only' : 'live_enforce'),
    maxPositionSize: parseInt(process.env.MAX_POSITION_SIZE, 10) || 1000000,
    maxDailyLoss: parseInt(process.env.MAX_DAILY_LOSS, 10) || 50000,
    maxExposure: parseInt(process.env.MAX_EXPOSURE, 10) || 5000000,
    maxMarginUsage: parseFloat(process.env.MAX_MARGIN_USAGE || '0.8'),
    maxOpenOrders: parseInt(process.env.MAX_OPEN_ORDERS, 10) || 10,
    availableMargin: parseInt(process.env.AVAILABLE_MARGIN, 10) || 1000000,
    operatorApprovalTimeoutSeconds:
      parseInt(process.env.OPERATOR_APPROVAL_TIMEOUT_SECONDS, 10) || 30,
    allowShortSelling: process.env.ALLOW_SHORT_SELLING === 'true'
  },

  marketHours: {
    open: process.env.MARKET_OPEN_TIME || '09:15',
    close: process.env.MARKET_CLOSE_TIME || '15:30',
    squareOff: configuredSquareOff
  },

  scheduler: {
    enabled: process.env.MARKET_SCHEDULER_ENABLED !== 'false',
    pollMs: parseInt(process.env.MARKET_SCHEDULER_POLL_MS, 10) || 30000,
    feedStart: process.env.MARKET_FEED_START_TIME || '09:00',
    strategyStart: process.env.STRATEGY_START_TIME || '09:15',
    squareOff: configuredSquareOff,
    strategyPause: process.env.STRATEGY_STOP_TIME || '15:45',
    feedStop: process.env.MARKET_FEED_STOP_TIME || '16:10',
    archiveRoot: process.env.MARKET_TICK_ARCHIVE_ROOT || './data/market-archive',
    archiveBatchSize:
      parseInt(process.env.MARKET_TICK_ARCHIVE_BATCH_SIZE, 10) || 50000,
  },

  angelOne: {
    apiKey: process.env.ANGEL_ONE_API_KEY || '',
    apiSecret: process.env.ANGEL_ONE_API_SECRET || '',
    clientCode: process.env.ANGEL_ONE_CLIENT_CODE || '',
    password: process.env.ANGEL_ONE_PASSWORD || '',
    totpSecret: process.env.ANGEL_ONE_TOTP_SECRET || '',
    apiUrl: process.env.ANGEL_ONE_API_URL || 'https://apiconnect.angelone.in',
    wsUrl: process.env.ANGEL_ONE_WS_URL || 'wss://smartapisocket.angelone.in/smart-stream'
  },

  angelOneHistorical: {
    enabled: process.env.ANGEL_ONE_HISTORICAL_ENABLED !== 'false',
    apiKey:
      process.env.ANGEL_ONE_HISTORICAL_API_KEY || process.env.ANGEL_ONE_API_KEY || '',
    clientCode:
      process.env.ANGEL_ONE_HISTORICAL_CLIENT_CODE ||
      process.env.ANGEL_ONE_CLIENT_CODE ||
      '',
    password:
      process.env.ANGEL_ONE_HISTORICAL_PASSWORD || process.env.ANGEL_ONE_PASSWORD || '',
    totpSecret:
      process.env.ANGEL_ONE_HISTORICAL_TOTP_SECRET ||
      process.env.ANGEL_ONE_TOTP_SECRET ||
      '',
    lookbackDays: parseInt(process.env.ANGEL_ONE_HISTORICAL_LOOKBACK_DAYS, 10) || 730,
    maxDaysPerRequest:
      parseInt(process.env.ANGEL_ONE_HISTORICAL_MAX_DAYS_PER_REQUEST, 10) || 365,
    maxRequestsPerSecond:
      parseInt(process.env.ANGEL_ONE_HISTORICAL_MAX_REQUESTS_PER_SECOND, 10) || 3,
    maxRequestsPerMinute:
      parseInt(process.env.ANGEL_ONE_HISTORICAL_MAX_REQUESTS_PER_MINUTE, 10) || 180,
    rateLimitRetryDelayMs:
      parseInt(process.env.ANGEL_ONE_HISTORICAL_RATE_LIMIT_RETRY_DELAY_MS, 10) ||
      61000,
    maxRetries:
      parseInt(process.env.ANGEL_ONE_HISTORICAL_MAX_RETRIES, 10) || 2,
  },

  xts: {
    apiKey: process.env.XTS_API_KEY || '',
    apiSecret: process.env.XTS_API_SECRET || '',
    interactiveUrl: process.env.XTS_INTERACTIVE_URL || 'https://xtsapi.co.in',
    marketDataUrl: process.env.XTS_MARKET_DATA_URL || 'https://mdxapi.co.in'
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    filePath: process.env.LOG_FILE_PATH || './logs',
    apiRequestLevel: process.env.API_REQUEST_LOG_LEVEL || 'debug',
    websocketClientLevel:
      process.env.WS_CLIENT_LOG_LEVEL || process.env.WEBSOCKET_CLIENT_LOG_LEVEL || 'debug',
    marketDataRefreshLevel: process.env.MARKET_DATA_REFRESH_LOG_LEVEL || 'debug',
  },

  heartbeat: {
    intervalSeconds: 30,
    timeoutSeconds: 60
  },

  orderRetry: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    backoffMultiplier: 2
  }
};

module.exports = config;
