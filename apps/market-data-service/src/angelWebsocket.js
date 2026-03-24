const WebSocket = require("ws");
const { logger } = require("../../../packages/core/logger/logger");
const config = require("../../../config/default");

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const SUBSCRIBE_ACTION = 1;
const UNSUBSCRIBE_ACTION = 0;
const MODE_LTP = 1;
const MODE_QUOTE = 2;
const EXCHANGE_TYPE_NSE_CM = 1;
const EXCHANGE_MAP = {
  1: "NSE",
  2: "NFO",
  3: "BSE",
  4: "BFO",
  5: "MCX",
  7: "NCDEX",
  13: "CDS",
};

class AngelWebSocket {
  constructor(options = {}) {
    this.apiKey = options.apiKey || config.angelOne.apiKey;
    this.clientCode = options.clientCode || config.angelOne.clientCode;
    this.jwtToken = options.jwtToken || null;
    this.feedToken = options.feedToken || null;
    this.wsUrl = options.wsUrl || config.angelOne.wsUrl;

    if (!this.apiKey || !this.clientCode || !this.jwtToken || !this.feedToken) {
      throw new Error(
        "Angel One WebSocket requires apiKey, clientCode, jwtToken, and feedToken",
      );
    }

    this.ws = null;
    this.reconnectAttempt = 0;
    this.isConnecting = false;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.heartbeatMonitor = null;
    this.lastMessageAt = null;
    this.shouldReconnect = true;
    this.subscriptions = new Map();

    this.onConnect = options.onConnect || null;
    this.onDisconnect = options.onDisconnect || null;
    this.onError = options.onError || null;
    this.onMessage = options.onMessage || null;
  }

  buildHeaders() {
    return {
      "x-client-code": this.clientCode,
      Authorization: this.jwtToken,
      "x-api-key": this.apiKey,
      "x-feed-token": this.feedToken,
    };
  }

  buildSubscriptionRequest({
    correlationID = "market-data-service",
    action = SUBSCRIBE_ACTION,
    mode = MODE_LTP,
    exchangeType = EXCHANGE_TYPE_NSE_CM,
    tokens,
  }) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      throw new Error("Subscription requires at least one instrument token");
    }

    return {
      correlationID,
      action,
      params: {
        mode,
        tokenList: [
          {
            exchangeType,
            tokens: tokens.map((token) => String(token)),
          },
        ],
      },
    };
  }

  async connect() {
    if (this.isConnecting || this.isConnected) {
      logger.warn("WebSocket already connecting or connected");
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl, {
          headers: this.buildHeaders(),
        });

        this.ws.on("open", () => {
          this.isConnecting = false;
          this.isConnected = true;
          this.lastMessageAt = Date.now();
          this.reconnectAttempt = 0;
          this.startHeartbeat();
          logger.info("Angel One WebSocket connected");

          this.resubscribeAll();

          if (this.onConnect) {
            this.onConnect(this);
          }

          resolve();
        });

        this.ws.on("message", (data) => {
          this.lastMessageAt = Date.now();
          this.handleMessage(data);
        });

        this.ws.on("close", (code, reason) => {
          this.isConnected = false;
          this.isAuthenticated = false;
          this.isConnecting = false;
          this.stopHeartbeat();
          logger.warn("Angel One WebSocket closed", {
            code,
            reason: reason?.toString?.() || String(reason || ""),
          });

          if (this.onDisconnect) {
            this.onDisconnect(code, reason?.toString?.() || "");
          }

          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (error) => {
          this.isConnecting = false;
          logger.error("Angel One WebSocket error", { error: error.message });

          if (this.onError) {
            this.onError(error);
          }

          if (!this.isConnected) {
            reject(error);
          }
        });
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  async authenticate() {
    if (!this.isConnected) {
      throw new Error("WebSocket not connected");
    }

    this.isAuthenticated = true;
    logger.info("Angel One WebSocket authenticated via V2 headers");
    return true;
  }

  subscribe(instrumentTokens, options = {}) {
    if (!this.isConnected || !this.ws) {
      logger.error("Cannot subscribe - WebSocket not connected");
      return false;
    }

    const payload = this.buildSubscriptionRequest({
      tokens: instrumentTokens,
      correlationID: options.correlationID,
      mode: options.mode || MODE_LTP,
      exchangeType: options.exchangeType || EXCHANGE_TYPE_NSE_CM,
      action: SUBSCRIBE_ACTION,
    });

    const subscriptionKey = this.getSubscriptionKey(
      payload.params.tokenList[0].exchangeType,
      payload.params.mode,
    );

    const existingTokens = this.subscriptions.get(subscriptionKey) || new Set();
    for (const token of payload.params.tokenList[0].tokens) {
      existingTokens.add(String(token));
    }
    this.subscriptions.set(subscriptionKey, existingTokens);

    this.ws.send(JSON.stringify(payload));
    logger.info("Subscribed to Angel One instruments", {
      tokenCount: payload.params.tokenList[0].tokens.length,
      mode: payload.params.mode,
      exchangeType: payload.params.tokenList[0].exchangeType,
    });
    return true;
  }

  unsubscribe(instrumentTokens, options = {}) {
    if (!this.isConnected || !this.ws) {
      return false;
    }

    const payload = this.buildSubscriptionRequest({
      tokens: instrumentTokens,
      correlationID: options.correlationID,
      mode: options.mode || MODE_LTP,
      exchangeType: options.exchangeType || EXCHANGE_TYPE_NSE_CM,
      action: UNSUBSCRIBE_ACTION,
    });

    const subscriptionKey = this.getSubscriptionKey(
      payload.params.tokenList[0].exchangeType,
      payload.params.mode,
    );

    const existingTokens = new Set(this.subscriptions.get(subscriptionKey) || []);
    for (const token of payload.params.tokenList[0].tokens) {
      existingTokens.delete(String(token));
    }

    if (existingTokens.size === 0) {
      this.subscriptions.delete(subscriptionKey);
    } else {
      this.subscriptions.set(subscriptionKey, existingTokens);
    }

    this.ws.send(JSON.stringify(payload));
    logger.info("Unsubscribed from Angel One instruments", {
      tokenCount: payload.params.tokenList[0].tokens.length,
      mode: payload.params.mode,
      exchangeType: payload.params.tokenList[0].exchangeType,
    });
    return true;
  }

  handleMessage(data) {
    const message = this.decodeMessage(data);

    if (!message) {
      return;
    }

    if (this.onMessage) {
      this.onMessage(message);
    }
  }

  decodeMessage(data) {
    if (Buffer.isBuffer(data)) {
      return this.decodeBinaryTick(data);
    }

    const text = data?.toString?.() || "";

    if (!text || text === "pong" || text === "ping") {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      logger.debug("Ignoring non-JSON websocket payload");
      return null;
    }
  }

  decodeBinaryTick(buffer) {
    const subscriptionMode = buffer.readUInt8(0);

    if (subscriptionMode === MODE_LTP) {
      return this.decodeLtpPacket(buffer);
    }

    if (subscriptionMode === MODE_QUOTE) {
      return this.decodeQuotePacket(buffer);
    }

    logger.debug("Received unsupported Angel One packet mode", {
      subscriptionMode,
    });
    return null;
  }

  decodeLtpPacket(buffer) {
    return {
      feedType: "tick",
      subscription_mode: buffer.readUInt8(0),
      exchange_type: buffer.readUInt8(1),
      exchange: this.mapExchange(buffer.readUInt8(1)),
      token: this.readToken(buffer, 2),
      sequence_number: Number(buffer.readBigInt64LE(27)),
      exchange_timestamp: Number(buffer.readBigInt64LE(35)),
      timestamp: Number(buffer.readBigInt64LE(35)),
      last_traded_price: this.scalePrice(buffer.readInt32LE(43)),
    };
  }

  decodeQuotePacket(buffer) {
    const exchangeType = buffer.readUInt8(1);

    return {
      feedType: "quote",
      subscription_mode: buffer.readUInt8(0),
      exchange_type: exchangeType,
      exchange: this.mapExchange(exchangeType),
      token: this.readToken(buffer, 2),
      sequence_number: Number(buffer.readBigUInt64LE(27)),
      exchange_timestamp: Number(buffer.readBigUInt64LE(35)),
      timestamp: Number(buffer.readBigUInt64LE(35)),
      last_traded_price: this.scalePriceFromInt64(buffer.readBigUInt64LE(43)),
      last_traded_quantity: Number(buffer.readBigInt64LE(51)),
      avg_traded_price: this.scalePriceFromInt64(buffer.readBigInt64LE(59)),
      volume: Number(buffer.readBigInt64LE(67)),
      ohlc: {
        open: this.scalePriceFromInt64(buffer.readBigInt64LE(91)),
        high: this.scalePriceFromInt64(buffer.readBigInt64LE(99)),
        low: this.scalePriceFromInt64(buffer.readBigInt64LE(107)),
        close: this.scalePriceFromInt64(buffer.readBigInt64LE(115)),
      },
    };
  }

  readToken(buffer, offset) {
    return buffer
      .subarray(offset, offset + 25)
      .toString("utf8")
      .replace(/\0/g, "")
      .trim();
  }

  scalePrice(value) {
    return Number(value) / 100;
  }

  scalePriceFromInt64(value) {
    return Number(value) / 100;
  }

  mapExchange(exchangeType) {
    return EXCHANGE_MAP[exchangeType] || "UNKNOWN";
  }

  getSubscriptionKey(exchangeType, mode) {
    return `${exchangeType}:${mode}`;
  }

  resubscribeAll() {
    for (const [key, tokenSet] of this.subscriptions.entries()) {
      const [exchangeType, mode] = key.split(":").map((value) => Number(value));
      const tokens = Array.from(tokenSet);

      if (tokens.length === 0) {
        continue;
      }

      const payload = this.buildSubscriptionRequest({
        tokens,
        exchangeType,
        mode,
        action: SUBSCRIBE_ACTION,
      });

      this.ws.send(JSON.stringify(payload));
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();

    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws) {
        this.ws.send("ping");
      }
    }, 10000);

    this.heartbeatMonitor = setInterval(() => {
      if (!this.lastMessageAt) {
        return;
      }

      if (Date.now() - this.lastMessageAt > 20000 && this.ws) {
        logger.warn("Angel One feed heartbeat timed out; forcing reconnect");
        this.ws.close();
      }
    }, 5000);
  }

  stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.heartbeatMonitor) {
      clearInterval(this.heartbeatMonitor);
      this.heartbeatMonitor = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay =
      RECONNECT_DELAYS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ];

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempt += 1;

      try {
        await this.connect();
        await this.authenticate();
      } catch (error) {
        logger.error("Angel One WebSocket reconnect failed", {
          error: error.message,
        });
      }
    }, delay);
  }

  async disconnect() {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.isAuthenticated = false;
    logger.info("Angel One WebSocket disconnected");
  }

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      isAuthenticated: this.isAuthenticated,
      reconnectAttempt: this.reconnectAttempt,
    };
  }
}

module.exports = {
  AngelWebSocket,
  constants: {
    SUBSCRIBE_ACTION,
    UNSUBSCRIBE_ACTION,
    MODE_LTP,
    MODE_QUOTE,
    EXCHANGE_TYPE_NSE_CM,
  },
};
