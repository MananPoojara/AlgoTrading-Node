const { logger } = require('../../../core/logger/logger');
const { BaseStrategy } = require('../../baseStrategy');

class BullSpread extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: 'BULL_SPREAD'
    });

    this.parameters = {
      ...this.parameters,
      spreadWidth: config.spreadWidth || 100,
      quantity: config.quantity || 25,
      ...config.parameters
    };

    this.spreadWidth = this.parameters.spreadWidth;
    this.quantity = this.parameters.quantity;
    this.entryDone = false;
    this.inPosition = false;
  }

  async onInit() {
    logger.info('Initializing BULL_SPREAD strategy', {
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
    const atmStrike = Math.round(currentPrice / 50) * 50;

    if (!this.entryDone && this.canEmitSignal()) {
      const buyCall = this.emitSignal(
        'BUY',
        `${symbol} ${atmStrike} CE`,
        this.quantity,
        'MARKET',
        null
      );

      if (buyCall) {
        const sellCall = this.emitSignal(
          'SELL',
          `${symbol} ${atmStrike + this.spreadWidth} CE`,
          this.quantity,
          'MARKET',
          null
        );

        if (sellCall) {
          this.entryDone = true;
          this.inPosition = true;
          
          logger.info('Bull spread entered', {
            instanceId: this.instanceId,
            longStrike: atmStrike,
            shortStrike: atmStrike + this.spreadWidth,
            quantity: this.quantity
          });
        }
      }
    }

    if (this.inPosition && this.candles.length >= 10) {
      const ema9 = this.calculateEMA(9);
      const ema21 = this.calculateEMA(21);

      if (ema9 && ema21 && ema9 < ema21 * 0.98) {
        this.emitSignal(
          'SELL',
          `${symbol} ${atmStrike} CE`,
          this.quantity,
          'MARKET',
          null
        );

        this.emitSignal(
          'BUY',
          `${symbol} ${atmStrike + this.spreadWidth} CE`,
          this.quantity,
          'MARKET',
          null
        );

        logger.info('Bull spread exited - trend reversal', {
          instanceId: this.instanceId,
          ema9,
          ema21
        });

        this.inPosition = false;
      }
    }

    return null;
  }

  async onStop() {
    if (this.inPosition) {
      const symbol = this.parameters.symbol || 'NIFTY';
      const currentPrice = this.lastTick?.ltp || 0;
      const atmStrike = Math.round(currentPrice / 50) * 50;

      this.emitSignal(
        'SELL',
        `${symbol} ${atmStrike} CE`,
        this.quantity,
        'MARKET',
        null
      );

      this.emitSignal(
        'BUY',
        `${symbol} ${atmStrike + this.spreadWidth} CE`,
        this.quantity,
        'MARKET',
        null
      );
    }
    
    logger.info('Stopping BULL_SPREAD', {
      instanceId: this.instanceId,
      inPosition: this.inPosition
    });
  }
}

BullSpread.description = 'Bull call spread for bullish markets';

module.exports = { BullSpread };
