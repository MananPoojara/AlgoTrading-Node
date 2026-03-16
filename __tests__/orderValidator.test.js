jest.mock("../src/database/postgresClient", () => ({
  query: jest.fn(),
}));

const { query } = require("../src/database/postgresClient");
const { OrderValidator } = require("../src/execution/orderManager/orderValidator");

describe("OrderValidator", () => {
  beforeEach(() => {
    query.mockReset();
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
});
