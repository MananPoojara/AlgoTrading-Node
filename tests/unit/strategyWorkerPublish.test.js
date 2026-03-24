jest.mock("../../packages/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => ({
    publishWorkerHeartbeat: jest.fn().mockResolvedValue(true),
    publishStrategySignal: jest.fn().mockResolvedValue(true),
  })),
}));

const { getPublisher } = require("../../packages/core/eventBus/publisher");
const { StrategyWorker, WORKER_STATES } = require("../../apps/strategy-engine/src/workerManager");
const { STRATEGY_STATES } = require("../../packages/strategies/baseStrategy");

describe("StrategyWorker signal publishing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("publishes a strategy signal only once when onSignal and return value are both used", async () => {
    const publisher = getPublisher();
    const worker = new StrategyWorker({ id: "worker_test", group: "test" });
    worker.publisher = publisher;
    worker.state = WORKER_STATES.RUNNING;

    const signal = {
      event_id: "sig_123",
      action: "BUY",
      instrument: "NIFTY24MAR23500CE",
    };

    const strategy = {
      name: "STRATEGY1_LIVE",
      instanceId: 101,
      onSignal: null,
      processTick: jest.fn(async function processTick() {
        await this.onSignal(signal);
        return signal;
      }),
      getSymbol: jest.fn(() => "NIFTY 50"),
      getState: jest.fn(() => STRATEGY_STATES.RUNNING),
      stop: jest.fn(),
    };

    worker.registerStrategy(101, strategy);

    await worker.handleTick({ symbol: "NIFTY 50", ltp: 23512 });

    expect(publisher.publishStrategySignal).toHaveBeenCalledTimes(1);
    expect(publisher.publishStrategySignal).toHaveBeenCalledWith(signal);
  });

  it("restores registered strategy runtime state through the worker hook", async () => {
    const worker = new StrategyWorker({ id: "worker_test", group: "test" });
    const restoredState = {
      lastEvaluatedBarTime: "2026-03-23T09:20:00.000Z",
      pendingEntryContext: { eventId: "sig_123" },
    };

    const strategy = {
      name: "STRATEGY1_LIVE",
      instanceId: 101,
      processTick: jest.fn(),
      getSymbol: jest.fn(() => "NIFTY 50"),
      getState: jest.fn(() => STRATEGY_STATES.CREATED),
      restoreRuntimeState: jest.fn(function restoreRuntimeState(runtimeState) {
        this.appliedRuntimeState = runtimeState;
      }),
      stop: jest.fn(),
    };

    worker.registerStrategy(101, strategy);

    await worker.restoreState(101, restoredState);

    expect(strategy.runtimeState).toEqual(restoredState);
    expect(strategy.restoreRuntimeState).toHaveBeenCalledWith(restoredState);
    expect(strategy.appliedRuntimeState).toEqual(restoredState);
  });

  it("routes execution updates back to the registered strategy instance", () => {
    const worker = new StrategyWorker({ id: "worker_test", group: "test" });
    const handleExecutionUpdate = jest.fn();

    const strategy = {
      name: "STRATEGY1_LIVE",
      instanceId: 101,
      processTick: jest.fn(),
      getSymbol: jest.fn(() => "NIFTY 50"),
      getState: jest.fn(() => STRATEGY_STATES.RUNNING),
      handleExecutionUpdate,
      stop: jest.fn(),
    };

    worker.registerStrategy(101, strategy);

    worker.handleExecutionUpdate({
      strategy_instance_id: 101,
      event_id: "sig_123",
      side: "BUY",
      status: "filled",
    });

    expect(handleExecutionUpdate).toHaveBeenCalledWith({
      strategy_instance_id: 101,
      event_id: "sig_123",
      side: "BUY",
      status: "filled",
    });
  });
});
