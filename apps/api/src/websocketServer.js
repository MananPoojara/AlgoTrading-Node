const WebSocket = require("ws");
const { childLogger, logAtLevel } = require("../../../packages/core/logger/logger");
const { getSubscriber, CHANNELS } = require("../../../packages/core/eventBus/subscriber");
const config = require("../../../config/default");

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
const VALID_CHANNELS = [
  "market_data",
  "orders",
  "positions",
  "signals",
  "trades",
  "alerts",
];
const CLIENT_LOG_LEVEL = config.logging?.websocketClientLevel || "debug";

class WebSocketServer {
  constructor(options = {}) {
    this.port = options.port || config.ws?.port || 8080;
    this.wss = null;
    this.clients = new Map();
    this.subscriptions = new Map();
    this.subscriber = null;
    this.marketTickHandler = (tick) => {
      this.broadcast("market_tick", tick, "market_data");
    };
    this.marketTickSubscriptionActive = false;
    this.logger = childLogger("api-server");
  }

  async initialize() {
    if (this.wss) {
      return this;
    }

    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on(WS_EVENTS.CONNECT, (ws, req) => {
      this.handleConnection(ws, req);
    });

    await this.subscribeToEvents();

    this.logger.info("WebSocket server initialized", { port: this.port });
    return this;
  }

  handleConnection(ws, req) {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    ws.clientId = clientId;
    ws.isAuthenticated = false;
    ws.subscriptions = new Set();
    this.clients.set(clientId, { ws, subscriptions: ws.subscriptions });

    logAtLevel(this.logger, CLIENT_LOG_LEVEL, "WebSocket client connected", {
      clientId,
    });

    ws.on("message", (message) => {
      this.handleMessage(ws, message).catch((error) => {
        this.logger.error("WebSocket message handling failed", {
          clientId: ws.clientId,
          error: error.message,
        });
      });
    });

    ws.on(WS_EVENTS.DISCONNECT, () => {
      this.handleDisconnect(ws).catch((error) => {
        this.logger.error("WebSocket disconnect handling failed", {
          clientId: ws.clientId,
          error: error.message,
        });
      });
    });

    ws.on("error", (error) => {
      this.logger.error("WebSocket error", { clientId, error: error.message });
    });

    ws.send(
      JSON.stringify({
        type: "connected",
        clientId,
        message: "Connected to trading server",
      }),
    );
  }

  async handleMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case WS_EVENTS.AUTH:
          this.handleAuth(ws, data);
          break;
        case WS_EVENTS.SUBSCRIBE:
          await this.handleSubscribe(ws, data);
          break;
        case WS_EVENTS.UNSUBSCRIBE:
          await this.handleUnsubscribe(ws, data);
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
      this.logger.error("WebSocket message error", { error: error.message });
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

    logAtLevel(this.logger, CLIENT_LOG_LEVEL, "WebSocket client authenticated", {
      clientId: ws.clientId,
    });
  }

  async handleSubscribe(ws, data) {
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
      if (VALID_CHANNELS.includes(channel)) {
        ws.subscriptions.add(channel);
      }
    }

    await this.syncMarketDataSubscription();

    ws.send(
      JSON.stringify({
        type: "subscribed",
        channels: Array.from(ws.subscriptions),
      }),
    );

    logAtLevel(this.logger, CLIENT_LOG_LEVEL, "WebSocket client subscribed", {
      clientId: ws.clientId,
      channels: Array.from(ws.subscriptions),
    });
  }

  async handleUnsubscribe(ws, data) {
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

    await this.syncMarketDataSubscription();
  }

  async handleDisconnect(ws) {
    this.clients.delete(ws.clientId);
    await this.syncMarketDataSubscription();
    logAtLevel(this.logger, CLIENT_LOG_LEVEL, "WebSocket client disconnected", {
      clientId: ws.clientId,
    });
  }

  async subscribeToEvents() {
    this.subscriber = this.subscriber || getSubscriber();

    try {
      if (typeof this.subscriber.subscribeToStrategySignalsStream !== "function") {
        throw new Error("strategy signal stream subscription unavailable");
      }

      await this.subscriber.subscribeToStrategySignalsStream((signal) => {
        this.broadcast("signal", signal, "signals");
      }, { groupName: "api-websocket-signals" });
    } catch (error) {
      this.logger.warn("Strategy signals stream subscription failed — falling back to Pub/Sub", {
        error: error.message,
      });
      await this.subscriber.subscribeToStrategySignals((signal) => {
        this.broadcast("signal", signal, "signals");
      });
    }

    try {
      if (typeof this.subscriber.subscribeToOrderUpdatesStream !== "function") {
        throw new Error("order update stream subscription unavailable");
      }

      await this.subscriber.subscribeToOrderUpdatesStream((order) => {
        this.broadcast("order_update", order, "orders");
      }, { groupName: "api-websocket-orders" });
    } catch (error) {
      this.logger.warn("Order updates stream subscription failed — falling back to Pub/Sub", {
        error: error.message,
      });
      await this.subscriber.subscribe("order_updates", (order) => {
        this.broadcast("order_update", order, "orders");
      });
    }

    await this.subscriber.subscribe("position_updates", (position) => {
      this.broadcast("position_update", position, "positions");
    });

    await this.subscriber.subscribeToTradeEvents((tradeEvent) => {
      this.broadcast("trade_event", tradeEvent, "trades");
    });

    await this.subscriber.subscribeToSystemAlerts((alert) => {
      this.broadcast("system_alert", alert, "alerts");
    });

    this.logger.info("WebSocket subscribed to event channels");
  }

  hasMarketDataSubscribers() {
    for (const { subscriptions } of this.clients.values()) {
      if (subscriptions?.has("market_data")) {
        return true;
      }
    }

    return false;
  }

  async syncMarketDataSubscription() {
    this.subscriber = this.subscriber || getSubscriber();

    if (
      this.hasMarketDataSubscribers() &&
      !this.marketTickSubscriptionActive
    ) {
      await this.subscriber.subscribeToMarketTicks(this.marketTickHandler);
      this.marketTickSubscriptionActive = true;
      this.logger.info("WebSocket market-data forwarding enabled");
      return;
    }

    if (
      !this.hasMarketDataSubscribers() &&
      this.marketTickSubscriptionActive
    ) {
      if (typeof this.subscriber.unsubscribeHandler === "function") {
        await this.subscriber.unsubscribeHandler(
          CHANNELS.MARKET_TICKS,
          this.marketTickHandler,
        );
      }
      this.marketTickSubscriptionActive = false;
      this.logger.info("WebSocket market-data forwarding disabled");
    }
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
    this.logger.info("WebSocket server closed");
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
