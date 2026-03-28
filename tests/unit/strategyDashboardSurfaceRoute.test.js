jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/core/logger/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  childLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("../../apps/strategy-engine/src/workerManager", () => ({
  getWorkerManager: jest.fn(),
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

describe("strategy dashboard surface route", () => {
  const getDashboardSurface = getRouteHandler(
    "get",
    "/instances/:id/dashboard-surface",
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a unified Strategy1 dashboard payload with VWAP and restart visibility", async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes("FROM strategy_instances si") && sql.includes("WHERE si.id = $1")) {
        return {
          rows: [
            {
              id: 7,
              strategy_id: 11,
              strategy_name: "STRATEGY1_LIVE",
              strategy_type: "intraday",
              client_id: 5,
              client_name: "Paper Client",
              status: "running",
              worker_id: "worker_7",
              parameters: { symbol: "NIFTY 50", timeframe: "1day", quantity: 25 },
              strategy_parameters: { symbol: "NIFTY 50" },
              risk_limits: { capital: 100000 },
              runtime_state: {
                lastEvaluation: {
                  action: "BUY",
                  reason: "consecutive_red_entry",
                  evaluationTimeframe: "1min",
                  tradeDate: "2026-03-27T15:02:00+05:30",
                  decisionPrice: 22920,
                  vwap: 22900,
                  vwapGatePassed: true,
                },
                pendingEntryContext: null,
                pendingExitContext: null,
                entryContext: {
                  instrument: "NIFTY27MAR22900CE",
                  trailingStop: 22840,
                },
              },
            },
          ],
        };
      }

      if (sql.includes("SELECT instrument_token, symbol") && sql.includes("FROM instruments")) {
        return {
          rows: [{ instrument_token: "99926000", symbol: "NIFTY 50" }],
        };
      }

      if (sql.includes("SELECT candle_time AS time, open, high, low, close, volume")) {
        return {
          rows: [
            { time: "2026-03-27T09:15:00+05:30", open: 22890, high: 22900, low: 22880, close: 22895, volume: 1000 },
            { time: "2026-03-27T09:16:00+05:30", open: 22895, high: 22925, low: 22892, close: 22920, volume: 1200 },
          ],
        };
      }

      if (sql.includes("FROM signals") && sql.includes("ORDER BY timestamp DESC")) {
        return {
          rows: [
            {
              id: 41,
              event_id: "sig_41",
              strategy_instance_id: 7,
              action: "BUY",
              symbol: "NIFTY 50",
              instrument: "NIFTY27MAR22900CE",
              price: 22920,
              timestamp: "2026-03-27T09:16:00Z",
              reason: "consecutive_red_entry",
            },
          ],
        };
      }

      if (sql.includes("FROM orders") && sql.includes("ORDER BY COALESCE(updated_at, created_at) DESC")) {
        return {
          rows: [
            {
              id: 99,
              strategy_instance_id: 7,
              side: "BUY",
              instrument: "NIFTY27MAR22900CE",
              quantity: 25,
              status: "filled",
              average_fill_price: 111.5,
              created_at: "2026-03-27T09:16:05Z",
              updated_at: "2026-03-27T09:16:08Z",
            },
          ],
        };
      }

      if (sql.includes("FROM signals") && sql.includes("COALESCE(trigger_bar_time, timestamp)")) {
        return {
          rows: [
            {
              id: 41,
              event_id: "sig_41",
              strategy_instance_id: 7,
              action: "BUY",
              symbol: "NIFTY 50",
              instrument: "NIFTY27MAR22900CE",
              price: 22920,
              timestamp: "2026-03-27T09:16:00Z",
              trigger_bar_time: "2026-03-27T09:16:00+05:30",
              reason: "consecutive_red_entry",
            },
          ],
        };
      }

      if (sql.includes("FROM orders") && sql.includes("(created_at AT TIME ZONE 'Asia/Kolkata')::date")) {
        return {
          rows: [
            {
              id: 99,
              strategy_instance_id: 7,
              event_id: "sig_41",
              side: "BUY",
              instrument: "NIFTY27MAR22900CE",
              quantity: 25,
              status: "filled",
              average_fill_price: 111.5,
              created_at: "2026-03-27T09:16:05Z",
            },
          ],
        };
      }

      if (sql.includes("action = 'strategy_manual_position_correction'")) {
        return {
          rows: [
            {
              id: 501,
              timestamp: "2026-03-27T10:15:00Z",
              operator_username: "ops-user",
              metadata: {
                instrument: "NIFTY27MAR22900CE",
                corrected_quantity: 25,
                previous_quantity: 0,
                corrected_average_price: 112.25,
                reason: "manual_sync",
              },
            },
          ],
        };
      }

      if (sql.includes("FROM positions") && sql.includes("quantity <> 0")) {
        return {
          rows: [
            {
              id: 301,
              strategy_instance_id: 7,
              instrument: "NIFTY27MAR22900CE",
              quantity: 25,
              avg_entry_price: 111.5,
              updated_at: "2026-03-27T09:16:10Z",
            },
          ],
        };
      }

      if (sql.includes("SELECT id, event_id, side, status, instrument, quantity")) {
        return { rows: [] };
      }

      throw new Error(`Unhandled SQL in test: ${sql}`);
    });

    const req = {
      params: { id: "7" },
      query: { limit: "120" },
    };
    const res = createResponse();

    await getDashboardSurface(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.strategy.timeframe).toBe("1day");
    expect(res.body.data.strategy.running_timeframe).toBe("1min");
    expect(res.body.data.strategy.pending_restart).toBe(true);
    expect(res.body.data.chart.candles).toHaveLength(2);
    expect(res.body.data.chart.vwap_series).toHaveLength(2);
    expect(res.body.data.chart.markers.map((row) => row.kind)).toEqual(
      expect.arrayContaining(["signal", "strategy_order", "manual_correction"]),
    );
    expect(res.body.data.position_mismatch.has_mismatch).toBe(false);
    expect(res.body.data.manual_corrections).toHaveLength(1);
  });
});
