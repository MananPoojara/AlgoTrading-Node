const { logger, childLogger } = require('../../core/logger/logger');
const { getPublisher, CHANNELS } = require('../../core/eventBus/publisher');
const { getSubscriber, CHANNELS: SUB_CHANNELS } = require('../../core/eventBus/subscriber');
const { getRedisClient } = require('../../core/eventBus/redisClient');
const { BaseStrategy, STRATEGY_STATES } = require('../strategies/baseStrategy');
const { getStrategyLoader } = require('./strategyLoader');
const config = require('../../../config/default');

const SERVICE_NAME = 'strategy-engine';
const logger = childLogger(SERVICE_NAME);

const WORKER_STATES = {
  CREATED: 'created',
  INITIALIZING: 'initializing',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  FAILED: 'failed',
  RESTARTING: 'restarting'
};

class StrategyWorker {
  constructor(options = {}) {
    this.id = options.id || `worker_${Date.now()}`;
    this.group = options.group || 'default';
    this.strategies = new Map();
    this.state = WORKER_STATES.CREATED;
    this.tickHandlers = new Map();
    this.publisher = null;
    this.redis = null;
    this.heartbeatInterval = null;
    this.stats = {
      ticksProcessed: 0,
      signalsGenerated: 0,
      errors: 0,
      startedAt: null
    };
  }

  async initialize() {
    this.setState(WORKER_STATES.INITIALIZING);
    
    this.publisher = getPublisher();
    this.redis = getRedisClient();
    await this.redis.connect();
    
    await this.subscribeToMarketTicks();
    this.startHeartbeat();
    
    this.setState(WORKER_STATES.RUNNING);
    this.stats.startedAt = new Date().toISOString();
    
    logger.info('Worker initialized', { workerId: this.id, group: this.group });
  }

  async subscribeToMarketTicks() {
    const subscriber = getSubscriber();
    
    await subscriber.subscribeToMarketTicks((tick) => {
      this.handleTick(tick);
    });
    
    logger.info('Subscribed to market ticks');
  }

  handleTick(tick) {
    if (this.state !== WORKER_STATES.RUNNING) {
      return;
    }

    this.stats.ticksProcessed++;

    for (const [instanceId, strategy] of this.strategies) {
      try {
        if (strategy.getSymbol() === tick.symbol) {
          const signal = strategy.processTick(tick);
          
          if (signal) {
            this.handleSignal(signal);
          }
        }
      } catch (error) {
        logger.error('Error processing tick for strategy', {
          workerId: this.id,
          instanceId,
          error: error.message
        });
        this.stats.errors++;
      }
    }
  }

  async handleSignal(signal) {
    try {
      await this.publisher.publishStrategySignal(signal);
      this.stats.signalsGenerated++;
      
      logger.info('Signal published', {
        workerId: this.id,
        eventId: signal.event_id,
        action: signal.action,
        instrument: signal.instrument
      });
    } catch (error) {
      logger.error('Failed to publish signal', {
        workerId: this.id,
        error: error.message,
        signal
      });
    }
  }

  registerStrategy(instanceId, strategy) {
    strategy.instanceId = instanceId;
    strategy.onSignal = (signal) => this.handleSignal(signal);
    
    this.strategies.set(instanceId, strategy);
    
    logger.info('Strategy registered', {
      workerId: this.id,
      instanceId,
      strategyName: strategy.name
    });
  }

  unregisterStrategy(instanceId) {
    const strategy = this.strategies.get(instanceId);
    
    if (strategy) {
      strategy.stop();
      this.strategies.delete(instanceId);
      
      logger.info('Strategy unregistered', {
        workerId: this.id,
        instanceId
      });
    }
  }

  getStrategy(instanceId) {
    return this.strategies.get(instanceId);
  }

  startHeartbeat() {
    const interval = config.heartbeat.intervalSeconds * 1000;
    
    this.heartbeatInterval = setInterval(async () => {
      await this.sendHeartbeat();
    }, interval);
    
    this.sendHeartbeat();
  }

  async sendHeartbeat() {
    try {
      const heartbeat = {
        worker_id: this.id,
        group: this.group,
        status: this.state,
        timestamp: new Date().toISOString(),
        strategies_count: this.strategies.size,
        ticks_processed: this.stats.ticksProcessed,
        signals_generated: this.stats.signalsGenerated,
        errors: this.stats.errors
      };

      await this.publisher.publishWorkerHeartbeat(heartbeat);
    } catch (error) {
      logger.error('Failed to send heartbeat', { error: error.message });
    }
  }

  setState(newState) {
    const oldState = this.state;
    this.state = newState;
    
    logger.info('Worker state changed', {
      workerId: this.id,
      oldState,
      newState
    });
  }

  pause() {
    if (this.state === WORKER_STATES.RUNNING) {
      for (const [_, strategy] of this.strategies) {
        strategy.pause();
      }
      this.setState(WORKER_STATES.PAUSED);
    }
  }

  resume() {
    if (this.state === WORKER_STATES.PAUSED) {
      for (const [_, strategy] of this.strategies) {
        strategy.resume();
      }
      this.setState(WORKER_STATES.RUNNING);
    }
  }

  async stop() {
    this.setState(WORKER_STATES.STOPPED);

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const [instanceId, strategy] of this.strategies) {
      await strategy.stop();
    }
    this.strategies.clear();

    logger.info('Worker stopped', { workerId: this.id });
  }

  getStatus() {
    return {
      id: this.id,
      group: this.group,
      state: this.state,
      strategies: Array.from(this.strategies.keys()),
      stats: this.stats
    };
  }
}

class WorkerManager {
  constructor() {
    this.workers = new Map();
    this.strategyToWorker = new Map();
    this.publisher = null;
    this.redis = null;
    this.isRunning = false;
    this.stats = {
      workersCreated: 0,
      strategiesLoaded: 0,
      restarts: 0
    };
  }

  async initialize() {
    logger.info('Initializing Worker Manager');
    
    this.publisher = getPublisher();
    this.redis = getRedisClient();
    await this.redis.connect();
    
    this.subscribeToControlCommands();
    
    logger.info('Worker Manager initialized');
  }

  async subscribeToControlCommands() {
    const subscriber = getSubscriber();
    
    await subscriber.subscribe('worker_control', async (message) => {
      await this.handleControlCommand(message);
    });
  }

  async handleControlCommand(message) {
    const { command, workerId, instanceId, data } = message;
    
    const allowedCommands = ['start_strategy', 'stop_strategy', 'pause_worker', 'resume_worker', 'stop_worker'];
    
    if (!command || !allowedCommands.includes(command)) {
      logger.warn('Invalid control command received', { command });
      return;
    }
    
    logger.info('Received control command', { command, workerId, instanceId });
    
    switch (command) {
      case 'start_strategy':
        await this.startStrategy(instanceId, data);
        break;
      case 'stop_strategy':
        await this.stopStrategy(instanceId);
        break;
      case 'pause_worker':
        this.pauseWorker(workerId);
        break;
      case 'resume_worker':
        this.resumeWorker(workerId);
        break;
      case 'stop_worker':
        await this.stopWorker(workerId);
        break;
    }
  }

  async createWorker(group = 'default') {
    const worker = new StrategyWorker({
      id: `worker_${group}_${Date.now()}`,
      group
    });
    
    await worker.initialize();
    
    this.workers.set(worker.id, worker);
    this.stats.workersCreated++;
    
    logger.info('Worker created', { workerId: worker.id, group });
    
    return worker;
  }

  async startStrategy(instanceId, config) {
    const { strategyKey, clientId, strategyId, parameters, group } = config;
    
    if (!strategyKey) {
      logger.error('Cannot start strategy - missing strategyKey', { instanceId });
      return;
    }

    const loader = getStrategyLoader();
    const StrategyClass = loader.get(strategyKey);
    
    if (!StrategyClass) {
      logger.error('Strategy not found', { strategyKey, available: loader.list() });
      return;
    }
    
    let worker = this.getWorkerForGroup(group);
    
    if (!worker) {
      worker = await this.createWorker(group);
    }

    const strategy = new StrategyClass({
      instanceId,
      clientId,
      strategyId,
      parameters: {
        ...parameters,
        symbol: parameters.symbol || 'BANKNIFTY'
      }
    });

    await strategy.initialize();
    
    worker.registerStrategy(instanceId, strategy);
    this.strategyToWorker.set(instanceId, worker.id);
    this.stats.strategiesLoaded++;
    
    logger.info('Strategy started', {
      instanceId,
      workerId: worker.id,
      clientId,
      strategyId
    });
  }

  async stopStrategy(instanceId) {
    const workerId = this.strategyToWorker.get(instanceId);
    
    if (!workerId) {
      logger.warn('Strategy not found', { instanceId });
      return;
    }

    const worker = this.workers.get(workerId);
    
    if (worker) {
      worker.unregisterStrategy(instanceId);
      this.strategyToWorker.delete(instanceId);
      
      logger.info('Strategy stopped', { instanceId, workerId });
    }
  }

  getWorkerForGroup(group) {
    for (const [_, worker] of this.workers) {
      if (worker.group === group && worker.state === WORKER_STATES.RUNNING) {
        return worker;
      }
    }
    return null;
  }

  getWorker(workerId) {
    return this.workers.get(workerId);
  }

  pauseWorker(workerId) {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.pause();
    }
  }

  resumeWorker(workerId) {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.resume();
    }
  }

  async stopWorker(workerId) {
    const worker = this.workers.get(workerId);
    if (worker) {
      await worker.stop();
      this.workers.delete(workerId);
    }
  }

  async stopAll() {
    logger.info('Stopping all workers');
    
    for (const [workerId, worker] of this.workers) {
      await worker.stop();
    }
    
    this.workers.clear();
    this.strategyToWorker.clear();
    
    logger.info('All workers stopped');
  }

  getStatus() {
    const workers = [];
    
    for (const [id, worker] of this.workers) {
      workers.push(worker.getStatus());
    }

    return {
      isRunning: this.isRunning,
      workersCount: this.workers.size,
      strategiesCount: this.strategyToWorker.size,
      stats: this.stats,
      workers
    };
  }
}

let managerInstance = null;

const getWorkerManager = () => {
  if (!managerInstance) {
    managerInstance = new WorkerManager();
  }
  return managerInstance;
};

async function main() {
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    const manager = getWorkerManager();
    await manager.stopAll();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    const manager = getWorkerManager();
    await manager.stopAll();
    process.exit(0);
  });

  try {
    const manager = getWorkerManager();
    await manager.initialize();
    
    logger.info('Strategy Engine is running');
  } catch (error) {
    logger.error('Failed to start Strategy Engine', { error: error.message });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  StrategyWorker,
  WorkerManager,
  getWorkerManager,
  WORKER_STATES
};
