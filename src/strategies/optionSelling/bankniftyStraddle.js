const { logger } = require('../../core/logger/logger');
const { BaseStrategy } = require('../baseStrategy');

class BankNiftyStraddle extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: 'BANKNIFTY_STRADDLE'
    });

    this.parameters = {
      ...this.parameters,
      strikeOffset: config.strikeOffset || 0,
      expiry: config.expiry || 'weekly',
      hedgeEnabled: config.hedgeEnabled || true,
      ...config.parameters
    };

    this.lastBreakoutCheck = null;
    this.breakoutThreshold = this.parameters.breakoutThreshold || 0.5;
    this.atrMultiplier = this.parameters.atrMultiplier || 2;
  }

  async onInit() {
    logger.info('Initializing BANKNIFTY_STRADDLE strategy', {
      instanceId: this.instanceId,
      parameters: this.parameters
    });
  }

  async onTick(tick) {
    if (!tick || !tick.ltp || tick.ltp === 0) {
      return null;
    }

    const atr = this.calculateATR(14);
    const currentPrice = tick.ltp;

    if (!atr) {
      return null;
    }

    const upperBand = currentPrice + (atr * this.atrMultiplier);
    const lowerBand = currentPrice - (atr * this.atrMultiplier);

    const lastCandle = this.candles[this.candles.length - 1];
    const prevCandle = this.candles[this.candles.length - 2];

    if (!lastCandle || !prevCandle) {
      return null;
    }

    if (prevCandle.close < upperBand && lastCandle.close > upperBand) {
      return this.emitSignal(
        'SELL',
        `BANKNIFTY ${Math.round(currentPrice / 100) * 100} CE`,
        this.parameters.quantity || 50,
        'MARKET',
        null
      );
    }

    if (prevCandle.close > lowerBand && lastCandle.close < lowerBand) {
      return this.emitSignal(
        'SELL',
        `BANKNIFTY ${Math.round(currentPrice / 100) * 100} PE`,
        this.parameters.quantity || 50,
        'MARKET',
        null
      );
    }

    return null;
  }

  async onStop() {
    logger.info('Stopping BANKNIFTY_STRADDLE strategy', {
      instanceId: this.instanceId
    });
  }
}

BankNiftyStraddle.description = 'Sell ATM straddle on BANKNIFTY with ATR-based entry';

module.exports = { BankNiftyStraddle };
