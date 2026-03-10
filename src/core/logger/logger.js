const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = process.env.LOG_FILE_PATH || './logs';

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, service, client_id, strategy_id, message, detail, ...meta }) => {
    const log = {
      timestamp,
      level,
      service: service || 'unknown',
      ...(client_id && { client_id }),
      ...(strategy_id && { strategy_id }),
      message,
      ...(detail && { detail }),
      ...(Object.keys(meta).length > 0 && { meta })
    };
    return JSON.stringify(log);
  })
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, service, message }) => {
    return `${timestamp} [${service || 'app'}] ${level}: ${message}`;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: process.env.SERVICE_NAME || 'algo-trading' },
  transports: [
    new winston.transports.Console({
      format: consoleFormat
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10
    })
  ],
  exitOnError: false
});

const childLogger = (serviceName, meta = {}) => {
  return logger.child({ service: serviceName, ...meta });
};

const createContextLogger = (context) => {
  return {
    debug: (message, meta = {}) => logger.debug(message, { ...context, ...meta }),
    info: (message, meta = {}) => logger.info(message, { ...context, ...meta }),
    warn: (message, meta = {}) => logger.warn(message, { ...context, ...meta }),
    error: (message, meta = {}) => logger.error(message, { ...context, ...meta }),
    critical: (message, meta = {}) => logger.critical(message, { ...context, ...meta })
  };
};

module.exports = {
  logger,
  childLogger,
  createContextLogger
};
