const path = require("path");

jest.mock("../../packages/core/logger/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  childLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const { StrategyLoader } = require("../../apps/strategy-engine/src/strategyLoader");

describe("StrategyLoader", () => {
  it("loads exported strategy classes from the strategies tree", async () => {
    const loader = new StrategyLoader({
      strategiesPath: path.join(__dirname, "..", "..", "packages", "strategies"),
    });

    await loader.loadAll();

    expect(loader.has("INTRADAY_STRATEGY1LIVE")).toBe(true);
    expect(typeof loader.get("INTRADAY_STRATEGY1LIVE")).toBe("function");
  });
});
