jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/database/schemaCapabilities", () => ({
  getSchemaCapability: jest.fn(),
  markSchemaCapabilitySupported: jest.fn(),
  markSchemaCapabilityUnsupported: jest.fn(),
}));

const { query } = require("../../packages/database/postgresClient");
const {
  getSchemaCapability,
} = require("../../packages/database/schemaCapabilities");
const {
  loadStrategyRecoveryState,
  persistStrategyRuntimeState,
} = require("../../apps/strategy-engine/src/strategyRuntimeStore");

describe("strategyRuntimeStore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSchemaCapability.mockResolvedValue(true);
  });

  it("persists normalized runtime state onto strategy_instances", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [] });

    await persistStrategyRuntimeState(7, {
      lastEvaluatedBarTime: "2026-03-20T10:05:00+05:30",
      entryContext: { instrument: "NIFTY 50 100 CE" },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE strategy_instances"),
      expect.any(Array),
    );
    const [, params] = query.mock.calls[0];
    expect(params[0]).toBe(7);
    expect(JSON.parse(params[1])).toMatchObject({
      lastEvaluatedBarTime: "2026-03-20T10:05:00+05:30",
      entryContext: { instrument: "NIFTY 50 100 CE" },
    });
  });

  it("skips runtime_state persistence when the column is unavailable", async () => {
    getSchemaCapability.mockResolvedValue(false);

    const persisted = await persistStrategyRuntimeState(7, {
      lastEvaluatedBarTime: "2026-03-20T10:05:00+05:30",
    });

    expect(query).not.toHaveBeenCalled();
    expect(persisted).toMatchObject({
      lastEvaluatedBarTime: "2026-03-20T10:05:00+05:30",
    });
  });

  it("reconstructs an open position and pending exit from database state", async () => {
    getSchemaCapability
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    query
      .mockResolvedValueOnce({
        rows: [
          {
            instrument: "NIFTY 50 100 CE",
            position: 25,
            average_price: 101.5,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: "buy_evt_1",
            instrument: "NIFTY 50 100 CE",
            entry_price: 101.5,
            trigger_bar_time: "2026-03-20T10:05:00+05:30",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: "sell_evt_1",
            instrument: "NIFTY 50 100 CE",
            status: "queued",
            reference_price: 99.5,
            trigger_bar_time: "2026-03-20T15:15:00+05:30",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ instrument_token: "SIM_TOKEN" }],
      });

    const runtimeState = await loadStrategyRecoveryState(7, {
      lastEvaluatedBarTime: "2026-03-20T15:14:00+05:30",
    });

    expect(runtimeState.entryContext).toMatchObject({
      entryDate: "2026-03-20T10:05:00+05:30",
      instrument: "NIFTY 50 100 CE",
      instrumentToken: "SIM_TOKEN",
      entryPrice: 101.5,
    });
    expect(runtimeState.pendingExitContext).toMatchObject({
      eventId: "sell_evt_1",
      instrument: "NIFTY 50 100 CE",
    });
  });

  it("preserves ATR trailingStop inside entryContext across normalization (restart safety)", async () => {
    const { normalizeRuntimeState } = require("../../apps/strategy-engine/src/strategyRuntimeStore");

    const result = normalizeRuntimeState({
      lastEvaluatedBarTime: "2026-03-20T10:05:00+05:30",
      entryContext: {
        entryDate: "2026-03-20T10:05:00+05:30",
        instrument: "NIFTY 50 100 CE",
        instrumentToken: "SIM_TOKEN",
        entryPrice: 101.5,
        trailingStop: 98.25,
      },
    });

    expect(result.entryContext.trailingStop).toBe(98.25);
  });
});
