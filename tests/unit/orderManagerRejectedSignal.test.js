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

const mockPublishRejectedOrder = jest.fn().mockResolvedValue(true);

jest.mock("../../packages/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => ({
    publishOrderRequest: jest.fn().mockResolvedValue(true),
    publish: jest.fn().mockResolvedValue(true),
    publishRejectedOrder: mockPublishRejectedOrder,
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

const { OrderManager } = require("../../apps/order-manager/src/orderManager");

describe("OrderManager rejected signal publication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRiskManager.checkSignal.mockResolvedValue({
      allowed: false,
      reason: "circuit_breaker_triggered",
    });
  });

  it("publishes a rejected_orders event when risk blocks a signal", async () => {
    const manager = new OrderManager();
    manager.publisher = require("../../packages/core/eventBus/publisher").getPublisher();
    manager.validator.validateComplete = jest.fn().mockResolvedValue({ valid: true });
    manager.recordSignal = jest.fn().mockResolvedValue({ id: 1, status: "rejected" });

    const signal = {
      event_id: "sig_1",
      client_id: 1,
      strategy_id: 6,
      strategy_instance_id: 5,
      symbol: "NIFTY 50",
      instrument: "NIFTY 50 100 CE",
      action: "BUY",
      quantity: 25,
      price_type: "MARKET",
      price: 100,
    };

    const result = await manager.handleSignal(signal);

    expect(result).toBeNull();
    expect(mockPublishRejectedOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "sig_1",
        strategy_instance_id: 5,
        instrument: "NIFTY 50 100 CE",
        action: "BUY",
        status: "rejected",
        rejection_reason: "circuit_breaker_triggered",
      }),
    );
  });

  it("publishes a rejected_orders event when option instrument resolution is unresolved in live mode", async () => {
    const manager = new OrderManager();
    manager.isPaperMode = false;
    manager.publisher = require("../../packages/core/eventBus/publisher").getPublisher();
    manager.validator.validateComplete = jest.fn().mockResolvedValue({ valid: true });
    manager.recordSignal = jest.fn().mockResolvedValue({ id: 2, status: "rejected" });

    const signal = {
      event_id: "sig_2",
      client_id: 1,
      strategy_id: 6,
      strategy_instance_id: 5,
      symbol: "NIFTY 50",
      instrument: "NIFTY 50 23250 CE",
      action: "BUY",
      quantity: 25,
      price_type: "MARKET",
      price: 100,
      instrument_resolution_status: "unresolved",
      resolver_source: "fallback",
    };

    const result = await manager.handleSignal(signal);

    expect(result).toBeNull();
    expect(mockRiskManager.checkSignal).not.toHaveBeenCalled();
    expect(mockPublishRejectedOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "sig_2",
        rejection_reason: "instrument_resolution_failed",
      }),
    );
  });

  it("allows unresolved option instruments through in paper mode", async () => {
    const manager = new OrderManager();
    manager.isPaperMode = true;
    manager.publisher = require("../../packages/core/eventBus/publisher").getPublisher();
    manager.validator.validateComplete = jest.fn().mockResolvedValue({ valid: true });
    manager.recordSignal = jest.fn().mockResolvedValue({ id: 3, status: "pending" });
    manager.recordSignalDecision = jest.fn().mockResolvedValue(undefined);
    manager.createOrderFromSignal = jest.fn().mockResolvedValue({ id: 99, event_id: "sig_3" });
    mockRiskManager.checkSignal.mockResolvedValue({ allowed: true, decision: "allow" });

    const signal = {
      event_id: "sig_3",
      client_id: 1,
      strategy_id: 6,
      strategy_instance_id: 5,
      symbol: "NIFTY 50",
      instrument: "NIFTY 50 23250 CE",
      action: "BUY",
      quantity: 25,
      price_type: "MARKET",
      price: 100,
      instrument_resolution_status: "unresolved",
      resolver_source: "fallback",
      metadata: {
        instrument_resolution_status: "unresolved",
        resolver_source: "fallback",
      },
    };

    const result = await manager.handleSignal(signal);

    expect(result).toEqual({ id: 99, event_id: "sig_3" });
    expect(mockRiskManager.checkSignal).toHaveBeenCalledWith(signal, {
      isRiskReducingExit: false,
    });
    expect(manager.createOrderFromSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "sig_3",
        instrument_resolution_status: "unresolved",
      }),
    );
    expect(mockPublishRejectedOrder).not.toHaveBeenCalled();
  });
});
