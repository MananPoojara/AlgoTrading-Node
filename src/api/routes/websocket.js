const express = require("express");
const http = require("http");
const { WebSocketServer: WSServer } = require("ws");
const { logger } = require("../../core/logger/logger");
const { getSubscriber } = require("../../core/eventBus/subscriber");

const router = express.Router();

let wss = null;

function initializeWebSocket(server) {
  wss = new WSServer({ server });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    logger.info("WebSocket client connected", { ip: clientIp });

    ws.isAlive = true;
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

function handleMessage(ws, data) {
  const { type, payload } = data;

  switch (type) {
    case "auth":
      handleAuth(ws, payload);
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
}

function handleAuth(ws, payload) {
  const { token } = payload;

  if (!token) {
    ws.send(JSON.stringify({ type: "error", message: "Token required" }));
    return;
  }

  ws.authenticated = true;
  ws.token = token;

  ws.send(
    JSON.stringify({
      type: "authenticated",
      message: "Authentication successful",
    }),
  );

  logger.info("WebSocket client authenticated");
}

function handleSubscribe(ws, payload) {
  const { channels } = payload;

  if (!Array.isArray(channels)) {
    ws.send(
      JSON.stringify({ type: "error", message: "Channels must be an array" }),
    );
    return;
  }

  ws.subscriptions = new Set(channels);

  ws.send(
    JSON.stringify({
      type: "subscribed",
      channels: Array.from(ws.subscriptions),
    }),
  );
}

function handleUnsubscribe(ws, payload) {
  const { channels } = payload;

  if (!Array.isArray(channels)) {
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
  const subscriber = getSubscriber();

  await subscriber.subscribeToMarketTicks((tick) => {
    broadcast("market_tick", tick);
  });

  await subscriber.subscribeToStrategySignals((signal) => {
    broadcast("signal", signal);
  });

  await subscriber.subscribeToBrokerResponses((order) => {
    broadcast("order_update", order);
  });

  await subscriber.subscribeToPositionUpdates((position) => {
    broadcast("position_update", position);
  });

  await subscriber.subscribeToTradeEvents((trade) => {
    broadcast("trade", trade);
  });

  logger.info("WebSocket server subscribed to events");
}

function broadcast(type, data) {
  if (!wss) return;

  const message = JSON.stringify({
    type,
    data,
    timestamp: new Date().toISOString(),
  });

  wss.clients.forEach((client) => {
    if (
      client.readyState === 1 &&
      client.subscriptions?.has(getChannelForType(type))
    ) {
      client.send(message);
    }
  });
}

function getChannelForType(type) {
  const mapping = {
    market_tick: "market_data",
    signal: "signals",
    order_update: "orders",
    position_update: "positions",
    trade: "trades",
  };
  return mapping[type] || "all";
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
