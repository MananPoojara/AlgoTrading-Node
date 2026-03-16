const WebSocket = require("ws");
const { logger } = require("../core/logger/logger");
const { getSubscriber, CHANNELS } = require("../core/eventBus/subscriber");
const config = require("../../config/default");

const WS_EVENTS = {
  CONNECT: "connection",
  DISCONNECT: "disconnect",
  AUTH: "auth",
  SUBSCRIBE: "subscribe",
  UNSUBSCRIBE: "unsubscribe",
  MARKET_DATA: "market_data",
  ORDER_UPDATE: "order_update",
  POSITION_UPDATE: "position_update",
  SIGNAL: "signal",
  ERROR: "error",
};

class WebSocketServer {
  constructor(options = {}) {
    this.port = options.port || config.ws?.port || 8080;
    this.wss = null;
    this.clients = new Map();
    this.subscriptions = new Map();
  }

  async initialize() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on(WS_EVENTS.CONNECT, (ws, req) => {
      this.handleConnection(ws, req);
    });

    await this.subscribeToEvents();

    logger.info("WebSocket server initialized", { port: this.port });
    return this;
  }

  handleConnection(ws, req) {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    ws.clientId = clientId;
    ws.isAuthenticated = false;
    ws.subscriptions = new Set();
    this.clients.set(clientId, { ws, subscriptions: ws.subscriptions });

    logger.info("WebSocket client connected", { clientId });

    ws.on("message", (message) => {
      this.handleMessage(ws, message);
    });

    ws.on(WS_EVENTS.DISCONNECT, () => {
      this.handleDisconnect(ws);
    });

    ws.on("error", (error) => {
      logger.error("WebSocket error", { clientId, error: error.message });
    });

    ws.send(
      JSON.stringify({
        type: "connected",
        clientId,
        message: "Connected to trading server",
      }),
    );
  }

  handleMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case WS_EVENTS.AUTH:
          this.handleAuth(ws, data);
          break;
        case WS_EVENTS.SUBSCRIBE:
          this.handleSubscribe(ws, data);
          break;
        case WS_EVENTS.UNSUBSCRIBE:
          this.handleUnsubscribe(ws, data);
          break;
        default:
          ws.send(
            JSON.stringify({
              type: WS_EVENTS.ERROR,
              message: "Unknown message type",
            }),
          );
      }
    } catch (error) {
      logger.error("WebSocket message error", { error: error.message });
      ws.send(
        JSON.stringify({
          type: WS_EVENTS.ERROR,
          message: "Invalid message format",
        }),
      );
    }
  }

  handleAuth(ws, data) {
    const token = data?.payload?.token || data?.token;

    if (!token) {
      ws.send(
        JSON.stringify({
          type: WS_EVENTS.ERROR,
          message: "Authentication token required",
        }),
      );
      return;
    }

    ws.isAuthenticated = true;
    ws.authToken = token;

    ws.send(
      JSON.stringify({
        type: "auth_success",
        message: "Authentication successful",
      }),
    );

    logger.info("WebSocket client authenticated", { clientId: ws.clientId });
  }

  handleSubscribe(ws, data) {
    const channels = data?.payload?.channels || data?.channels;

    if (!Array.isArray(channels)) {
      ws.send(
        JSON.stringify({
          type: WS_EVENTS.ERROR,
          message: "channels must be an array",
        }),
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

    for (const channel of channels) {
      if (validChannels.includes(channel)) {
        ws.subscriptions.add(channel);
      }
    }

    ws.send(
      JSON.stringify({
        type: "subscribed",
        channels: Array.from(ws.subscriptions),
      }),
    );

    logger.info("WebSocket client subscribed", {
      clientId: ws.clientId,
      channels: Array.from(ws.subscriptions),
    });
  }

  handleUnsubscribe(ws, data) {
    const channels = data?.payload?.channels || data?.channels;

    if (!Array.isArray(channels)) {
      ws.send(
        JSON.stringify({
          type: WS_EVENTS.ERROR,
          message: "channels must be an array",
        }),
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

  handleDisconnect(ws) {
    this.clients.delete(ws.clientId);
    logger.info("WebSocket client disconnected", { clientId: ws.clientId });
  }

  async subscribeToEvents() {
    const subscriber = getSubscriber();

    await subscriber.subscribeToMarketTicks((tick) => {
      this.broadcast("market_tick", tick, "market_data");
    });

    await subscriber.subscribeToStrategySignals((signal) => {
      this.broadcast("signal", signal, "signals");
    });

    await subscriber.subscribe("order_updates", (order) => {
      this.broadcast("order_update", order, "orders");
    });

    await subscriber.subscribe("position_updates", (position) => {
      this.broadcast("position_update", position, "positions");
    });

    logger.info("WebSocket subscribed to event channels");
  }

  broadcastToSubscribers(channel, data) {
    for (const [clientId, client] of this.clients) {
      if (
        client.ws.subscriptions.has(channel) &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        client.ws.send(
          JSON.stringify({
            type: channel,
            data,
          }),
        );
      }
    }
  }

  broadcast(type, data, channel) {
    for (const [clientId, client] of this.clients) {
      if (
        client.ws.subscriptions.has(channel) &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        client.ws.send(
          JSON.stringify({
            type,
            data,
          }),
        );
      }
    }
  }

  sendToClient(clientId, type, data) {
    const client = this.clients.get(clientId);

    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type, data }));
    }
  }

  broadcastAll(type, data) {
    const message = JSON.stringify({ type, data });

    for (const [clientId, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  close() {
    for (const [clientId, client] of this.clients) {
      client.ws.close();
    }
    this.wss.close();
    logger.info("WebSocket server closed");
  }
}

let wsServerInstance = null;

function getWebSocketServer(options = {}) {
  if (!wsServerInstance) {
    wsServerInstance = new WebSocketServer(options);
  }
  return wsServerInstance;
}

module.exports = {
  WebSocketServer,
  getWebSocketServer,
  WS_EVENTS,
};
