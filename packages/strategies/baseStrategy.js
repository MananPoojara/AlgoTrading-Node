const { logger } = require('../core/logger/logger');
const { generateSignalEventId } = require('../core/utils/idGenerator');
const { formatIST } = require('../core/utils/time');

const STRATEGY_STATES = {
  CREATED: 'created',
  INITIALIZING: 'initializing',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  FAILED: 'failed',
  RESTARTING: 'restarting'
};

class BaseStrategy {
  constructor(config = {}) {
    this.name = config.name || this.constructor.name;
    this.instanceId = config.instanceId || null;
    this.clientId = config.clientId || null;
    this.strategyId = config.strategyId || null;
    this.parameters = config.parameters || {};
    this.evaluationMode =
      config.evaluationMode || this.parameters.evaluationMode || 'tick';
    this.state = STRATEGY_STATES.CREATED;
    
    this.candles = [];
    this.lastClosedCandle = null;
    this.lastTick = null;
    this.position = null;
    this.lastSignalTime = null;
    this.signalCooldown = config.signalCooldown ?? 5000;
    
    this.onSignal = config.onSignal || null;
  }

  async initialize() {
    this.setState(STRATEGY_STATES.INITIALIZING);
    await this.onInit();
    this.setState(STRATEGY_STATES.RUNNING);
  }

  async onInit() {
  }

  async onTick(tick) {
    throw new Error('onTick() must be implemented by subclass');
  }

  async onMarketTick(tick) {
  }

  async onCandle(candle) {
  }

  async processTick(tick) {
    if (this.state !== STRATEGY_STATES.RUNNING) {
      return null;
    }

    this.lastTick = tick;
    await this.onMarketTick(tick);
    const candleUpdate = this.updateCandles(tick);

    if (!this.shouldEvaluate(candleUpdate)) {
      return null;
    }

    return this.onTick(tick, candleUpdate);
  }

  updateCandles(tick) {
    if (!tick) return;

    const candlePeriod = this.getEvaluationCandlePeriod();
    const now = new Date(tick.timestamp);
    const candleTime = this.getCandleTime(now, candlePeriod);

    let currentCandle = this.candles[this.candles.length - 1];
    let candleClosed = false;

    if (!currentCandle || currentCandle.time !== candleTime) {
      if (currentCandle) {
        this.lastClosedCandle = { ...currentCandle };
        candleClosed = true;
      }

      currentCandle = {
        time: candleTime,
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        volume: tick.volume || 0
      };
      this.candles.push(currentCandle);
      
      if (this.candles.length > 100) {
        this.candles.shift();
      }
      
      this.onCandle(currentCandle);
    } else {
      currentCandle.high = Math.max(currentCandle.high, tick.ltp);
      currentCandle.low = Math.min(currentCandle.low, tick.ltp);
      currentCandle.close = tick.ltp;
      currentCandle.volume += tick.volume || 0;
    }

    return {
      candleClosed,
      currentCandle,
      lastClosedCandle: this.lastClosedCandle,
    };
  }

  getEvaluationCandlePeriod() {
    switch (this.evaluationMode) {
      case '1m_close':
        return '1min';
      case '5m_close':
        return '5min';
      default:
        return this.parameters.candlePeriod || '1min';
    }
  }

  shouldEvaluate(candleUpdate = {}) {
    switch (this.evaluationMode) {
      case '1m_close':
      case '5m_close':
        return Boolean(candleUpdate.candleClosed);
      case 'tick':
      default:
        return true;
    }
  }

  getCandleTime(date, period) {
    const d = new Date(date);
    
    switch (period) {
      case '1min':
        d.setSeconds(0, 0);
        break;
      case '5min':
        d.setSeconds(0, 0);
        d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
        break;
      case '15min':
        d.setSeconds(0, 0);
        d.setMinutes(Math.floor(d.getMinutes() / 15) * 15);
        break;
      case '1hour':
        d.setMinutes(0, 0, 0);
        break;
      case '1day':
        d.setHours(9, 15, 0, 0);
        break;
    }
    
    return d.getTime();
  }

  canEmitSignal() {
    if (!this.lastSignalTime) {
      return true;
    }
    
    const timeSinceLastSignal = Date.now() - this.lastSignalTime.getTime();
    return timeSinceLastSignal >= this.signalCooldown;
  }

  emitSignal(
    action,
    instrument,
    quantity,
    priceType = 'MARKET',
    price = null,
    extra = {},
  ) {
    if (!this.canEmitSignal()) {
      const timeSinceLastSignal = this.lastSignalTime
        ? Date.now() - this.lastSignalTime.getTime()
        : null;

      logger.debug('Signal blocked by cooldown', { 
        strategy: this.name, 
        instanceId: this.instanceId,
        timeSinceLastSignal
      });
      return null;
    }

    if (!this.instanceId || !this.clientId || !this.strategyId) {
      logger.error('Cannot emit signal - missing instance or client info', {
        instanceId: this.instanceId,
        clientId: this.clientId,
        strategyId: this.strategyId
      });
      return null;
    }

    const signal = {
      event_id: generateSignalEventId(this.clientId, this.strategyId),
      strategy_instance_id: this.instanceId,
      client_id: this.clientId,
      strategy_id: this.strategyId,
      symbol: this.getSymbol(),
      instrument: instrument,
      action: action,
      quantity: quantity,
      price_type: priceType,
      price: price,
      timestamp: formatIST(),
      ...extra,
    };

    this.lastSignalTime = new Date();

    if (this.onSignal) {
      this.onSignal(signal);
    }

    logger.info('Signal emitted', { 
      strategy: this.name,
      instanceId: this.instanceId,
      action,
      instrument,
      quantity,
      eventId: signal.event_id
    });

    return signal;
  }

  getSymbol() {
    return this.parameters.symbol || 'UNKNOWN';
  }

  setState(newState) {
    const oldState = this.state;
    this.state = newState;
    
    logger.info('Strategy state changed', {
      strategy: this.name,
      instanceId: this.instanceId,
      oldState,
      newState
    });
  }

  pause() {
    if (this.state === STRATEGY_STATES.RUNNING) {
      this.setState(STRATEGY_STATES.PAUSED);
    }
  }

  resume() {
    if (this.state === STRATEGY_STATES.PAUSED) {
      this.setState(STRATEGY_STATES.RUNNING);
    }
  }

  async stop() {
    this.setState(STRATEGY_STATES.STOPPED);
    await this.onStop();
  }

  async squareOff(reason = 'scheduler_square_off') {
    await this.onSquareOff(reason);

    if (this.state === STRATEGY_STATES.RUNNING) {
      this.pause();
    }
  }

  async onStop() {
  }

  async onSquareOff() {
    await this.onStop();
  }

  getState() {
    return this.state;
  }

  getStatus() {
    return {
      name: this.name,
      instanceId: this.instanceId,
      clientId: this.clientId,
      state: this.state,
      evaluationMode: this.evaluationMode,
      lastTick: this.lastTick?.timestamp,
      lastSignalTime: this.lastSignalTime ? formatIST(this.lastSignalTime) : null,
      candlesCount: this.candles.length,
      position: this.position
    };
  }

  calculateSMA(period) {
    if (this.candles.length < period) return null;
    
    const recentCandles = this.candles.slice(-period);
    const sum = recentCandles.reduce((acc, c) => acc + c.close, 0);
    return sum / period;
  }

  calculateEMA(period, prevEMA = null) {
    if (this.candles.length < period) return null;
    
    const multiplier = 2 / (period + 1);
    const prices = this.candles.map(c => c.close);
    
    if (prevEMA === null) {
      return this.calculateSMA(period);
    }
    
    let ema = prevEMA;
    for (const price of prices) {
      ema = (price - ema) * multiplier + ema;
    }
    
    return ema;
  }

  calculateATR(period = 14) {
    if (this.candles.length < period + 1) return null;
    
    const trueRanges = [];
    
    for (let i = 1; i < this.candles.length; i++) {
      const high = this.candles[i].high;
      const low = this.candles[i].low;
      const prevClose = this.candles[i - 1].close;
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }
    
    const recentTR = trueRanges.slice(-period);
    return recentTR.reduce((a, b) => a + b, 0) / period;
  }

  calculateRSI(period = 14) {
    if (this.candles.length < period + 1) return null;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = this.candles.length - period; i < this.candles.length; i++) {
      const change = this.candles[i].close - this.candles[i - 1].close;
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    
    if (losses === 0) return 100;
    
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }
}

module.exports = {
  BaseStrategy,
  STRATEGY_STATES
};
