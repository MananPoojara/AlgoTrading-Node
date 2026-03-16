const { logger } = require('../../core/logger/logger');
const { BaseStrategy } = require('../baseStrategy');

class IntradayMomentum extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: 'INTRADAY_MOMENTUM'
    });

    this.parameters = {
      ...this.parameters,
      emaFast: config.emaFast || 9,
      emaSlow: config.emaSlow || 21,
      timeframe: config.timeframe || '5min',
      ...config.parameters
    };

    this.emaFast = this.parameters.emaFast;
    this.emaSlow = this.parameters.emaSlow;
    
    this.position = null;
    this.entryPrice = null;
    this.prevEmaFast = null;
    this.squareOffTime = '15:10';
  }

  async onInit() {
    logger.info('Initializing INTRADAY_MOMENTUM strategy', {
      instanceId: this.instanceId,
      parameters: this.parameters
    });
  }

  async onTick(tick) {
    if (!tick || !tick.ltp || tick.ltp === 0) {
      return null;
    }

    const currentPrice = tick.ltp;
    const symbol = this.parameters.symbol || 'NIFTY';
    const emaFast = this.calculateEMA(this.emaFast);
    const emaSlow = this.calculateEMA(this.emaSlow);

    if (!emaFast || !emaSlow) {
      return null;
    }

    const shouldSquareOff = this.checkSquareOffTime(tick.timestamp);

    if (shouldSquareOff && this.position) {
      await this.closePosition(symbol, 'Square off time');
      return null;
    }

    if (!this.position) {
      const crossover = this.prevEmaFast && this.prevEmaFast <= this.prevEmaSlow && emaFast > emaSlow;
      
      if (crossover) {
        const atmStrike = Math.round(currentPrice / 50) * 50;
        const signal = this.emitSignal(
          'BUY',
          `${symbol} ${atmStrike} CE`,
          Math.max(1, this.parameters.quantity || 25),
          'MARKET',
          null
        );

        if (signal) {
          this.position = 'LONG';
          this.entryPrice = currentPrice;
          
          logger.info('Intraday momentum entry', {
            instanceId: this.instanceId,
            entryPrice: this.entryPrice,
            emaFast,
            emaSlow
          });
        }
      }
    }

    if (this.position === 'LONG') {
      const crossoverDown = emaFast < emaSlow;
      const stopLossPct = (this.parameters.stopLossPercentage || 2) / 100;
      const targetPct = (this.parameters.targetPercentage || 2) / 100;
      const stopLossHit = currentPrice < (this.entryPrice * (1 - stopLossPct));
      const targetHit = currentPrice > (this.entryPrice * (1 + targetPct));

      if (crossoverDown || stopLossHit || targetHit) {
        await this.closePosition(symbol, crossoverDown ? 'Trend reversal' : (stopLossHit ? 'Stop loss' : 'Target hit'));
      }
    }

    this.prevEmaFast = emaFast;
    this.prevEmaSlow = emaSlow;

    return null;
  }

  checkSquareOffTime(timestamp) {
    if (!timestamp) return false;
    
    const date = new Date(timestamp);
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const currentTime = hours * 60 + minutes;
    
    const [squareOffHour, squareOffMin] = this.squareOffTime.split(':').map(Number);
    const squareOffTimeMinutes = squareOffHour * 60 + squareOffMin;
    
    return currentTime >= squareOffTimeMinutes;
  }

  async closePosition(symbol, reason) {
    this.emitSignal(
      'SELL',
      `${symbol} ATM CE`,
      this.parameters.quantity || 25,
      'MARKET',
      null
    );

    const exitPrice = this.lastTick?.ltp || 0;
    const pnl = exitPrice - this.entryPrice;
    const pnlPercentage = ((exitPrice - this.entryPrice) / this.entryPrice) * 100;

    logger.info('Intraday momentum exit', {
      instanceId: this.instanceId,
      reason,
      exitPrice,
      pnl,
      pnlPercentage
    });

    this.position = null;
    this.entryPrice = null;
  }

  async onStop() {
    if (this.position) {
      await this.closePosition(this.parameters.symbol || 'NIFTY', 'Strategy stopped');
    }
    
    logger.info('Stopping INTRADAY_MOMENTUM', {
      instanceId: this.instanceId,
      position: this.position
    });
  }
}

IntradayMomentum.description = 'EMA crossover based intraday momentum strategy';

module.exports = { IntradayMomentum };
