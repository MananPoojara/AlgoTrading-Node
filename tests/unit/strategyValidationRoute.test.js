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
const mockFetchDailyBarsForSymbol = jest.fn();
const mockReplayStrategy1DailyHistory = jest.fn(() => ({
  events: [{ action: "BUY", barTime: "2026-03-24T15:30:00+05:30" }],
  timeline: [{ barTime: "2026-03-24T15:30:00+05:30", close: 104 }],
}));
const mockReplayStrategy1DailyFromMinuteHistory = jest.fn(() => ({
  events: [{ action: "BUY", barTime: "2026-03-24T15:05:00+05:30" }],
  candidate_events: [
    {
      action: "BUY",
      barTime: "2026-03-24T15:05:00+05:30",
      gateReason: "vwap_unavailable",
      blockedByVwap: true,
    },
  ],
  timeline: [{ barTime: "2026-03-24T15:05:00+05:30", close: 104 }],
}));

jest.mock(
  "../../apps/market-data-service/src/angelHistoricalDataClient",
  () => ({
    AngelHistoricalDataClient: jest.fn().mockImplementation(() => ({
      fetchIntradayBarsForSymbol: mockFetchIntradayBarsForSymbol,
      fetchDailyBarsForSymbol: mockFetchDailyBarsForSymbol,
    })),
  }),
);

const mockBuildRecordedSessionBreakdown = jest.fn(
  ({ actualSignals = [], actualOrders = [] }) => ({
    allSignals: actualSignals,
    strategySignals: actualSignals.filter(
      (signal) => signal.metadata?.exit_reason !== "manual_stop",
    ),
    strategyOrders: actualOrders.filter(
      (order) => order.event_id !== "evt_manual",
    ),
    manualOverrides: actualSignals
      .filter((signal) => signal.metadata?.exit_reason === "manual_stop")
      .map((signal) => ({
        id: signal.id,
        event_id: signal.event_id,
        action: signal.action,
        timestamp: signal.trigger_bar_time || signal.timestamp,
        reason: signal.metadata?.exit_reason,
        price: signal.price,
      })),
    operatorTrades: [],
  }),
);

jest.mock("../../packages/strategies/intraday/strategy1Validation", () => ({
  buildRecordedSessionBreakdown: mockBuildRecordedSessionBreakdown,
  buildStrategy1ReplayPerformance: jest.fn(() => ({
    syntheticOrders: [
      {
        side: "LONG",
        entry_date: "2026-02-20T15:30:00+05:30",
        exit_date: "2026-02-21T15:30:00+05:30",
        entry_price: 100,
        exit_price: 108,
        pnl: 8,
        exit_reason: "atr_trailing_exit",
      },
    ],
    equityCurve: [{ barTime: "2026-02-21T15:30:00+05:30", equity: 100008 }],
    stats: {
      totalTrades: 1,
      wins: 1,
      losses: 0,
      winRate: 100,
      grossProfit: 8,
      grossLoss: 0,
      netPnl: 8,
      averagePnlPerTrade: 8,
      maxWin: 8,
      maxLoss: 8,
      startingCapital: 100000,
      endingEquity: 100008,
      maxDrawdown: 0,
      openPositionAtEnd: false,
    },
  })),
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
  buildStrategy1VwapGateSummary: jest.fn(() => ({
    totalDays: 2,
    passedDays: 1,
    blockedDays: 0,
    unavailableDays: 1,
    signalDays: 1,
    days: [
      {
        tradeDate: "2026-02-20",
        vwapGatePassed: true,
        reason: "consecutive_red_entry",
      },
      {
        tradeDate: "2026-02-21",
        vwapGatePassed: false,
        reason: "vwap_unavailable",
      },
    ],
  })),
  replayStrategy1DailyFromMinuteHistory: mockReplayStrategy1DailyFromMinuteHistory,
  replayStrategy1DailyHistory: mockReplayStrategy1DailyHistory,
  replayStrategy1Session: jest.fn(() => ({
    events: [{ action: "BUY", barTime: "2026-03-24T09:15:00+05:30" }],
    timeline: [{ barTime: "2026-03-24T09:15:00+05:30", close: 104 }],
  })),
  toBarTime: jest.fn((value) => String(value)),
  toDailyBarTime: jest.fn(
    (value) => `${String(value).slice(0, 10)}T15:30:00+05:30`,
  ),
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

  it("prefers Angel historical candles when available for session-day validation", async () => {
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
            parameters: {
              symbol: "NIFTY 50",
              maxRed: 3,
              fixedMax: true,
              timeframe: "1min",
            },
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
      .mockResolvedValueOnce({
        rows: [
          {
            id: 11,
            action: "BUY",
            event_id: "evt_1",
            trigger_bar_time: "2026-03-24T09:15:00+05:30",
            metadata: {},
          },
          {
            id: 12,
            action: "SELL",
            event_id: "evt_manual",
            trigger_bar_time: "2026-03-24T09:45:00+05:30",
            metadata: { exit_reason: "manual_stop" },
            price: 101,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 22,
            side: "BUY",
            status: "filled",
            event_id: "evt_1",
            created_at: "2026-03-24T09:15:10+05:30",
          },
          {
            id: 23,
            side: "SELL",
            status: "filled",
            event_id: "evt_manual",
            created_at: "2026-03-24T09:45:10+05:30",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

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
      query: { trade_date: "2026-03-24", mode: "session_day" },
    };
    const res = createResponse();

    await getValidation(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.mode).toBe("session_day");
    expect(res.body.data.candle_source).toEqual(
      expect.objectContaining({
        selected: "angel_historical",
        retained_count: 1,
        historical_count: 2,
      }),
    );
    expect(res.body.data.actual.strategy_signals).toEqual([
      expect.objectContaining({ id: 11, action: "BUY" }),
    ]);
    expect(res.body.data.actual.manual_overrides).toEqual([
      expect.objectContaining({
        event_id: "evt_manual",
        reason: "manual_stop",
      }),
    ]);
    expect(res.body.data.actual.operator_activity).toEqual([]);
    expect(mockBuildRecordedSessionBreakdown).toHaveBeenCalled();
    expect(mockFetchIntradayBarsForSymbol).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "NIFTY 50",
        tradeDate: "2026-03-24",
      }),
    );
  });

  it("falls back to retained minute-backed daily validation when Angel daily history is too sparse", async () => {
    query.mockImplementation((sql, params = []) => {
      if (sql.includes("FROM strategy_instances si")) {
        return Promise.resolve({
          rows: [
            {
              id: 9,
              strategy_id: 6,
              strategy_name: "STRATEGY1_LIVE",
              strategy_type: "intraday",
              client_name: "Founder",
              status: "running",
              parameters: {
                symbol: "NIFTY 50",
                maxRed: 3,
                fixedMax: true,
                timeframe: "1day",
                capital: 100000,
              },
              strategy_parameters: {},
              risk_limits: { capital: 100000 },
              runtime_state: {},
            },
          ],
        });
      }

      if (sql.includes("FROM market_ohlc_1m") && sql.includes("trading_day >=")) {
        return Promise.resolve({
          rows: [
            {
              trading_day: "2026-02-20",
              candle_time: "2026-02-20T09:15:00+05:30",
              open: 90,
              high: 91,
              low: 89,
              close: 90,
              volume: 100,
              symbol: "NIFTY 50",
            },
            {
              trading_day: "2026-02-20",
              candle_time: "2026-02-20T15:00:00+05:30",
              open: 90,
              high: 91,
              low: 88,
              close: 89,
              volume: 1000,
              symbol: "NIFTY 50",
            },
            {
              trading_day: "2026-02-21",
              candle_time: "2026-02-21T09:15:00+05:30",
              open: 89,
              high: 90,
              low: 88,
              close: 89,
              volume: 100,
              symbol: "NIFTY 50",
            },
            {
              trading_day: "2026-02-21",
              candle_time: "2026-02-21T15:00:00+05:30",
              open: 89,
              high: 90,
              low: 87,
              close: 88,
              volume: 1000,
              symbol: "NIFTY 50",
            },
          ],
        });
      }

      if (sql.includes("FROM market_ohlc_1m") && sql.includes("trading_day = $1::date")) {
        const tradeDate = params[0];
        const rowsByDate = {
          "2026-02-20": [
            {
              candle_time: "2026-02-20T09:15:00+05:30",
              open: 90,
              high: 91,
              low: 89,
              close: 90,
              volume: 100,
              instrument_token: "99926000",
              symbol: "NIFTY 50",
            },
            {
              candle_time: "2026-02-20T15:00:00+05:30",
              open: 90,
              high: 91,
              low: 88,
              close: 89,
              volume: 1000,
              instrument_token: "99926000",
              symbol: "NIFTY 50",
            },
          ],
          "2026-02-21": [
            {
              candle_time: "2026-02-21T09:15:00+05:30",
              open: 89,
              high: 90,
              low: 88,
              close: 89,
              volume: 100,
              instrument_token: "99926000",
              symbol: "NIFTY 50",
            },
            {
              candle_time: "2026-02-21T15:00:00+05:30",
              open: 89,
              high: 90,
              low: 87,
              close: 88,
              volume: 1000,
              instrument_token: "99926000",
              symbol: "NIFTY 50",
            },
          ],
        };
        return Promise.resolve({ rows: rowsByDate[tradeDate] || [] });
      }

      if (sql.includes("FROM positions")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM orders")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM operator_audit_log")) {
        return Promise.resolve({ rows: [] });
      }

      throw new Error(`Unexpected query in retained-daily test: ${sql}`);
    });

    mockFetchDailyBarsForSymbol.mockResolvedValue([
      { date: "2026-02-20", open: 90, high: 91, low: 88, close: 89 },
    ]);
    mockFetchIntradayBarsForSymbol.mockResolvedValue([]);

    const req = {
      params: { id: "9" },
      query: { mode: "daily_30d" },
    };
    const res = createResponse();

    await getValidation(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.candle_source).toEqual(
      expect.objectContaining({
        selected: "market_ohlc_1m_intraday",
        daily_source: "market_ohlc_1m_daily",
        minute_days_requested: 2,
        minute_days_loaded: 2,
      }),
    );
    expect(res.body.data.notes).toContain(
      "Replay reconstructed from per-day 1-minute candles",
    );
  });

  it("builds minute-backed daily validation from Angel intraday history and exposes a default session date", async () => {
    query.mockImplementation((sql, params = []) => {
      if (sql.includes("FROM strategy_instances si")) {
        return Promise.resolve({
          rows: [
            {
              id: 9,
              strategy_id: 6,
              strategy_name: "STRATEGY1_LIVE",
              strategy_type: "intraday",
              client_name: "Founder",
              status: "running",
              parameters: {
                symbol: "NIFTY 50",
                maxRed: 3,
                fixedMax: true,
                timeframe: "1day",
                capital: 100000,
              },
              strategy_parameters: {},
              risk_limits: { capital: 100000 },
              runtime_state: {},
            },
          ],
        });
      }

      if (sql.includes("FROM market_ohlc_1m") && sql.includes("trading_day >=")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM market_ohlc_1m") && sql.includes("trading_day = $1::date")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM positions")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM orders")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM operator_audit_log")) {
        return Promise.resolve({ rows: [] });
      }

      throw new Error(`Unexpected query in historical-daily test: ${sql}`);
    });

    mockFetchDailyBarsForSymbol.mockResolvedValue([
      { date: "2026-02-20", open: 90, high: 91, low: 88, close: 89 },
      { date: "2026-02-21", open: 89, high: 90, low: 87, close: 88 },
    ]);
    mockFetchIntradayBarsForSymbol.mockImplementation(async ({ tradeDate }) => {
      const rowsByDate = {
        "2026-02-20": [
          {
            barTime: "2026-02-20T09:15:00+05:30",
            open: 90,
            high: 91,
            low: 89,
            close: 90,
            volume: 100,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
          {
            barTime: "2026-02-20T15:00:00+05:30",
            open: 90,
            high: 91,
            low: 88,
            close: 89,
            volume: 1000,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
        ],
        "2026-02-21": [
          {
            barTime: "2026-02-21T09:15:00+05:30",
            open: 89,
            high: 90,
            low: 88,
            close: 89,
            volume: 100,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
          {
            barTime: "2026-02-21T15:00:00+05:30",
            open: 89,
            high: 90,
            low: 87,
            close: 88,
            volume: 1000,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
        ],
      };
      return rowsByDate[tradeDate] || [];
    });

    const req = {
      params: { id: "9" },
      query: { mode: "daily_30d" },
    };
    const res = createResponse();

    await getValidation(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.mode).toBe("daily_30d");
    expect(res.body.data.candle_source).toEqual(
      expect.objectContaining({
        selected: "angel_historical_intraday",
        daily_source: "angel_historical_daily",
        minute_days_historical: 2,
      }),
    );
    expect(res.body.data.candles[0]).toEqual(
      expect.objectContaining({
        date: "2026-02-20",
      }),
    );
    expect(res.body.data.default_session_date).toBe("2026-03-24");
    expect(res.body.data.replay).toEqual(
      expect.objectContaining({
        candidate_events: expect.any(Array),
        synthetic_orders: expect.any(Array),
        equity_curve: expect.any(Array),
        stats: expect.objectContaining({ netPnl: 8, endingEquity: 100008 }),
        vwap_gate_summary: expect.objectContaining({
          totalDays: 2,
          unavailableDays: 1,
        }),
      }),
    );
    expect(res.body.data.candle_source).toEqual(
      expect.objectContaining({
        source_quality: "complete",
        days_with_missing_volume: [],
        days_with_missing_candles: [],
        vwap_available_days: ["2026-02-20", "2026-02-21"],
      }),
    );
    expect(mockFetchDailyBarsForSymbol).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "NIFTY 50" }),
    );
    expect(mockReplayStrategy1DailyFromMinuteHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "NIFTY 50",
        fixedMax: true,
        maxRed: 3,
      }),
    );
  });

  it("surfaces missing minute-day diagnostics when daily replay cannot rebuild every requested session", async () => {
    query.mockImplementation((sql, params = []) => {
      if (sql.includes("FROM strategy_instances si")) {
        return Promise.resolve({
          rows: [
            {
              id: 9,
              strategy_id: 6,
              strategy_name: "STRATEGY1_LIVE",
              strategy_type: "intraday",
              client_name: "Founder",
              status: "running",
              parameters: {
                symbol: "NIFTY 50",
                maxRed: 3,
                fixedMax: true,
                timeframe: "1day",
                capital: 100000,
              },
              strategy_parameters: {},
              risk_limits: { capital: 100000 },
              runtime_state: {},
            },
          ],
        });
      }

      if (sql.includes("FROM market_ohlc_1m") && sql.includes("trading_day >=")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM market_ohlc_1m") && sql.includes("trading_day = $1::date")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM positions")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM orders")) {
        return Promise.resolve({ rows: [] });
      }

      if (sql.includes("FROM operator_audit_log")) {
        return Promise.resolve({ rows: [] });
      }

      throw new Error(`Unexpected query in partial-minute test: ${sql}`);
    });

    mockFetchDailyBarsForSymbol.mockResolvedValue([
      { date: "2026-02-20", open: 90, high: 91, low: 88, close: 89 },
      { date: "2026-02-21", open: 89, high: 90, low: 87, close: 88 },
      { date: "2026-02-24", open: 88, high: 89, low: 86, close: 87 },
    ]);
    mockFetchIntradayBarsForSymbol.mockImplementation(async ({ tradeDate }) => {
      const rowsByDate = {
        "2026-02-20": [
          {
            barTime: "2026-02-20T09:15:00+05:30",
            open: 90,
            high: 91,
            low: 89,
            close: 90,
            volume: 100,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
          {
            barTime: "2026-02-20T15:00:00+05:30",
            open: 90,
            high: 91,
            low: 88,
            close: 89,
            volume: 1000,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
        ],
        "2026-02-21": [
          {
            barTime: "2026-02-21T09:15:00+05:30",
            open: 89,
            high: 90,
            low: 88,
            close: 89,
            volume: 0,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
          {
            barTime: "2026-02-21T15:00:00+05:30",
            open: 89,
            high: 90,
            low: 87,
            close: 88,
            volume: 0,
            instrument_token: "99926000",
            symbol: "NIFTY 50",
          },
        ],
        "2026-02-24": [],
      };
      return rowsByDate[tradeDate] || [];
    });

    const req = {
      params: { id: "9" },
      query: { mode: "daily_30d" },
    };
    const res = createResponse();

    await getValidation(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.candle_source).toEqual(
      expect.objectContaining({
        minute_days_requested: 3,
        minute_days_loaded: 2,
        source_quality: "partial",
        days_with_missing_candles: ["2026-02-24"],
        days_with_missing_volume: ["2026-02-21"],
        vwap_available_days: ["2026-02-20"],
      }),
    );
  });
});
