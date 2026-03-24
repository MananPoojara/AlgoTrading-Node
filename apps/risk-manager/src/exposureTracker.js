const { logger } = require("../../../packages/core/logger/logger");

class ExposureTracker {
  constructor(options = {}) {
    this.byInstrument = new Map();
    this.bySector = new Map();
    this.byClient = new Map();
    this.sectorMapping = options.sectorMapping || {};
  }

  updatePosition(clientId, instrument, quantity, price) {
    const key = `${clientId}:${instrument}`;
    const value = quantity * price;

    const current = this.byInstrument.get(key) || 0;
    this.byInstrument.set(key, current + value);

    const sector = this.sectorMapping[instrument] || "OTHER";
    const sectorKey = `${clientId}:${sector}`;
    const sectorCurrent = this.bySector.get(sectorKey) || 0;
    this.bySector.set(sectorKey, sectorCurrent + value);

    const clientTotal = this.byClient.get(clientId) || 0;
    this.byClient.set(clientId, clientTotal + value);
  }

  getInstrumentExposure(clientId, instrument) {
    return this.byInstrument.get(`${clientId}:${instrument}`) || 0;
  }

  getSectorExposure(clientId, sector) {
    return this.bySector.get(`${clientId}:${sector}`) || 0;
  }

  getTotalExposure(clientId) {
    return this.byClient.get(clientId) || 0;
  }

  getAllExposures() {
    return {
      byInstrument: Object.fromEntries(this.byInstrument),
      bySector: Object.fromEntries(this.bySector),
      byClient: Object.fromEntries(this.byClient),
    };
  }

  checkSectorLimit(clientId, instrument, quantity, price, limit) {
    const sector = this.sectorMapping[instrument] || "OTHER";
    const currentExposure = this.getSectorExposure(clientId, sector);
    const newExposure = currentExposure + quantity * price;

    if (Math.abs(newExposure) > limit) {
      logger.warn("Sector exposure limit exceeded", {
        clientId,
        sector,
        current: currentExposure,
        requested: quantity * price,
        limit,
      });
      return { allowed: false, reason: "sector_exposure_limit", sector, limit };
    }

    return { allowed: true };
  }

  clearClient(clientId) {
    for (const key of this.byInstrument.keys()) {
      if (key.startsWith(`${clientId}:`)) {
        this.byInstrument.delete(key);
      }
    }

    for (const key of this.bySector.keys()) {
      if (key.startsWith(`${clientId}:`)) {
        this.bySector.delete(key);
      }
    }

    this.byClient.delete(clientId);
  }

  setSectorMapping(mapping) {
    this.sectorMapping = { ...this.sectorMapping, ...mapping };
  }
}

module.exports = { ExposureTracker };
