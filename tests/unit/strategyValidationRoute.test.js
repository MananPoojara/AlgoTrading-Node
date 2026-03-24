jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/core/logger/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../apps/strategy-engine/src/workerManager", () => ({
  getWorkerManager: jest.fn(),
}));

const mockFetchIntradayBarsForSymbol = jest.fn();

jest.mock("../../apps/market-data-service/src/angelHistoricalDataClient", () => ({
  AngelHistoricalDataClient: jest.fn().mockImplementation(() => ({
    fetchIntradayBarsForSymbol: mockFetchIntradayBarsForSymbol,
  })),
}));

jest.mock("../../packages/strategies/intraday/strategy1Validation", () => ({
  compareStrategy1Session: jest.fn(() => ({
    verdict: "PASS",
    summary: {
      replaySignals: 1,
      actualSignals: 1,
      actualOrders: 1,
      matchedSignals: 1,
      missingSignals: 0,
      extraSignals: 0,
      missingOrders: 0,
      failedOrders: 0,
      extraOrders: 0,
    },
    mismatches: [],
  })),
  inspectCandleContinuity: jest.fn((candles = []) => ({
    count: candles.length,
    gapCount: 0,
    totalMissingMinutes: 0,
    gaps: [],
    firstBarTime: candles[0]?.barTime || null,
    lastBarTime: candles[candles.length - 1]?.barTime || null,
  })),
  isValidationWindowOpen: jest.fn(() => true),
  replayStrategy1Session: jest.fn(() => ({
    events: [{ action: "BUY", barTime: "2026-03-24T09:15:00+05:30" }],
    timeline: [],
  })),
  toBarTime: jest.fn((value) => String(value)),
}));

const { query } = require("../../packages/database/postgresClient");
const router = require("../../apps/api/src/routes/strategies");

function getRouteHandler(method, path) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method],
  );

  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  return layer.route.stack[0].handle;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("strategy validation route", () => {
  const getValidation = getRouteHandler("get", "/instances/:id/validation");

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("prefers Angel historical candles when available", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 9,
            strategy_id: 6,
            strategy_name: "STRATEGY1_LIVE",
            strategy_type: "intraday",
            client_name: "Founder",
            status: "running",
            parameters: { symbol: "NIFTY 50", maxRed: 3, fixedMax: true },
            strategy_parameters: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            candle_time: "2026-03-24T09:15:00+05:30",
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 11, action: "BUY", event_id: "evt_1", trigger_bar_time: "2026-03-24T09:15:00+05:30" }] })
      .mockResolvedValueOnce({ rows: [{ id: 22, side: "BUY", status: "filled", event_id: "evt_1", created_at: "2026-03-24T09:15:10+05:30" }] });

    mockFetchIntradayBarsForSymbol.mockResolvedValue([
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

    const req = {
      params: { id: "9" },
      query: { trade_date: "2026-03-24" },
    };
    const res = createResponse();

    await getValidation(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.candle_source).toEqual(
      expect.objectContaining({
        selected: "angel_historical",
        retained_count: 1,
        historical_count: 2,
      }),
    );
    expect(res.body.data.candles).toHaveLength(2);
    expect(mockFetchIntradayBarsForSymbol).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "NIFTY 50",
        tradeDate: "2026-03-24",
      }),
    );
  });
});
