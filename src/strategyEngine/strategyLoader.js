const fs = require('fs');
const path = require('path');
const { logger } = require('../core/logger/logger');
const { BaseStrategy } = require('../strategies/baseStrategy');

class StrategyLoader {
  constructor(options = {}) {
    this.strategiesPath = options.strategiesPath || path.join(__dirname, '../strategies');
    this.strategies = new Map();
    this.loaded = false;
  }

  async loadAll() {
    logger.info('Loading strategies from', { path: this.strategiesPath });

    const categories = ['optionSelling', 'optionBuying', 'spreads', 'intraday'];

    for (const category of categories) {
      const categoryPath = path.join(this.strategiesPath, category);
      
      if (!fs.existsSync(categoryPath)) {
        continue;
      }

      const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'));

      for (const file of files) {
        try {
          const strategyName = file.replace('.js', '');
          const loadedModule = require(path.join(categoryPath, file));
          const StrategyClass = this.resolveStrategyExport(loadedModule);
          
          if (
            typeof StrategyClass === 'function' &&
            StrategyClass.prototype instanceof BaseStrategy
          ) {
            const key = `${category}_${strategyName}`.toUpperCase();
            this.strategies.set(key, StrategyClass);
            
            logger.debug('Loaded strategy', { category, strategyName: StrategyClass.name });
          }
        } catch (error) {
          logger.error('Failed to load strategy', { 
            file, 
            error: error.message 
          });
        }
      }
    }

    this.loaded = true;
    logger.info('All strategies loaded', { count: this.strategies.size });
    
    return this.strategies;
  }

  get(strategyKey) {
    const key = strategyKey.toUpperCase();
    
    if (!this.strategies.has(key)) {
      logger.warn('Strategy not found', { key, available: Array.from(this.strategies.keys()) });
      return null;
    }
    
    return this.strategies.get(key);
  }

  resolveStrategyExport(loadedModule) {
    if (typeof loadedModule === 'function') {
      return loadedModule;
    }

    if (!loadedModule || typeof loadedModule !== 'object') {
      return null;
    }

    const exportedValues = Object.values(loadedModule);
    return exportedValues.find((value) => typeof value === 'function') || null;
  }

  getAll() {
    return new Map(this.strategies);
  }

  getByCategory(category) {
    const prefix = `${category.toLowerCase()}_`;
    const filtered = new Map();
    
    for (const [key, StrategyClass] of this.strategies) {
      if (key.startsWith(prefix.toUpperCase())) {
        filtered.set(key, StrategyClass);
      }
    }
    
    return filtered;
  }

  has(strategyKey) {
    return this.strategies.has(strategyKey.toUpperCase());
  }

  list() {
    const list = [];
    
    for (const [key, StrategyClass] of this.strategies) {
      list.push({
        key,
        name: StrategyClass.name,
        description: StrategyClass.description || ''
      });
    }
    
    return list;
  }

  reload() {
    this.strategies.clear();
    this.loaded = false;
    return this.loadAll();
  }
}

let loaderInstance = null;

const getStrategyLoader = (options = {}) => {
  if (!loaderInstance) {
    loaderInstance = new StrategyLoader(options);
  }
  return loaderInstance;
};

const loadStrategy = async (strategyKey) => {
  const loader = getStrategyLoader();
  
  if (!loader.loaded) {
    await loader.loadAll();
  }
  
  return loader.get(strategyKey);
};

module.exports = {
  StrategyLoader,
  getStrategyLoader,
  loadStrategy
};
