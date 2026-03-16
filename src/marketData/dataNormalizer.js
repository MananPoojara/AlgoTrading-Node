const { toUTC, formatIST } = require('../core/utils/time');
const { logger } = require('../core/logger/logger');

class DataNormalizer {
  constructor(options = {}) {
    this.tickBuffer = new Map();
    this.maxBufferSize = options.maxBufferSize || 1000;
  }

  normalizeTick(angelData) {
    try {
      if (!angelData || !angelData.token) {
        return null;
      }

      const tick = {
        symbol: this.extractSymbol(angelData),
        instrument_token: angelData.token,
        ltp: this.parsePrice(angelData.last_traded_price),
        open: this.parsePrice(angelData.ohlc?.open),
        high: this.parsePrice(angelData.ohlc?.high),
        low: this.parsePrice(angelData.ohlc?.low),
        close: this.parsePrice(angelData.ohlc?.close),
        volume: parseInt(angelData.volume, 10) || 0,
        bid: this.parsePrice(angelData.depth?.buy?.[0]?.price),
        ask: this.parsePrice(angelData.depth?.sell?.[0]?.price),
        bid_quantity: parseInt(angelData.depth?.buy?.[0]?.quantity, 10) || 0,
        ask_quantity: parseInt(angelData.depth?.sell?.[0]?.quantity, 10) || 0,
        timestamp: this.parseTimestamp(angelData.timestamp),
        exchange: angelData.exchange || 'NSE'
      };

      this.bufferTick(tick);

      return tick;

    } catch (error) {
      logger.error('Error normalizing tick data', { 
        error: error.message,
        data: angelData 
      });
      return null;
    }
  }

  extractSymbol(angelData) {
    if (angelData.symbol) {
      return angelData.symbol;
    }
    
    if (angelData.trading_symbol) {
      return angelData.trading_symbol;
    }

    return angelData.token?.toString() || 'UNKNOWN';
  }

  parsePrice(price) {
    if (price === undefined || price === null || price === '') {
      return 0;
    }
    const parsed = parseFloat(price);
    return isNaN(parsed) ? 0 : parsed;
  }

  parseTimestamp(timestamp) {
    if (!timestamp) {
      return new Date().toISOString();
    }

    try {
      if (typeof timestamp === 'number') {
        return new Date(timestamp).toISOString();
      }

      if (timestamp instanceof Date) {
        return timestamp.toISOString();
      }

      const parsed = Date.parse(timestamp);
      if (!isNaN(parsed)) {
        return new Date(parsed).toISOString();
      }

      return new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  normalizeOHLC(angelData) {
    const tick = this.normalizeTick(angelData);
    if (!tick) return null;

    return {
      symbol: tick.symbol,
      instrument_token: tick.instrument_token,
      open: tick.open,
      high: tick.high,
      low: tick.low,
      close: tick.close,
      volume: tick.volume,
      timestamp: tick.timestamp
    };
  }

  normalizeDepth(angelData) {
    if (!angelData.depth) {
      return null;
    }

    const buyLevels = [];
    const sellLevels = [];

    if (angelData.depth.buy) {
      for (let i = 0; i < Math.min(angelData.depth.buy.length, 5); i++) {
        buyLevels.push({
          price: this.parsePrice(angelData.depth.buy[i]?.price),
          quantity: parseInt(angelData.depth.buy[i]?.quantity, 10) || 0,
          orders: parseInt(angelData.depth.buy[i]?.orders, 10) || 0
        });
      }
    }

    if (angelData.depth.sell) {
      for (let i = 0; i < Math.min(angelData.depth.sell.length, 5); i++) {
        sellLevels.push({
          price: this.parsePrice(angelData.depth.sell[i]?.price),
          quantity: parseInt(angelData.depth.sell[i]?.quantity, 10) || 0,
          orders: parseInt(angelData.depth.sell[i]?.orders, 10) || 0
        });
      }
    }

    return {
      symbol: this.extractSymbol(angelData),
      instrument_token: angelData.token,
      buy: buyLevels,
      sell: sellLevels,
      timestamp: this.parseTimestamp(angelData.timestamp)
    };
  }

  normalizeQuote(angelData) {
    return {
      tick: this.normalizeTick(angelData),
      ohlc: this.normalizeOHLC(angelData),
      depth: this.normalizeDepth(angelData)
    };
  }

  bufferTick(tick) {
    if (!tick || !tick.symbol) return;

    const key = tick.instrument_token?.toString() || tick.symbol;
    
    const buffer = this.tickBuffer.get(key) || [];
    buffer.push(tick);

    if (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }

    this.tickBuffer.set(key, buffer);
  }

  getRecentTicks(symbolOrToken, count = 100) {
    const key = symbolOrToken?.toString();
    const buffer = this.tickBuffer.get(key) || [];
    return buffer.slice(-count);
  }

  getLastTick(symbolOrToken) {
    const ticks = this.getRecentTicks(symbolOrToken, 1);
    return ticks.length > 0 ? ticks[0] : null;
  }

  clearBuffer(symbolOrToken = null) {
    if (symbolOrToken) {
      const key = symbolOrToken.toString();
      this.tickBuffer.delete(key);
    } else {
      this.tickBuffer.clear();
    }
  }

  getBufferStats() {
    let totalTicks = 0;
    const symbols = [];

    for (const [key, ticks] of this.tickBuffer) {
      totalTicks += ticks.length;
      symbols.push({ symbol: key, count: ticks.length });
    }

    return {
      totalTicks,
      symbolCount: this.tickBuffer.size,
      symbols
    };
  }
}

module.exports = { DataNormalizer };
