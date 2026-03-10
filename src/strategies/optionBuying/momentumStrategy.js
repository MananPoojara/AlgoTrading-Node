const { logger } = require('../../../core/logger/logger');
const { BaseStrategy } = require('../../baseStrategy');

class MomentumStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: 'MOMENTUM_STRATEGY'
    });

    this.parameters = {
      ...this.parameters,
      rsiOversold: config.rsiOversold || 30,
      rsiOverbought: config.rsiOverbought || 70,
      timeframe: config.timeframe || '5min',
      confirmationCandles: config.confirmationCandles || 2,
      ...config.parameters
    };

    this.rsiOversold = this.parameters.rsiOversold;
    this.rsiOverbought = this.parameters.rsiOverbought;
    this.confirmationCandles = this.parameters.confirmationCandles;
    
    this.position = null;
    this.entryPrice = null;
    this.rsiHistory = [];
    this.signalConfirmed = 0;
  }

  async onInit() {
    logger.info('Initializing MOMENTUM_STRATEGY', {
      instanceId: this.instanceId,
      parameters: this.parameters
    });
  }

  async onTick(tick) {
    if (!tick || !tick.ltp || tick.ltp === 0) {
      return null;
    }

    const rsi = this.calculateRSI(14);
    if (rsi === null) {
      return null;
    }

    this.rsiHistory.push(rsi);
    if (this.rsiHistory.length > 20) {
      this.rsiHistory.shift();
    }

    const currentPrice = tick.ltp;
    const symbol = this.parameters.symbol || 'NIFTY';

    if (!this.position) {
      if (rsi < this.rsiOversold) {
        this.signalConfirmed++;
        
        if (this.signalConfirmed >= this.confirmationCandles) {
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
            
            logger.info('Momentum entry - oversold RSI', {
              instanceId: this.instanceId,
              rsi,
              entryPrice: this.entryPrice
            });
          }
        }
      } else {
        this.signalConfirmed = 0;
      }
    }

    if (this.position === 'LONG') {
      const pnlPercentage = ((currentPrice - this.entryPrice) / this.entryPrice) * 100;
      const targetPercentage = this.parameters.targetPercentage || 3;
      
      if (rsi > this.rsiOverbought || pnlPercentage > targetPercentage) {
        const exitStrike = Math.round(currentPrice / 50) * 50;
        this.emitSignal(
          'SELL',
          `${symbol} ${exitStrike} CE`,
          Math.max(1, this.parameters.quantity || 25),
          'MARKET',
          null
        );

        logger.info('Momentum exit', {
          instanceId: this.instanceId,
          exitPrice: currentPrice,
          pnlPercentage
        });

        this.position = null;
        this.entryPrice = null;
        this.signalConfirmed = 0;
      }
    }

    return null;
  }

  async onStop() {
    if (this.position) {
      const currentPrice = this.lastTick?.ltp || 0;
      const exitStrike = Math.round(currentPrice / 50) * 50;
      const currentPrice = this.lastTick?.ltp || 0;
      const exitStrike = Math.round(currentPrice / 50) * 50;
      logger.info('Closing momentum position on stop', {
        instanceId: this.instanceId,
        position: this.position
      });
      
      this.emitSignal(
        'SELL',
        `${this.parameters.symbol || 'NIFTY'} ${exitStrike} CE`,
        Math.max(1, this.parameters.quantity || 25),
        'MARKET',
        null
      );
    }
    
    logger.info('Stopping MOMENTUM_STRATEGY', {
      instanceId: this.instanceId,
      position: this.position
    });
  }
}

MomentumStrategy.description = 'RSI-based momentum strategy for intraday';

module.exports = { MomentumStrategy };
