jest.mock("../src/core/logger/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../src/strategies/intraday/atmOptionResolver", () => ({
  resolveAtmOptionInstrument: jest.fn().mockResolvedValue({
    instrument: "NIFTY 50 100 CE",
    instrumentToken: "SIM_TOKEN",
    source: "fallback",
  }),
}));

jest.mock("fs", () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(
    () =>
      "Ticker,Date,Open,High,Low,Close\nNIFTY 50,2026-03-10,100,102,99,101\n",
  ),
}));

const { Strategy1Live } = require("../src/strategies/intraday/strategy1Live");

describe("Strategy1Live", () => {
  it("rolls the completed current day into historical bars on date change", async () => {
    const strategy = new Strategy1Live({
      instanceId: 1,
      clientId: 1,
      strategyId: 1,
      parameters: {
        symbol: "NIFTY 50",
      },
    });

    await strategy.initialize();

    strategy.updateCurrentDayBar({
      timestamp: "2026-03-11T09:15:00+05:30",
      ltp: 100,
    });
    strategy.updateCurrentDayBar({
      timestamp: "2026-03-11T15:29:00+05:30",
      ltp: 108,
    });
    strategy.updateCurrentDayBar({
      timestamp: "2026-03-12T09:15:00+05:30",
      ltp: 107,
    });

    expect(strategy.dailyBars.map((bar) => bar.date)).toEqual([
      "2026-03-10",
      "2026-03-11",
    ]);
    expect(strategy.dailyBars[1]).toMatchObject({
      date: "2026-03-11",
      open: 100,
      high: 108,
      low: 100,
      close: 108,
    });
    expect(strategy.currentDayBar).toMatchObject({
      date: "2026-03-12",
      open: 107,
      high: 107,
      low: 107,
      close: 107,
    });
  });

  it("aggregates minute history rows into daily bars", () => {
    const strategy = new Strategy1Live({
      instanceId: 1,
      clientId: 1,
      strategyId: 1,
      parameters: {
        symbol: "NIFTY 50",
      },
    });

    const dailyBars = strategy.aggregateBarsToDaily([
      {
        date: "2026-03-10",
        time: "09:15:00",
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
      },
      {
        date: "2026-03-10",
        time: "09:16:00",
        open: 100.5,
        high: 103,
        low: 100,
        close: 102.5,
      },
      {
        date: "2026-03-10",
        time: "15:29:00",
        open: 102.5,
        high: 104,
        low: 98.5,
        close: 99.25,
      },
      {
        date: "2026-03-11",
        time: "09:15:00",
        open: 98,
        high: 100,
        low: 97.5,
        close: 99.5,
      },
    ]);

    expect(dailyBars).toEqual([
      {
        date: "2026-03-10",
        open: 100,
        high: 104,
        low: 98.5,
        close: 99.25,
      },
      {
        date: "2026-03-11",
        open: 98,
        high: 100,
        low: 97.5,
        close: 99.5,
      },
    ]);
  });
});
