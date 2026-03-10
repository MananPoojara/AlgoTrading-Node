const WebSocket = require('ws');
const { logger } = require('../../core/logger/logger');
const config = require('../../../config/default');

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

class AngelWebSocket {
  constructor(options = {}) {
    this.apiKey = options.apiKey || config.angelOne.apiKey;
    this.wsUrl = options.wsUrl || config.angelOne.wsUrl;
    
    if (!this.apiKey) {
      throw new Error('Angel One API key is required');
    }
    
    this.ws = null;
    this.reconnectAttempt = 0;
    this.isConnecting = false;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.subscribers = new Set();
    this.messageHandlers = new Map();
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.subscribedTokens = [];
    this.authResolve = null;
    this.authReject = null;
    
    this.onConnect = options.onConnect || null;
    this.onDisconnect = options.onDisconnect || null;
    this.onError = options.onError || null;
    this.onMessage = options.onMessage || null;
  }

  async connect() {
    if (this.isConnecting || this.isConnected) {
      logger.warn('WebSocket already connecting or connected');
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          logger.info('Angel One WebSocket connected');
          this.isConnecting = false;
          this.isConnected = true;
          this.reconnectAttempt = 0;
          
          this.startPingInterval();
          
          if (this.onConnect) this.onConnect();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          logger.warn(`Angel One WebSocket closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.stopPingInterval();
          
          if (this.onDisconnect) this.onDisconnect(code, reason);
          
          this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
          logger.error('Angel One WebSocket error', { error: error.message });
          this.isConnecting = false;
          
          if (this.onError) this.onError(error);
          
          if (!this.isConnected) {
            reject(error);
          }
        });

      } catch (error) {
        this.isConnecting = false;
        logger.error('Failed to create WebSocket', { error: error.message });
        reject(error);
      }
    });
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      if (message.type === 'success' || message.type === 'error') {
        logger.debug('Angel One auth response', { type: message.type });
        return;
      }

      if (message.type === 'order' || message.type === 'trade') {
        this.notifySubscribers(message);
        return;
      }

      if (this.onMessage) {
        this.onMessage(message);
      }

      const handler = this.messageHandlers.get(message.feedType || 'default');
      if (handler) {
        handler(message);
      }

    } catch (error) {
      logger.error('Failed to parse Angel One message', { error: error.message });
    }
  }

  async authenticate() {
    if (!this.isConnected) {
      throw new Error('WebSocket not connected');
    }

    const authMessage = {
      apiKey: this.apiKey
    };

    this.ws.send(JSON.stringify(authMessage));
    logger.info('Sent authentication request to Angel One');
  }

  subscribe(instrumentTokens) {
    if (!this.isConnected) {
      logger.error('Cannot subscribe - WebSocket not connected');
      return false;
    }

    const subscriptionMessage = {
      action: 'subscribe',
      instruments: instrumentTokens.map(token => ({
        exchange: 'NSE',
        token: token.toString()
      }))
    };

    this.ws.send(JSON.stringify(subscriptionMessage));
    
    for (const token of instrumentTokens) {
      if (!this.subscribedTokens.includes(token.toString())) {
        this.subscribedTokens.push(token.toString());
      }
    }
    
    logger.info(`Subscribed to ${instrumentTokens.length} instruments`);
    return true;
  }

  unsubscribe(instrumentTokens) {
    if (!this.isConnected) {
      return false;
    }

    const unsubscribeMessage = {
      action: 'unsubscribe',
      instruments: instrumentTokens.map(token => ({
        exchange: 'NSE',
        token: token.toString()
      }))
    };

    this.ws.send(JSON.stringify(unsubscribeMessage));
    
    for (const token of instrumentTokens) {
      const tokenStr = token.toString();
      const index = this.subscribedTokens.indexOf(tokenStr);
      if (index > -1) {
        this.subscribedTokens.splice(index, 1);
      }
    }
    
    logger.info(`Unsubscribed from ${instrumentTokens.length} instruments`);
    return true;
  }

  onMessageType(feedType, handler) {
    this.messageHandlers.set(feedType, handler);
  }

  subscribeToAll(handler) {
    this.subscribers.add(handler);
  }

  unsubscribeFromAll(handler) {
    this.subscribers.delete(handler);
  }

  notifySubscribers(message) {
    for (const handler of this.subscribers) {
      try {
        handler(message);
      } catch (error) {
        logger.error('Error in subscriber handler', { error: error.message });
      }
    }
  }

  startPingInterval() {
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws) {
        this.ws.ping();
      }
    }, 30000);
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    
    logger.info(`Scheduling reconnect attempt ${this.reconnectAttempt + 1} in ${delay}ms`);
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectAttempt++;
      this.isAuthenticated = false;
      try {
        await this.connect();
        await this.authenticate();
        
        if (this.subscribedTokens.length > 0) {
          logger.info(`Resubscribing to ${this.subscribedTokens.length} instruments`);
          this.subscribe(this.subscribedTokens);
        }
      } catch (error) {
        logger.error('Reconnect failed', { error: error.message });
      }
    }, delay);
  }

  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopPingInterval();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    logger.info('Angel One WebSocket disconnected');
  }

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      reconnectAttempt: this.reconnectAttempt
    };
  }
}

module.exports = { AngelWebSocket };
