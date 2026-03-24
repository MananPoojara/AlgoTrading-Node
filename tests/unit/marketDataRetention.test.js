jest.mock("fs", () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  createWriteStream: jest.fn(() => ({
    write: jest.fn(),
    end: jest.fn((callback) => callback()),
  })),
}));

jest.mock("../../packages/core/logger/logger", () => ({
  childLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock("../../packages/database/postgresClient", () => ({
  getClient: jest.fn(),
  query: jest.fn(),
}));

jest.mock("../../packages/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => ({
    publishSystemAlert: jest.fn().mockResolvedValue(true),
  })),
}));

const { getClient } = require("../../packages/database/postgresClient");
const { MarketDataRetentionService } = require("../../packages/automation/marketDataRetention");

describe("MarketDataRetentionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("archives raw ticks, retains 1m candles, and deletes the raw rows in one transaction", async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              instrument_token: "99926000",
              symbol: "NIFTY 50",
              exchange: "NSE",
              ltp: 23000,
              open: 0,
              high: 0,
              low: 0,
              close: 0,
              volume: 10,
              bid: 0,
              ask: 0,
              bid_quantity: 0,
              ask_quantity: 0,
              timestamp: new Date("2026-03-16T09:15:01+05:30"),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: 1 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };
    getClient.mockResolvedValue(client);

    const service = new MarketDataRetentionService({
      archiveRoot: "/tmp/archive",
      archiveBatchSize: 50000,
      publisher: {
        publishSystemAlert: jest.fn().mockResolvedValue(true),
      },
    });

    const result = await service.archiveSourceForTradingDay(
      {
        instrument_token: "99926000",
        symbol: "NIFTY 50",
        exchange: "NSE",
      },
      "2026-03-16",
    );

    expect(result).toMatchObject({
      tradingDay: "2026-03-16",
      archivePath: "data/market-archive/2026-03-16/NIFTY_50.csv",
      rowCount: 1,
      candleCount: 1,
      status: "completed",
    });
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });
});
