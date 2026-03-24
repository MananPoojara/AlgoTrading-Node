const { logger } = require('../../core/logger/logger');
const { BaseStrategy } = require('../baseStrategy');

class WeeklyStrangle extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: 'WEEKLY_STRANGLE'
    });

    this.parameters = {
      ...this.parameters,
      deltaTarget: config.deltaTarget || 0.15,
      expiry: config.expiry || 'weekly',
      adjustOnRisk: config.adjustOnRisk || true,
      ...config.parameters
    };

    this.deltaTarget = this.parameters.deltaTarget;
    this.entryDone = false;
    this.otmDistance = 0;
    this.adjustmentCount = 0;
  }

  async onInit() {
    logger.info('Initializing WEEKLY_STRANGLE strategy', {
      instanceId: this.instanceId,
      parameters: this.parameters
    });

    this.otmDistance = 100;
  }

  calculateOTMDistance(currentPrice) {
    if (!currentPrice) {
      this.otmDistance = 100;
      return;
    }
    
    if (currentPrice > 40000) {
      this.otmDistance = 300;
    } else if (currentPrice > 25000) {
      this.otmDistance = 200;
    } else if (currentPrice > 15000) {
      this.otmDistance = 150;
    } else {
      this.otmDistance = 100;
    }
  }

  async onTick(tick) {
    if (!tick || !tick.ltp || tick.ltp === 0) {
      return null;
    }

    const currentPrice = tick.ltp;
    
    if (this.otmDistance === 100) {
      this.calculateOTMDistance(currentPrice);
    }
    
    const strike = Math.round(currentPrice / 100) * 100;

    const callStrike = strike + this.otmDistance;
    const putStrike = strike - this.otmDistance;

    if (!this.entryDone && this.canEmitSignal()) {
      const sellCall = this.emitSignal(
        'SELL',
        `NIFTY ${callStrike} CE`,
        Math.max(1, this.parameters.quantity || 25),
        'MARKET',
        null
      );

      if (sellCall) {
        const sellPut = this.emitSignal(
          'SELL',
          `NIFTY ${putStrike} PE`,
          Math.max(1, this.parameters.quantity || 25),
          'MARKET',
          null
        );

        if (sellPut) {
          this.entryDone = true;
          logger.info('Strangle entry completed', {
            instanceId: this.instanceId,
            callStrike,
            putStrike,
            quantity: this.parameters.quantity
          });
        }
      }
    }

    if (this.entryDone && this.parameters.adjustOnRisk) {
      const rsi = this.calculateRSI(14);
      
      if (rsi !== null) {
        if (rsi < 30 || rsi > 70) {
          this.adjustmentCount++;
          logger.info('Strangle adjustment triggered by RSI', {
            instanceId: this.instanceId,
            rsi,
            adjustmentCount: this.adjustmentCount
          });
        }
      }
    }

    return null;
  }

  async onStop() {
    logger.info('Stopping WEEKLY_STRANGLE strategy', {
      instanceId: this.instanceId,
      entryDone: this.entryDone,
      adjustmentCount: this.adjustmentCount
    });
  }

  reset() {
    this.entryDone = false;
    this.adjustmentCount = 0;
  }
}

WeeklyStrangle.description = 'Sell OTM strangle on weekly expiry with delta target';

module.exports = { WeeklyStrangle };
