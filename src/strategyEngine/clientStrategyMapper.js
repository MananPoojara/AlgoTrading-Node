const { logger } = require('../core/logger/logger');
const { query } = require('../database/postgresClient');

class ClientStrategyMapper {
  constructor() {
    this.mappings = new Map();
    this.clientStrategies = new Map();
  }

  async loadFromDatabase() {
    logger.info('Loading client-strategy mappings from database');

    try {
      const result = await query(`
        SELECT 
          si.id as instance_id,
          si.client_id,
          si.strategy_id,
          si.status as instance_status,
          s.name as strategy_name,
          s.type as strategy_type,
          s.file_path,
          si.parameters as instance_parameters,
          c.name as client_name
        FROM strategy_instances si
        JOIN strategies s ON si.strategy_id = s.id
        JOIN clients c ON si.client_id = c.id
        WHERE si.status IN ('running', 'paused')
      `);

      for (const row of result.rows) {
        this.addMapping({
          instanceId: row.instance_id,
          clientId: row.client_id,
          clientName: row.client_name,
          strategyId: row.strategy_id,
          strategyName: row.strategy_name,
          strategyType: row.strategy_type,
          filePath: row.file_path,
          parameters: row.instance_parameters || {},
          status: row.instance_status
        });
      }

      logger.info('Loaded client-strategy mappings', { count: this.mappings.size });
      return this.mappings;

    } catch (error) {
      logger.error('Failed to load mappings from database', { error: error.message });
      throw error;
    }
  }

  addMapping(mapping) {
    const { instanceId, clientId, strategyId, strategyName, strategyType, filePath, parameters, status } = mapping;

    this.mappings.set(instanceId, mapping);

    if (!this.clientStrategies.has(clientId)) {
      this.clientStrategies.set(clientId, []);
    }

    this.clientStrategies.get(clientId).push({
      instanceId,
      strategyId,
      strategyName,
      strategyType,
      filePath,
      parameters,
      status
    });

    logger.debug('Added mapping', { instanceId, clientId, strategyName });
  }

  removeMapping(instanceId) {
    const mapping = this.mappings.get(instanceId);
    
    if (mapping) {
      const clientId = mapping.clientId;
      
      this.mappings.delete(instanceId);
      
      if (this.clientStrategies.has(clientId)) {
        const strategies = this.clientStrategies.get(clientId);
        const index = strategies.findIndex(s => s.instanceId === instanceId);
        if (index > -1) {
          strategies.splice(index, 1);
        }
      }
      
      logger.debug('Removed mapping', { instanceId });
    }
  }

  getMapping(instanceId) {
    return this.mappings.get(instanceId);
  }

  getStrategiesForClient(clientId) {
    return this.clientStrategies.get(clientId) || [];
  }

  getClientsForStrategy(strategyId) {
    const clients = [];
    
    for (const [instanceId, mapping] of this.mappings) {
      if (mapping.strategyId === strategyId) {
        clients.push({
          instanceId,
          clientId: mapping.clientId,
          clientName: mapping.clientName
        });
      }
    }
    
    return clients;
  }

  getActiveStrategies() {
    const active = [];
    
    for (const [instanceId, mapping] of this.mappings) {
      if (mapping.status === 'running') {
        active.push(mapping);
      }
    }
    
    return active;
  }

  getInstruments() {
    const instruments = new Set();
    
    for (const [_, mapping] of this.mappings) {
      if (mapping.parameters?.symbol) {
        instruments.add(mapping.parameters.symbol);
      }
    }
    
    return Array.from(instruments);
  }

  getGroupedByInstrument() {
    const groups = new Map();
    
    for (const [instanceId, mapping] of this.mappings) {
      const symbol = mapping.parameters?.symbol || 'UNKNOWN';
      
      if (!groups.has(symbol)) {
        groups.set(symbol, []);
      }
      
      groups.get(symbol).push(mapping);
    }
    
    return groups;
  }

  updateStatus(instanceId, status) {
    const mapping = this.mappings.get(instanceId);
    
    if (mapping) {
      mapping.status = status;
      logger.info('Updated instance status', { instanceId, status });
    }
  }

  getAll() {
    return new Map(this.mappings);
  }

  getAllClients() {
    return Array.from(this.clientStrategies.keys());
  }

  clear() {
    this.mappings.clear();
    this.clientStrategies.clear();
    logger.info('Cleared all mappings');
  }
}

let mapperInstance = null;

const getClientStrategyMapper = () => {
  if (!mapperInstance) {
    mapperInstance = new ClientStrategyMapper();
  }
  return mapperInstance;
};

module.exports = {
  ClientStrategyMapper,
  getClientStrategyMapper
};
