const fs = require("fs");
const path = require("path");
const pino = require("pino");

const logDir = process.env.LOG_FILE_PATH || "./logs";
const defaultServiceName = process.env.SERVICE_NAME || "algo-trading";

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const combinedLogStream = fs.createWriteStream(path.join(logDir, "combined.log"), {
  flags: "a",
});
const errorLogStream = fs.createWriteStream(path.join(logDir, "error.log"), {
  flags: "a",
});

const rawLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "message",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: combinedLogStream },
    { level: "error", stream: errorLogStream },
  ]),
).child({ service: defaultServiceName });

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLogArgs(messageOrMeta, metaOrMessage) {
  if (typeof messageOrMeta === "string") {
    return {
      message: messageOrMeta,
      meta: isPlainObject(metaOrMessage)
        ? metaOrMessage
        : metaOrMessage instanceof Error
          ? { err: metaOrMessage }
          : {},
    };
  }

  if (messageOrMeta instanceof Error) {
    return {
      message: typeof metaOrMessage === "string" ? metaOrMessage : messageOrMeta.message,
      meta: { err: messageOrMeta },
    };
  }

  if (isPlainObject(messageOrMeta)) {
    return {
      message: typeof metaOrMessage === "string" ? metaOrMessage : undefined,
      meta: messageOrMeta,
    };
  }

  return {
    message: typeof metaOrMessage === "string" ? metaOrMessage : undefined,
    meta: messageOrMeta === undefined ? {} : { value: messageOrMeta },
  };
}

function writeAtLevel(target, level, messageOrMeta, metaOrMessage) {
  const method = level === "critical" ? "fatal" : level;
  const logMethod = typeof target?.[method] === "function" ? target[method].bind(target) : target.info.bind(target);
  const { message, meta } = normalizeLogArgs(messageOrMeta, metaOrMessage);

  if (message !== undefined) {
    logMethod(meta, message);
    return;
  }

  if (Object.keys(meta).length > 0) {
    logMethod(meta);
    return;
  }

  logMethod("");
}

function wrapLogger(target) {
  return {
    child(bindings = {}) {
      return wrapLogger(target.child(bindings));
    },
    debug(messageOrMeta, metaOrMessage) {
      writeAtLevel(target, "debug", messageOrMeta, metaOrMessage);
    },
    info(messageOrMeta, metaOrMessage) {
      writeAtLevel(target, "info", messageOrMeta, metaOrMessage);
    },
    warn(messageOrMeta, metaOrMessage) {
      writeAtLevel(target, "warn", messageOrMeta, metaOrMessage);
    },
    error(messageOrMeta, metaOrMessage) {
      writeAtLevel(target, "error", messageOrMeta, metaOrMessage);
    },
    critical(messageOrMeta, metaOrMessage) {
      writeAtLevel(target, "critical", messageOrMeta, metaOrMessage);
    },
  };
}

const logger = wrapLogger(rawLogger);

const logAtLevel = (targetLogger, level, message, meta = {}) => {
  const normalizedLevel = String(level || "info").toLowerCase();
  const method = typeof targetLogger?.[normalizedLevel] === "function"
    ? normalizedLevel
    : "info";
  targetLogger[method](message, meta);
};

const childLogger = (serviceName, meta = {}) => {
  return logger.child({ service: serviceName, ...meta });
};

const createContextLogger = (context = {}) => {
  return logger.child(context);
};

module.exports = {
  logger,
  childLogger,
  createContextLogger,
  logAtLevel,
};
