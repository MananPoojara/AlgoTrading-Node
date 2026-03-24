jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

const { query } = require("../../packages/database/postgresClient");
const { AngelHistoricalDataClient } = require("../../apps/market-data-service/src/angelHistoricalDataClient");

describe("AngelHistoricalDataClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches one-minute intraday candles for a specific trade date", async () => {
    query.mockResolvedValue({
      rows: [
        {
          exchange: "NSE",
          symbol: "NIFTY 50",
          instrument_token: "99926000",
        },
      ],
    });

    const brokerApi = {
      isConnected: true,
      ensureConnected: jest.fn().mockResolvedValue({ success: true }),
      getCandleData: jest.fn().mockResolvedValue({
        success: true,
        data: [
          ["2026-03-24T09:15:00+05:30", 100, 105, 99, 104, 1000],
          ["2026-03-24T09:16:00+05:30", 104, 106, 103, 105, 1100],
        ],
      }),
    };

    const client = new AngelHistoricalDataClient({ brokerApi });

    const bars = await client.fetchIntradayBarsForSymbol({
      symbol: "NIFTY 50",
      tradeDate: "2026-03-24",
    });

    expect(brokerApi.getCandleData).toHaveBeenCalledWith(
      expect.objectContaining({
        interval: "ONE_MINUTE",
        fromdate: "2026-03-24 09:15",
        todate: "2026-03-24 15:30",
      }),
    );
    expect(bars).toEqual([
      {
        barTime: "2026-03-24T09:15:00+05:30",
        open: 100,
        high: 105,
        low: 99,
        close: 104,
        volume: 1000,
        instrument_token: "99926000",
        symbol: "NIFTY 50",
      },
      {
        barTime: "2026-03-24T09:16:00+05:30",
        open: 104,
        high: 106,
        low: 103,
        close: 105,
        volume: 1100,
        instrument_token: "99926000",
        symbol: "NIFTY 50",
      },
    ]);
  });

  it("chunks historical requests conservatively and merges daily bars", async () => {
    query.mockResolvedValue({
      rows: [
        {
          exchange: "NSE",
          symbol: "NIFTY 50",
          instrument_token: "99926000",
        },
      ],
    });

    const brokerApi = {
      isConnected: true,
      ensureConnected: jest.fn().mockResolvedValue({ success: true }),
      getCandleData: jest
        .fn()
        .mockResolvedValueOnce({
          success: true,
          data: [
            ["2026-01-01T00:00:00+05:30", 100, 105, 99, 104, 1000],
            ["2026-12-31T00:00:00+05:30", 200, 205, 198, 202, 2000],
          ],
        })
        .mockResolvedValueOnce({
          success: true,
          data: [["2027-01-01T00:00:00+05:30", 203, 210, 201, 208, 2100]],
        }),
    };

    const client = new AngelHistoricalDataClient({
      brokerApi,
      now: () => new Date("2027-01-02T12:00:00+05:30").getTime(),
      sleep: jest.fn().mockResolvedValue(undefined),
      maxDaysPerRequest: 365,
    });

    const dailyBars = await client.fetchDailyBarsForSymbol({
      symbol: "NIFTY 50",
      lookbackDays: 367,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM instruments"),
      [["NIFTY 50", "NIFTY"]],
    );
    expect(brokerApi.getCandleData).toHaveBeenCalledTimes(2);
    expect(dailyBars).toEqual([
      {
        date: "2026-01-01",
        open: 100,
        high: 105,
        low: 99,
        close: 104,
      },
      {
        date: "2026-12-31",
        open: 200,
        high: 205,
        low: 198,
        close: 202,
      },
      {
        date: "2027-01-01",
        open: 203,
        high: 210,
        low: 201,
        close: 208,
      },
    ]);
  });

  it("waits when the per-second request limit is already exhausted", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const now = jest
      .fn()
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000)
      .mockReturnValue(1202);
    const client = new AngelHistoricalDataClient({
      brokerApi: {
        isConnected: true,
        ensureConnected: jest.fn().mockResolvedValue({ success: true }),
      },
      sleep,
      now,
      maxRequestsPerSecond: 3,
      maxRequestsPerMinute: 180,
    });

    client.requestTimestamps = [200, 500, 900];

    await client.waitForRateLimitSlot();

    expect(sleep).toHaveBeenCalledWith(201);
  });

  it("retries when Angel responds with too many requests", async () => {
    query.mockResolvedValue({
      rows: [
        {
          exchange: "NSE",
          symbol: "NIFTY 50",
          instrument_token: "99926000",
        },
      ],
    });

    const sleep = jest.fn().mockResolvedValue(undefined);
    const brokerApi = {
      isConnected: true,
      ensureConnected: jest.fn().mockResolvedValue({ success: true }),
      getCandleData: jest
        .fn()
        .mockResolvedValueOnce({
          success: false,
          error: "Too many requests",
          statusCode: 429,
        })
        .mockResolvedValueOnce({
          success: true,
          data: [["2026-03-10T00:00:00+05:30", 100, 105, 99, 104, 1000]],
        }),
    };

    const client = new AngelHistoricalDataClient({
      brokerApi,
      sleep,
      rateLimitRetryDelayMs: 5000,
      maxRetries: 1,
    });

    const dailyBars = await client.fetchDailyBarsForSymbol({
      symbol: "NIFTY 50",
      lookbackDays: 1,
    });

    expect(sleep).toHaveBeenCalledWith(5000);
    expect(brokerApi.getCandleData).toHaveBeenCalledTimes(2);
    expect(dailyBars).toEqual([
      {
        date: "2026-03-10",
        open: 100,
        high: 105,
        low: 99,
        close: 104,
      },
    ]);
  });
});
