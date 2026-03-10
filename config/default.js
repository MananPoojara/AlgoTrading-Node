const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

const requireInProduction = (value, name) => {
  if (isProduction && !value) {
    throw new Error(`Required environment variable ${name} is not set in production`);
  }
  return value;
};

const config = {
  env: process.env.NODE_ENV || 'development',
  
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

  marketHours: {
    open: process.env.MARKET_OPEN_TIME || '09:15',
    close: process.env.MARKET_CLOSE_TIME || '15:30',
    squareOff: process.env.AUTO_SQUARE_OFF_TIME || '15:15'
  },

  angelOne: {
    apiKey: process.env.ANGEL_ONE_API_KEY || '',
    apiSecret: process.env.ANGEL_ONE_API_SECRET || '',
    wsUrl: process.env.ANGEL_ONE_WS_URL || 'wss://ws.angelone.in/smart-order'
  },

  xts: {
    apiKey: process.env.XTS_API_KEY || '',
    apiSecret: process.env.XTS_API_SECRET || '',
    interactiveUrl: process.env.XTS_INTERACTIVE_URL || 'https://xtsapi.co.in',
    marketDataUrl: process.env.XTS_MARKET_DATA_URL || 'https://mdxapi.co.in'
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    filePath: process.env.LOG_FILE_PATH || './logs'
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
