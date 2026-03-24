const express = require("express");
const { query } = require("../../../../packages/database/postgresClient");
const { logger } = require("../../../../packages/core/logger/logger");
const { handleApiError } = require("../utils/errorHandler");
const { getRedisClient } = require("../../../../packages/core/eventBus/redisClient");
const { formatIST } = require("../../../../packages/core/utils/time");
const config = require("../../../../config/default");

const router = express.Router();

router.get("/health", async (req, res) => {
  try {
    const start = Date.now();
    await query("SELECT 1");
    const dbLatency = Date.now() - start;
    const redis = getRedisClient();
    let redisStatus = "disconnected";

    try {
      await redis.connect();
      const redisHealth = await redis.healthCheck();
      redisStatus = redisHealth.status === "online" ? "connected" : "disconnected";
    } catch (error) {
      logger.warn("Redis health check failed", { error: error.message });
    }

    const response = {
      success: true,
      api: "healthy",
      database: "healthy",
      redis: redisStatus,
      broker: config.paperMode ? "paper" : "unknown",
      data: {
        status: "healthy",
        timestamp: formatIST(),
        services: {
          database: "connected",
          redis: redisStatus,
          latency_ms: dbLatency,
        },
      },
    };

    res.json(response);
  } catch (error) {
    logger.error("Health check failed", { error: error.message });
    res.status(503).json({
      success: false,
      api: "unhealthy",
      database: "unhealthy",
      redis: "unknown",
      broker: "unknown",
      error: "Service unavailable",
      data: {
        status: "unhealthy",
        timestamp: formatIST(),
      },
    });
  }
});

router.get("/ready", async (req, res) => {
  res.json({
    success: true,
    data: {
      status: "ready",
      timestamp: formatIST(),
    },
  });
});

module.exports = router;
