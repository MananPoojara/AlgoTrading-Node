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
const { OrderValidator } = require("../../apps/order-manager/src/orderValidator");

describe("OrderValidator", () => {
  beforeEach(() => {
    query.mockReset();
    getSchemaCapability.mockResolvedValue(true);
  });

  it("rejects a signal when the event_id already exists in signals", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 9, status: "processed" }] })
      .mockResolvedValueOnce({ rows: [] });

    const validator = new OrderValidator();
    const result = await validator.validateComplete({
      event_id: "dup_signal_1",
      client_id: 1,
      strategy_instance_id: 1,
      action: "BUY",
      instrument: "NIFTY24APRCE",
      quantity: 1,
      price_type: "MARKET",
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("duplicate_signal");
    expect(result.existingSignalId).toBe(9);
  });

  it("rejects a signal when an active order already exists for the same event_id", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 11, status: "queued" }] });

    const validator = new OrderValidator();
    const result = await validator.validateComplete({
      event_id: "dup_order_1",
      client_id: 1,
      strategy_instance_id: 1,
      action: "BUY",
      instrument: "NIFTY24APRPE",
      quantity: 2,
      price_type: "MARKET",
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("duplicate_order");
    expect(result.existingOrderId).toBe(11);
  });

  it("uses in-memory cache to reject the same event_id twice in one process", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const validator = new OrderValidator();
    const signal = {
      event_id: "cache_hit_1",
      client_id: 1,
      strategy_instance_id: 1,
      action: "BUY",
      instrument: "NIFTY24APRCE",
      quantity: 1,
      price_type: "MARKET",
    };

    const first = await validator.validateComplete(signal);
    const second = await validator.validateComplete(signal);

    expect(first.valid).toBe(true);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe("duplicate_signal");
    expect(second.existingStatus).toBe("in_memory_cache");
  });

  it("rejects a signal when the trigger-bar fingerprint already exists", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 21,
            status: "processed",
            signal_fingerprint:
              "9d9bb68d433e3ef15d3ea3b4d9c9899aa95f1fe6d8bfa77ed4c591be0f07de7d",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const validator = new OrderValidator();
    const result = await validator.validateComplete({
      event_id: "dup_fp_1",
      client_id: 1,
      strategy_instance_id: 3,
      symbol: "NIFTY 50",
      action: "BUY",
      instrument: "NIFTY 50 100 CE",
      quantity: 1,
      price_type: "MARKET",
      trigger_bar_time: "2026-03-20T10:05:00+05:30",
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("duplicate_signal");
    expect(result.existingSignalId).toBe(21);
    expect(result.existingFingerprint).toBeTruthy();
  });

  it("falls back to event_id-only duplicate lookup when extended signal columns are unavailable", async () => {
    getSchemaCapability.mockResolvedValue(false);
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const validator = new OrderValidator();
    const result = await validator.validateComplete({
      event_id: "legacy_signal_only",
      client_id: 1,
      strategy_instance_id: 3,
      symbol: "NIFTY 50",
      action: "BUY",
      instrument: "NIFTY 50 100 CE",
      quantity: 1,
      price_type: "MARKET",
      trigger_bar_time: "2026-03-20T10:05:00+05:30",
    });

    expect(result.valid).toBe(true);
    expect(query).toHaveBeenCalledWith(
      "SELECT id, status, NULL::text AS signal_fingerprint FROM signals WHERE event_id = $1",
      ["legacy_signal_only"],
    );
  });
});
