jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/database/schemaCapabilities", () => ({
  getSchemaCapability: jest.fn(),
  markSchemaCapabilitySupported: jest.fn(),
  markSchemaCapabilityUnsupported: jest.fn(),
}));

jest.mock("../../apps/risk-manager/src/marginCalculator", () => ({
  getMarginCalculator: jest.fn(() => ({})),
}));

jest.mock("../../apps/risk-manager/src/circuitBreaker", () => ({
  getCircuitBreaker: jest.fn(() => ({})),
}));

jest.mock("../../apps/risk-manager/src/riskManager", () => ({
  RiskManager: jest.fn().mockImplementation(() => ({
    loadFromDatabase: jest.fn().mockResolvedValue(undefined),
  })),
}));

const { query } = require("../../packages/database/postgresClient");
const {
  getSchemaCapability,
} = require("../../packages/database/schemaCapabilities");
const { OrderManager } = require("../../apps/order-manager/src/orderManager");

describe("OrderManager legacy signal schema fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSchemaCapability.mockResolvedValue(true);
  });

  it("records a signal with the legacy insert when trigger_bar_time columns do not exist", async () => {
    const missingColumnError = new Error("column trigger_bar_time does not exist");
    missingColumnError.code = "42703";

    query
      .mockRejectedValueOnce(missingColumnError)
      .mockResolvedValueOnce({
        rows: [{ id: 101, status: "pending", event_id: "sig_legacy_1" }],
      });

    const manager = new OrderManager();
    const signalRecord = await manager.recordSignal(
      {
        event_id: "sig_legacy_1",
        client_id: 1,
        strategy_id: 6,
        strategy_instance_id: 7,
        symbol: "NIFTY 50",
        instrument: "NIFTY 50 23250 CE",
        action: "BUY",
        quantity: 25,
        price_type: "MARKET",
        price: 100,
        trigger_bar_time: "2026-03-20T10:05:00+05:30",
      },
      "pending",
    );

    expect(signalRecord).toMatchObject({
      id: 101,
      status: "pending",
      event_id: "sig_legacy_1",
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("uses the legacy insert directly when extended signal columns are known to be unavailable", async () => {
    getSchemaCapability.mockResolvedValue(false);
    query.mockResolvedValueOnce({
      rows: [{ id: 102, status: "pending", event_id: "sig_legacy_2" }],
    });

    const manager = new OrderManager();
    const signalRecord = await manager.recordSignal(
      {
        event_id: "sig_legacy_2",
        client_id: 1,
        strategy_id: 6,
        strategy_instance_id: 7,
        symbol: "NIFTY 50",
        instrument: "NIFTY 50 23250 CE",
        action: "BUY",
        quantity: 25,
        price_type: "MARKET",
        price: 100,
      },
      "pending",
    );

    expect(signalRecord).toMatchObject({
      id: 102,
      status: "pending",
      event_id: "sig_legacy_2",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("INSERT INTO signals");
    expect(query.mock.calls[0][0]).not.toContain("trigger_bar_time");
  });
});
