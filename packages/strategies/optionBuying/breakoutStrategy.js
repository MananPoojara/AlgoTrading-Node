const { logger } = require('../../core/logger/logger');
const { BaseStrategy } = require('../baseStrategy');

class BreakoutStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: 'BREAKOUT_STRATEGY'
    });

    this.parameters = {
      ...this.parameters,
      breakoutThreshold: config.breakoutThreshold || 0.5,
      atrMultiplier: config.atrMultiplier || 2,
      targetPercentage: config.targetPercentage || 3,
      stopLossPercentage: config.stopLossPercentage || 1,
      ...config.parameters
    };

    this.breakoutThreshold = this.parameters.breakoutThreshold;
    this.atrMultiplier = this.parameters.atrMultiplier;
    this.targetPercentage = this.parameters.targetPercentage;
    this.stopLossPercentage = this.parameters.stopLossPercentage;
    
    this.breakoutHigh = null;
    this.breakoutLow = null;
    this.inPosition = false;
    this.entryPrice = null;
    this.targetPrice = null;
    this.stopLossPrice = null;
  }

  async onInit() {
    logger.info('Initializing BREAKOUT_STRATEGY', {
      instanceId: this.instanceId,
      parameters: this.parameters
    });
  }

  async onTick(tick) {
    if (!tick || !tick.ltp || tick.ltp === 0) {
      return null;
    }

    const atr = this.calculateATR(14);
    if (!atr) {
      return null;
    }

    const currentPrice = tick.ltp;
    const consolidationHigh = currentPrice + (atr * this.breakoutThreshold);
    const consolidationLow = currentPrice - (atr * this.breakoutThreshold);

    if (!this.inPosition && this.candles.length >= 20) {
      const recentCandles = this.candles.slice(-20);
      const high20 = Math.max(...recentCandles.map(c => c.high));
      const low20 = Math.min(...recentCandles.map(c => c.low));
      const range = high20 - low20;

      if (currentPrice > high20 + (range * 0.1)) {
        const atmStrike = Math.round(currentPrice / 50) * 50;
        const signal = this.emitSignal(
          'BUY',
          `${this.parameters.symbol || 'NIFTY'} ${atmStrike} CE`,
          Math.max(1, this.parameters.quantity || 25),
          'MARKET',
          null
        );

        if (signal) {
          this.inPosition = true;
          this.entryPrice = currentPrice;
          this.targetPrice = currentPrice * (1 + this.targetPercentage / 100);
          this.stopLossPrice = currentPrice * (1 - this.stopLossPercentage / 100);
          
          logger.info('Breakout entry', {
            instanceId: this.instanceId,
            entryPrice: this.entryPrice,
            targetPrice: this.targetPrice,
            stopLossPrice: this.stopLossPrice
          });
        }
      }
    }

    if (this.inPosition) {
      if (currentPrice >= this.targetPrice) {
        logger.info('Breakout target hit - exiting', {
          instanceId: this.instanceId,
          currentPrice,
          targetPrice: this.targetPrice
        });
        
        const exitStrike = Math.round(currentPrice / 50) * 50;
        this.emitSignal(
          'SELL',
          `${this.parameters.symbol || 'NIFTY'} ${exitStrike} CE`,
          Math.max(1, this.parameters.quantity || 25),
          'MARKET',
          null
        );
        
        this.resetPosition();
      } else if (currentPrice <= this.stopLossPrice) {
        logger.info('Breakout stop loss hit - exiting', {
          instanceId: this.instanceId,
          currentPrice,
          stopLossPrice: this.stopLossPrice
        });
        
        const exitStrike = Math.round(currentPrice / 50) * 50;
        this.emitSignal(
          'SELL',
          `${this.parameters.symbol || 'NIFTY'} ${exitStrike} CE`,
          Math.max(1, this.parameters.quantity || 25),
          'MARKET',
          null
        );
        
        this.resetPosition();
      }
    }

    return null;
  }

  resetPosition() {
    this.inPosition = false;
    this.entryPrice = null;
    this.targetPrice = null;
    this.stopLossPrice = null;
  }

  async onStop() {
    if (this.inPosition) {
      const currentPrice = this.lastTick?.ltp || 0;
      logger.info('Closing breakout position on stop', {
        instanceId: this.instanceId
      });
      
      const exitStrike = Math.round(currentPrice / 50) * 50;
      this.emitSignal(
        'SELL',
        `${this.parameters.symbol || 'NIFTY'} ${exitStrike} CE`,
        Math.max(1, this.parameters.quantity || 25),
        'MARKET',
        null
      );
    }
    
    logger.info('Stopping BREAKOUT_STRATEGY', {
      instanceId: this.instanceId,
      inPosition: this.inPosition
    });
  }
}

BreakoutStrategy.description = 'Buy options on breakout from consolidation';

module.exports = { BreakoutStrategy };
