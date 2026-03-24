const { logger } = require('../../../packages/core/logger/logger');
const { formatIST } = require('../../../packages/core/utils/time');

class InstrumentManager {
  constructor() {
    this.instruments = new Map();
    this.tokenToSymbol = new Map();
    this.symbolToToken = new Map();
    this.instrumentTokens = new Set();
  }

  registerInstrument(token, symbol, details = {}) {
    const tokenStr = token.toString();
    
    this.instruments.set(tokenStr, {
      token: tokenStr,
      symbol,
      ...details,
      registeredAt: formatIST()
    });

    this.tokenToSymbol.set(tokenStr, symbol);
    this.symbolToToken.set(symbol, tokenStr);

    logger.debug('Instrument registered', { token: tokenStr, symbol });
  }

  registerInstruments(instrumentList) {
    for (const inst of instrumentList) {
      this.registerInstrument(inst.token, inst.symbol, inst);
    }
    logger.info(`Registered ${instrumentList.length} instruments`);
  }

  getToken(symbol) {
    return this.symbolToToken.get(symbol);
  }

  getSymbol(token) {
    return this.tokenToSymbol.get(token.toString());
  }

  getInstrument(tokenOrSymbol) {
    const key = tokenOrSymbol.toString();
    
    if (this.instruments.has(key)) {
      return this.instruments.get(key);
    }

    const symbol = this.getSymbol(key);
    if (symbol) {
      return this.instruments.get(this.symbolToToken.get(symbol));
    }

    return null;
  }

  subscribe(instrumentToken) {
    const tokenStr = instrumentToken.toString();
    this.instrumentTokens.add(tokenStr);
    logger.debug('Subscribed to instrument', { token: tokenStr });
  }

  unsubscribe(instrumentToken) {
    const tokenStr = instrumentToken.toString();
    this.instrumentTokens.delete(tokenStr);
    logger.debug('Unsubscribed from instrument', { token: tokenStr });
  }

  getSubscribedTokens() {
    return Array.from(this.instrumentTokens);
  }

  isSubscribed(instrumentToken) {
    return this.instrumentTokens.has(instrumentToken.toString());
  }

  getAllInstruments() {
    return Array.from(this.instruments.values());
  }

  getInstrumentCount() {
    return this.instruments.size;
  }

  getSubscriptionCount() {
    return this.instrumentTokens.size;
  }

  clearSubscriptions() {
    this.instrumentTokens.clear();
    logger.info('Cleared all instrument subscriptions');
  }

  removeInstrument(tokenOrSymbol) {
    const key = tokenOrSymbol.toString();
    const instrument = this.instruments.get(key);
    
    if (instrument) {
      this.instruments.delete(key);
      this.tokenToSymbol.delete(instrument.token);
      this.symbolToToken.delete(instrument.symbol);
      this.instrumentTokens.delete(instrument.token);
      logger.info('Removed instrument', { token: instrument.token, symbol: instrument.symbol });
    }
  }

  getInstrumentsBySymbolPattern(pattern) {
    const regex = new RegExp(pattern, 'i');
    return Array.from(this.instruments.values()).filter(
      inst => regex.test(inst.symbol)
    );
  }

  getInstrumentsByExchange(exchange) {
    return Array.from(this.instruments.values()).filter(
      inst => inst.exchange === exchange
    );
  }
}

module.exports = { InstrumentManager };
