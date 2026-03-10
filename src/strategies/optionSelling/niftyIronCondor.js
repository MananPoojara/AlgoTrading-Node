const { logger } = require('../../../core/logger/logger');
const { BaseStrategy } = require('../../baseStrategy');

class NiftyIronCondor extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      name: 'NIFTY_IRONCONDOR'
    });

    this.parameters = {
      ...this.parameters,
      wings: config.wings || 200,
      expiry: config.expiry || 'weekly',
      adjustOnSpread: config.adjustOnSpread || true,
      ...config.parameters
    };

    this.wings = this.parameters.wings;
    this.entryDone = false;
    this.lastAdjustmentTime = null;
  }

  async onInit() {
    logger.info('Initializing NIFTY_IRONCONDOR strategy', {
      instanceId: this.instanceId,
      parameters: this.parameters
    });
  }

  async onTick(tick) {
    if (!tick || !tick.ltp || tick.ltp === 0) {
      return null;
    }

    const currentPrice = tick.ltp;
    const atmStrike = Math.round(currentPrice / 50) * 50;

    const upperWing = atmStrike + (this.wings * 2);
    const lowerWing = atmStrike - (this.wings * 2);

    if (!this.entryDone && this.canEmitSignal()) {
      const buyCE = this.emitSignal(
        'BUY',
        `NIFTY ${upperWing} CE`,
        this.parameters.quantity || 25,
        'MARKET',
        null
      );

      if (buyCE) {
        const sellCE = this.emitSignal(
          'SELL',
          `NIFTY ${atmStrike} CE`,
          this.parameters.quantity || 25,
          'MARKET',
          null
        );

        const sellPE = this.emitSignal(
          'SELL',
          `NIFTY ${atmStrike} PE`,
          this.parameters.quantity || 25,
          'MARKET',
          null
        );

        const buyPE = this.emitSignal(
          'BUY',
          `NIFTY ${lowerWing} PE`,
          this.parameters.quantity || 25,
          'MARKET',
          null
        );

        if (sellCE && sellPE && buyPE) {
          this.entryDone = true;
        }
      }
    }

    if (this.entryDone && this.parameters.adjustOnSpread) {
      const spread = Math.abs((currentPrice - atmStrike));
      
      if (spread > this.wings * 1.5) {
        this.lastAdjustmentTime = new Date();
        logger.info('Iron condor adjustment triggered', { 
          instanceId: this.instanceId,
          currentPrice,
          atmStrike,
          spread 
        });
      }
    }

    return null;
  }

  async onStop() {
    logger.info('Stopping NIFTY_IRONCONDOR strategy', {
      instanceId: this.instanceId,
      entryDone: this.entryDone
    });
  }

  reset() {
    this.entryDone = false;
    this.lastAdjustmentTime = null;
  }
}

NiftyIronCondor.description = 'Sell iron condor on NIFTY with adjustable wings';

module.exports = { NiftyIronCondor };
