const path = require("path");

jest.mock("../src/core/logger/logger", () => ({
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

const { StrategyLoader } = require("../src/strategyEngine/strategyLoader");

describe("StrategyLoader", () => {
  it("loads exported strategy classes from the strategies tree", async () => {
    const loader = new StrategyLoader({
      strategiesPath: path.join(__dirname, "..", "src", "strategies"),
    });

    await loader.loadAll();

    expect(loader.has("INTRADAY_STRATEGY1LIVE")).toBe(true);
    expect(typeof loader.get("INTRADAY_STRATEGY1LIVE")).toBe("function");
  });
});
