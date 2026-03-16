const express = require("express");
const http = require("http");
const { WebSocketServer: WSServer } = require("ws");
const { logger } = require("../../core/logger/logger");
const { getSubscriber } = require("../../core/eventBus/subscriber");
const { query } = require("../../database/postgresClient");

const router = express.Router();

let wss = null;

function initializeWebSocket(server) {
  wss = new WSServer({ server });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    logger.info("WebSocket client connected", { ip: clientIp });

    ws.isAlive = true;
    ws.authenticated = false;
    ws.subscriptions = new Set();

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        handleMessage(ws, data);
      } catch (error) {
        logger.error("WebSocket message error", { error: error.message });
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      }
    });

    ws.on("close", () => {
      logger.info("WebSocket client disconnected", { ip: clientIp });
    });

    ws.send(
      JSON.stringify({
        type: "connected",
        message: "Connected to trading server",
        timestamp: new Date().toISOString(),
      }),
    );
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(interval);
  });

  subscribeToEvents();

  logger.info("WebSocket server initialized");
  return wss;
}

async function handleMessage(ws, data) {
  const { type, payload } = data;

  try {
    switch (type) {
      case "auth":
        await handleAuth(ws, payload);
        break;
      case "subscribe":
        handleSubscribe(ws, payload);
        break;
      case "unsubscribe":
        handleUnsubscribe(ws, payload);
        break;
      default:
        ws.send(
          JSON.stringify({ type: "error", message: "Unknown message type" }),
        );
    }
  } catch (error) {
    logger.error("WebSocket handler error", { error: error.message, type });
    ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
  }
}

async function handleAuth(ws, payload) {
  const { token } = payload;

  if (!token) {
    ws.send(JSON.stringify({ type: "error", message: "Token required" }));
    return;
  }

  try {
    const result = await query(
      "SELECT id, client_id, expires_at FROM api_tokens WHERE token = $1 AND status = $2",
      [token, "active"],
    );

    if (result.rows.length === 0) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
      return;
    }

    const tokenRecord = result.rows[0];

    if (new Date(tokenRecord.expires_at) < new Date()) {
      ws.send(JSON.stringify({ type: "error", message: "Token expired" }));
      return;
    }

    ws.authenticated = true;
    ws.clientId = tokenRecord.client_id;

    ws.send(
      JSON.stringify({
        type: "authenticated",
        message: "Authentication successful",
        clientId: tokenRecord.client_id,
      }),
    );

    logger.info("WebSocket client authenticated", {
      clientId: tokenRecord.client_id,
    });
  } catch (error) {
    logger.error("WebSocket auth error", { error: error.message });
    ws.send(
      JSON.stringify({ type: "error", message: "Authentication failed" }),
    );
  }
}

function handleSubscribe(ws, payload) {
  if (!ws.authenticated) {
    ws.send(
      JSON.stringify({ type: "error", message: "Authentication required" }),
    );
    return;
  }

  const { channels } = payload;

  if (!Array.isArray(channels)) {
    ws.send(
      JSON.stringify({ type: "error", message: "Channels must be an array" }),
    );
    return;
  }

  const validChannels = [
    "market_data",
    "orders",
    "positions",
    "signals",
    "trades",
  ];
  const valid = [];
  const invalid = [];

  for (const channel of channels) {
    if (validChannels.includes(channel)) {
      ws.subscriptions.add(channel);
      valid.push(channel);
    } else {
      invalid.push(channel);
    }
  }

  ws.send(
    JSON.stringify({
      type: "subscribed",
      channels: valid,
      invalid: invalid.length > 0 ? invalid : undefined,
    }),
  );
}

function handleUnsubscribe(ws, payload) {
  if (!ws.authenticated) {
    ws.send(
      JSON.stringify({ type: "error", message: "Authentication required" }),
    );
    return;
  }

  const { channels } = payload;

  if (!Array.isArray(channels)) {
    ws.send(
      JSON.stringify({ type: "error", message: "Channels must be an array" }),
    );
    return;
  }

  for (const channel of channels) {
    ws.subscriptions.delete(channel);
  }

  ws.send(
    JSON.stringify({
      type: "unsubscribed",
      channels: Array.from(ws.subscriptions),
    }),
  );
}

async function subscribeToEvents() {
  try {
    const subscriber = getSubscriber();

    await subscriber.subscribeToMarketTicks((tick) => {
      broadcast("market_tick", tick, "market_data");
    });

    await subscriber.subscribeToStrategySignals((signal) => {
      broadcast("signal", signal, "signals");
    });

    await subscriber.subscribeToBrokerResponses((order) => {
      broadcast("order_update", order, "orders");
    });

    await subscriber.subscribeToPositionUpdates((position) => {
      broadcast("position_update", position, "positions");
    });

    await subscriber.subscribeToTradeEvents((trade) => {
      broadcast("trade", trade, "trades");
    });

    logger.info("WebSocket server subscribed to events");
  } catch (error) {
    logger.error("WebSocket event subscription error", {
      error: error.message,
    });
  }
}

function broadcast(type, data, channel) {
  if (!wss) return;

  const message = JSON.stringify({
    type,
    data,
    timestamp: new Date().toISOString(),
  });

  wss.clients.forEach((client) => {
    if (
      client.readyState === 1 &&
      client.authenticated &&
      client.subscriptions.has(channel)
    ) {
      try {
        client.send(message);
      } catch (error) {
        logger.error("WebSocket broadcast error", { error: error.message });
      }
    }
  });
}

router.get("/status", (req, res) => {
  const clients = wss ? wss.clients.size : 0;
  res.json({
    success: true,
    data: {
      status: "running",
      clients,
      timestamp: new Date().toISOString(),
    },
  });
});

module.exports = {
  router,
  initializeWebSocket,
};
