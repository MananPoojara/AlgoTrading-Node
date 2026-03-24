const { logger } = require("../../../../packages/core/logger/logger");

const rateLimitStore = new Map();

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_REQUESTS = 100;

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const maxRequests = options.maxRequests || DEFAULT_MAX_REQUESTS;
  const keyGenerator =
    options.keyGenerator || ((req) => req.ip || req.connection.remoteAddress);

  return async (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();

    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, {
        count: 0,
        resetTime: now + windowMs,
      });
    }

    const record = rateLimitStore.get(key);

    if (now > record.resetTime) {
      record.count = 0;
      record.resetTime = now + windowMs;
    }

    record.count++;

    const remaining = Math.max(0, maxRequests - record.count);
    const resetTime = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetTime);

    if (record.count > maxRequests) {
      logger.warn("Rate limit exceeded", {
        key,
        count: record.count,
        limit: maxRequests,
      });

      res.setHeader("Retry-After", resetTime);
      return res.status(429).json({
        success: false,
        error: "Rate limit exceeded",
        retryAfter: resetTime,
      });
    }

    next();
  };
}

function cleanupStore() {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now > record.resetTime + 60000) {
      rateLimitStore.delete(key);
    }
  }
}

setInterval(cleanupStore, 60000);

const rateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 100,
});

const strictLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyGenerator: (req) => `${req.ip}:strict`,
});

module.exports = {
  createRateLimiter,
  rateLimiter,
  strictLimiter,
};
