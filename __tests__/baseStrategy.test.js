jest.mock("../src/core/logger/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { BaseStrategy, STRATEGY_STATES } = require("../src/strategies/baseStrategy");

class TestStrategy extends BaseStrategy {
  constructor(config = {}) {
    super(config);
    this.tickCalls = 0;
    this.marketTickCalls = 0;
  }

  async onMarketTick() {
    this.marketTickCalls += 1;
  }

  async onTick() {
    this.tickCalls += 1;
    return null;
  }
}

describe("BaseStrategy cadence routing", () => {
  it("evaluates only on 1-minute close when configured for 1m_close", async () => {
    const strategy = new TestStrategy({
      instanceId: 1,
      clientId: 1,
      strategyId: 1,
      parameters: {
        symbol: "NIFTY 50",
        evaluationMode: "1m_close",
      },
    });
    strategy.state = STRATEGY_STATES.RUNNING;

    await strategy.processTick({ ltp: 100, timestamp: "2026-03-13T09:15:10.000Z" });
    await strategy.processTick({ ltp: 101, timestamp: "2026-03-13T09:15:40.000Z" });
    await strategy.processTick({ ltp: 102, timestamp: "2026-03-13T09:16:00.000Z" });

    expect(strategy.marketTickCalls).toBe(3);
    expect(strategy.tickCalls).toBe(1);
  });

  it("evaluates on every tick when configured for tick mode", async () => {
    const strategy = new TestStrategy({
      instanceId: 1,
      clientId: 1,
      strategyId: 1,
      parameters: {
        symbol: "NIFTY 50",
        evaluationMode: "tick",
      },
    });
    strategy.state = STRATEGY_STATES.RUNNING;

    await strategy.processTick({ ltp: 100, timestamp: "2026-03-13T09:15:10.000Z" });
    await strategy.processTick({ ltp: 101, timestamp: "2026-03-13T09:15:20.000Z" });

    expect(strategy.marketTickCalls).toBe(2);
    expect(strategy.tickCalls).toBe(2);
  });
});
