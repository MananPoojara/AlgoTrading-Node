jest.mock("../src/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => ({
    publishWorkerHeartbeat: jest.fn().mockResolvedValue(true),
    publishStrategySignal: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock("../src/core/eventBus/subscriber", () => ({
  getSubscriber: jest.fn(() => ({
    subscribe: jest.fn().mockResolvedValue(true),
    subscribeToMarketTicks: jest.fn().mockResolvedValue(true),
  })),
  CHANNELS: {},
}));

jest.mock("../src/core/eventBus/redisClient", () => ({
  getRedisClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(true),
  })),
}));

const mockLoadAll = jest.fn().mockResolvedValue(true);
const mockGet = jest.fn();

jest.mock("../src/strategyEngine/strategyLoader", () => ({
  getStrategyLoader: jest.fn(() => ({
    loaded: true,
    loadAll: mockLoadAll,
    get: mockGet,
    list: jest.fn(() => ["INTRADAY_STRATEGY1LIVE"]),
  })),
}));

const mockLoadFromDatabase = jest.fn();
const mockGetAll = jest.fn();

jest.mock("../src/strategyEngine/clientStrategyMapper", () => ({
  getClientStrategyMapper: jest.fn(() => ({
    loadFromDatabase: mockLoadFromDatabase,
    getAll: mockGetAll,
  })),
}));

const { WorkerManager } = require("../src/strategyEngine/workerManager");
const { STRATEGY_STATES } = require("../src/strategies/baseStrategy");
const { WORKER_STATES } = require("../src/strategyEngine/workerManager");

describe("WorkerManager restart recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadFromDatabase.mockResolvedValue(new Map());
  });

  it("restores running and paused strategy instances during initialize", async () => {
    const initialize = jest.fn().mockResolvedValue(undefined);
    const pause = jest.fn();

    class FakeStrategy {
      constructor(config) {
        this.name = "strategy1Live";
        this.config = config;
        this.state = STRATEGY_STATES.CREATED;
      }

      async initialize() {
        this.state = STRATEGY_STATES.RUNNING;
        return initialize();
      }

      pause() {
        this.state = STRATEGY_STATES.PAUSED;
        pause();
      }

      getState() {
        return this.state;
      }

      stop() {}

      getSymbol() {
        return this.config.parameters.symbol;
      }
    }

    mockGet.mockReturnValue(FakeStrategy);
    mockGetAll.mockReturnValue(
      new Map([
        [
          101,
          {
            instanceId: 101,
            clientId: 1,
            strategyId: 10,
            strategyName: "Strategy 1 Live",
            strategyType: "intraday",
            filePath: "src/strategies/intraday/strategy1Live.js",
            parameters: { symbol: "NIFTY" },
            status: "running",
          },
        ],
        [
          102,
          {
            instanceId: 102,
            clientId: 2,
            strategyId: 11,
            strategyName: "Strategy 1 Live",
            strategyType: "intraday",
            filePath: "src/strategies/intraday/strategy1Live.js",
            parameters: { symbol: "BANKNIFTY" },
            status: "paused",
          },
        ],
      ]),
    );

    const manager = new WorkerManager();
    await manager.initialize();

    expect(mockLoadFromDatabase).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith("INTRADAY_STRATEGY1LIVE");
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(manager.getStatus().strategiesCount).toBe(2);
    expect(pause).toHaveBeenCalledTimes(1);

    await manager.stopAll();
  });

  it("marks a restored paused worker as paused and allows resume", async () => {
    class FakeStrategy {
      constructor(config) {
        this.name = "strategy1Live";
        this.config = config;
        this.state = STRATEGY_STATES.CREATED;
      }

      async initialize() {
        this.state = STRATEGY_STATES.RUNNING;
      }

      pause() {
        this.state = STRATEGY_STATES.PAUSED;
      }

      resume() {
        this.state = STRATEGY_STATES.RUNNING;
      }

      stop() {}

      getState() {
        return this.state;
      }

      getSymbol() {
        return this.config.parameters.symbol;
      }
    }

    mockGet.mockReturnValue(FakeStrategy);
    mockGetAll.mockReturnValue(
      new Map([
        [
          201,
          {
            instanceId: 201,
            clientId: 1,
            strategyId: 10,
            strategyName: "Strategy 1 Live",
            strategyType: "intraday",
            filePath: "src/strategies/intraday/strategy1Live.js",
            parameters: { symbol: "NIFTY" },
            status: "paused",
          },
        ],
      ]),
    );

    const manager = new WorkerManager();
    await manager.initialize();

    const workerId = manager.strategyToWorker.get(201);
    const worker = manager.getWorker(workerId);

    expect(worker.state).toBe(WORKER_STATES.PAUSED);

    manager.resumeWorker(workerId);

    expect(worker.state).toBe(WORKER_STATES.RUNNING);
    expect(worker.getStrategy(201).getState()).toBe(STRATEGY_STATES.RUNNING);

    await manager.stopAll();
  });
});
