require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { logger } = require("./core/logger/logger");
const { sanitizeError, handleApiError } = require("./api/utils/errorHandler");
const { requireAuth, isPublicPath } = require("./api/middleware/auth");
const { rateLimiter, strictLimiter } = require("./api/middleware/rateLimiter");
const healthRoutes = require("./api/routes/health");
const marketDataRoutes = require("./api/routes/marketData");
const orderRoutes = require("./api/routes/orders");
const strategyRoutes = require("./api/routes/strategies");
const authRoutes = require("./api/routes/auth");
const portfolioRoutes = require("./api/routes/portfolio");
const config = require("../config/default");

const app = express();
const PORT = config.api?.port || 3000;

const corsOptions = {
  origin:
    config.api?.allowedOrigins?.split(",") ||
    process.env.ALLOWED_ORIGINS?.split(",") ||
    false,
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(rateLimiter);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info("API Request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
    });
  });
  next();
});

app.use((req, res, next) => {
  if (isPublicPath(req.path)) {
    return next();
  }
  return requireAuth(req, res, next);
});

app.use("/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/market", marketDataRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/strategies", strategyRoutes);
app.use("/api/portfolio", portfolioRoutes);

app.get("/api/clients", async (req, res) => {
  try {
    const { query } = require("./database/postgresClient");
    const result = await query(
      "SELECT id, name, email, status, created_at FROM clients ORDER BY name",
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error("Failed to fetch clients", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/clients/:id", async (req, res) => {
  try {
    const { query } = require("./database/postgresClient");
    const { id } = req.params;

    const clientResult = await query(
      "SELECT id, name, email, status, created_at FROM clients WHERE id = $1",
      [id],
    );

    if (clientResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Client not found" });
    }

    const positionsResult = await query(
      "SELECT instrument, position, average_price FROM positions WHERE client_id = $1",
      [id],
    );

    res.json({
      success: true,
      data: {
        ...clientResult.rows[0],
        positions: positionsResult.rows,
      },
    });
  } catch (error) {
    logger.error("Failed to fetch client", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/positions", async (req, res) => {
  try {
    const { client_id } = req.query;
    const { query } = require("./database/postgresClient");

    let sql = "SELECT * FROM positions";
    const params = [];

    if (client_id) {
      sql += " WHERE client_id = $1";
      params.push(client_id);
    }

    sql += " ORDER BY updated_at DESC";

    const result = await query(sql, params);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    logger.error("Failed to fetch positions", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/portfolio/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    const { query } = require("./database/postgresClient");

    const positionsResult = await query(
      `SELECT 
        p.instrument,
        p.position,
        p.average_price,
        COALESCE(mt.ltp, p.average_price) as current_price,
        CASE WHEN p.position > 0 
          THEN (COALESCE(mt.ltp, p.average_price) - p.average_price) * p.position
          ELSE 0
        END as unrealized_pnl
       FROM positions p
       LEFT JOIN (
         SELECT instrument_token, ltp 
         FROM market_ticks 
         WHERE instrument_token IN (SELECT DISTINCT instrument FROM positions WHERE client_id = $1)
         ORDER BY timestamp DESC
       ) mt ON p.instrument = mt.instrument_token
       WHERE p.client_id = $1 AND p.position != 0`,
      [clientId],
    );

    const totalValue = positionsResult.rows.reduce(
      (sum, p) => sum + p.position * p.current_price,
      0,
    );
    const totalPnL = positionsResult.rows.reduce(
      (sum, p) => sum + (p.unrealized_pnl || 0),
      0,
    );

    res.json({
      success: true,
      data: {
        positions: positionsResult.rows,
        summary: {
          total_value: totalValue,
          unrealized_pnl: totalPnL,
          position_count: positionsResult.rows.length,
        },
      },
    });
  } catch (error) {
    logger.error("Failed to fetch portfolio", { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found" });
});

app.use((err, req, res, next) => {
  logger.error("API Error", { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: "Internal server error" });
});

function startServer() {
  app.listen(PORT, () => {
    logger.info(`API Server started on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
