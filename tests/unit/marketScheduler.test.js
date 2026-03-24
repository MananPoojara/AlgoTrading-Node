jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
  close: jest.fn(),
}));

const { query } = require("../../packages/database/postgresClient");
const { MarketScheduler } = require("../../packages/automation/marketScheduler");

describe("MarketScheduler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockImplementation((sql) => {
      if (sql.includes("SELECT state_value")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("COUNT(*) AS open_positions")) {
        return Promise.resolve({ rows: [{ open_positions: 0 }] });
      }

      if (sql.includes("INSERT INTO scheduler_state")) {
        return Promise.resolve({ rowCount: 1, rows: [] });
      }

      if (sql.includes("UPDATE strategy_instances")) {
        return Promise.resolve({ rowCount: 2, rows: [] });
      }

      return Promise.resolve({ rows: [] });
    });
  });

  it("starts feed and resumes scheduler-paused strategies during the active window", async () => {
    const publisher = {
      publishMarketDataControl: jest.fn().mockResolvedValue(true),
      publishStrategyControl: jest.fn().mockResolvedValue(true),
      publishSystemAlert: jest.fn().mockResolvedValue(true),
    };

    const scheduler = new MarketScheduler({
      publisher,
      retentionService: {
        runForTradingDay: jest.fn().mockResolvedValue([]),
      },
      schedule: {
        enabled: true,
        pollMs: 30000,
        feedStart: "09:00",
        strategyStart: "09:15",
        squareOff: "15:15",
        strategyPause: "15:45",
        feedStop: "16:10",
      },
      now: () => new Date("2026-03-16T03:50:00.000Z"),
    });

    await scheduler.runCycle();

    expect(publisher.publishMarketDataControl).toHaveBeenCalledWith({
      command: "start_feed",
    });
    expect(publisher.publishStrategyControl).toHaveBeenCalledWith({
      command: "resume_all_strategies",
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE strategy_instances"));
  });

  it("stops feed, pauses strategies, and runs retention after the close window", async () => {
    const publisher = {
      publishMarketDataControl: jest.fn().mockResolvedValue(true),
      publishStrategyControl: jest.fn().mockResolvedValue(true),
      publishSystemAlert: jest.fn().mockResolvedValue(true),
    };
    const retentionService = {
      runForTradingDay: jest.fn().mockResolvedValue([{ symbol: "NIFTY 50" }]),
    };

    const scheduler = new MarketScheduler({
      publisher,
      retentionService,
      schedule: {
        enabled: true,
        pollMs: 30000,
        feedStart: "09:00",
        strategyStart: "09:15",
        squareOff: "15:15",
        strategyPause: "15:45",
        feedStop: "16:10",
      },
      now: () => new Date("2026-03-16T10:50:00.000Z"),
    });

    await scheduler.runCycle();

    expect(publisher.publishMarketDataControl).toHaveBeenCalledWith({
      command: "stop_feed",
    });
    expect(publisher.publishStrategyControl).toHaveBeenCalledWith({
      command: "pause_all_strategies",
    });
    expect(retentionService.runForTradingDay).toHaveBeenCalledWith("2026-03-16");
  });

  it("squares off strategies at the configured square-off time before feed stop", async () => {
    const publisher = {
      publishMarketDataControl: jest.fn().mockResolvedValue(true),
      publishStrategyControl: jest.fn().mockResolvedValue(true),
      publishSystemAlert: jest.fn().mockResolvedValue(true),
    };

    const scheduler = new MarketScheduler({
      publisher,
      retentionService: {
        runForTradingDay: jest.fn().mockResolvedValue([]),
      },
      schedule: {
        enabled: true,
        pollMs: 30000,
        feedStart: "09:00",
        strategyStart: "09:15",
        squareOff: "15:15",
        strategyPause: "15:45",
        feedStop: "16:10",
      },
      now: () => new Date("2026-03-16T09:50:00.000Z"),
    });

    await scheduler.runCycle();

    expect(publisher.publishStrategyControl).toHaveBeenCalledWith({
      command: "square_off_all_strategies",
      reason: "intraday_square_off",
    });
  });

  it("raises a critical alert if auto-managed positions remain open 10 minutes after square-off", async () => {
    query.mockImplementation((sql) => {
      if (sql.includes("SELECT state_value")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("COUNT(*) AS open_positions")) {
        return Promise.resolve({ rows: [{ open_positions: 2 }] });
      }

      if (sql.includes("INSERT INTO scheduler_state")) {
        return Promise.resolve({ rowCount: 1, rows: [] });
      }

      if (sql.includes("UPDATE strategy_instances")) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      return Promise.resolve({ rows: [] });
    });

    const publisher = {
      publishMarketDataControl: jest.fn().mockResolvedValue(true),
      publishStrategyControl: jest.fn().mockResolvedValue(true),
      publishSystemAlert: jest.fn().mockResolvedValue(true),
    };

    const scheduler = new MarketScheduler({
      publisher,
      retentionService: {
        runForTradingDay: jest.fn().mockResolvedValue([]),
      },
      schedule: {
        enabled: true,
        pollMs: 30000,
        feedStart: "09:00",
        strategyStart: "09:15",
        squareOff: "15:15",
        strategyPause: "15:45",
        feedStop: "16:10",
      },
      now: () => new Date("2026-03-16T09:56:00.000Z"),
    });

    await scheduler.runCycle();

    expect(publisher.publishSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "CRITICAL",
        open_positions: 2,
        threshold_time: "15:25",
      }),
    );
  });
});
