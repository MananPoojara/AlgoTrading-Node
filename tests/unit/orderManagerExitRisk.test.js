jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/core/eventBus/subscriber", () => ({
  getSubscriber: jest.fn(() => ({
    subscribe: jest.fn().mockResolvedValue(true),
    subscribeToStrategySignals: jest.fn().mockResolvedValue(true),
    subscribeToMarketTicks: jest.fn().mockResolvedValue(true),
    subscribeToOperatorActions: jest.fn().mockResolvedValue(true),
  })),
  CHANNELS: {},
}));

jest.mock("../../packages/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => ({
    publishOrderRequest: jest.fn().mockResolvedValue(true),
    publish: jest.fn().mockResolvedValue(true),
  })),
  CHANNELS: {},
}));

jest.mock("../../apps/risk-manager/src/marginCalculator", () => ({
  getMarginCalculator: jest.fn(() => ({})),
}));

jest.mock("../../apps/risk-manager/src/circuitBreaker", () => ({
  getCircuitBreaker: jest.fn(() => ({})),
}));

const mockRiskManager = {
  loadFromDatabase: jest.fn().mockResolvedValue(undefined),
  checkSignal: jest.fn(),
  onOrderPlaced: jest.fn(),
  onOrderFilled: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../../apps/risk-manager/src/riskManager", () => ({
  RiskManager: jest.fn().mockImplementation(() => mockRiskManager),
}));

const { query } = require("../../packages/database/postgresClient");
const { OrderManager } = require("../../apps/order-manager/src/orderManager");

describe("OrderManager exit risk handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
  });

  function createManager() {
    const manager = new OrderManager();
    manager.validator.validateComplete = jest.fn().mockResolvedValue({ valid: true });
    manager.recordSignal = jest.fn().mockResolvedValue({ id: 101, status: "pending" });
    manager.createOrder = jest.fn().mockResolvedValue({
      id: 501,
      client_id: 1,
      strategy_instance_id: 7,
      event_id: "evt_1",
      symbol: "NIFTY 50",
      instrument: "NIFTY24MAR23600CE",
      side: "SELL",
      quantity: 25,
      price: 100,
      price_type: "MARKET",
      status: "created",
    });
    manager.transitionOrderState = jest.fn().mockResolvedValue(true);
    manager.publishOrderRequest = jest.fn().mockResolvedValue(true);
    return manager;
  }

  it("allows a risk-reducing SELL through even when circuit breaker is active", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ position: 25 }] })
      .mockResolvedValueOnce({ rows: [{ queued_buy_quantity: 0 }] });
    mockRiskManager.checkSignal.mockResolvedValue({ allowed: true });

    const manager = createManager();

    const result = await manager.handleSignal({
      event_id: "evt_1",
      client_id: 1,
      strategy_id: 3,
      strategy_instance_id: 7,
      symbol: "NIFTY 50",
      instrument: "NIFTY24MAR23600CE",
      action: "SELL",
      quantity: 25,
      price_type: "MARKET",
      price: 100,
      exit_reason: "atr_trailing_exit",
    });

    expect(mockRiskManager.checkSignal).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SELL", instrument: "NIFTY24MAR23600CE" }),
      { isRiskReducingExit: true },
    );
    expect(manager.createOrder).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: 501, side: "SELL" });
  });

  it("does not bypass risk checks for a SELL with no reducible long position", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ position: 0 }] })
      .mockResolvedValueOnce({ rows: [{ queued_buy_quantity: 0 }] });

    const manager = createManager();
    manager.publishRejectedSignal = jest.fn().mockResolvedValue(true);
    manager.recordSignalDecision = jest.fn().mockResolvedValue(undefined);

    const result = await manager.handleSignal({
      event_id: "evt_2",
      client_id: 1,
      strategy_id: 3,
      strategy_instance_id: 7,
      symbol: "NIFTY 50",
      instrument: "NIFTY24MAR23600CE",
      action: "SELL",
      quantity: 25,
      price_type: "MARKET",
      price: 100,
      exit_reason: "atr_trailing_exit",
    });

    expect(mockRiskManager.checkSignal).not.toHaveBeenCalled();
    expect(manager.createOrder).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(manager.publishRejectedSignal).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: "evt_2", action: "SELL" }),
      "naked_or_risk_increasing_sell_not_supported",
      expect.any(Object),
    );
  });

  it("still treats BUY as non-exit risk even when positions exist", async () => {
    query.mockReset();
    mockRiskManager.checkSignal.mockResolvedValue({
      allowed: false,
      reason: "circuit_breaker_triggered",
    });

    const manager = createManager();

    const result = await manager.handleSignal({
      event_id: "evt_3",
      client_id: 1,
      strategy_id: 3,
      strategy_instance_id: 7,
      symbol: "NIFTY 50",
      instrument: "NIFTY24MAR23600CE",
      action: "BUY",
      quantity: 25,
      price_type: "MARKET",
      price: 100,
    });

    expect(mockRiskManager.checkSignal).toHaveBeenCalledWith(
      expect.objectContaining({ action: "BUY", instrument: "NIFTY24MAR23600CE" }),
      { isRiskReducingExit: false },
    );
    expect(manager.createOrder).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
