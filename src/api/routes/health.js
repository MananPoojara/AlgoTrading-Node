const express = require("express");
const { query } = require("../../database/postgresClient");
const { logger } = require("../../core/logger/logger");
const { handleApiError } = require("../utils/errorHandler");

const router = express.Router();

router.get("/health", async (req, res) => {
  try {
    const start = Date.now();
    await query("SELECT 1");
    const dbLatency = Date.now() - start;

    res.json({
      success: true,
      data: {
        status: "healthy",
        timestamp: new Date().toISOString(),
        services: {
          database: "connected",
          latency_ms: dbLatency,
        },
      },
    });
  } catch (error) {
    logger.error("Health check failed", { error: error.message });
    res.status(503).json({
      success: false,
      error: "Service unavailable",
      data: {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
      },
    });
  }
});

router.get("/ready", async (req, res) => {
  res.json({
    success: true,
    data: {
      status: "ready",
      timestamp: new Date().toISOString(),
    },
  });
});

module.exports = router;
