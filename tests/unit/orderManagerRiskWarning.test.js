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

const mockPublisher = {
  publishOrderRequest: jest.fn().mockResolvedValue(true),
  publish: jest.fn().mockResolvedValue(true),
  publishSystemAlert: jest.fn().mockResolvedValue(true),
  publishMarketDataControl: jest.fn().mockResolvedValue(true),
};

jest.mock("../../packages/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => mockPublisher),
  CHANNELS: {},
}));

jest.mock("../../apps/risk-manager/src/marginCalculator", () => ({
  getMarginCalculator: jest.fn(() => ({})),
}));

jest.mock("../../apps/risk-manager/src/circuitBreaker", () => ({
  getCircuitBreaker: jest.fn(() => ({})),
}));

const mockRiskManager = {
  policyMode: "paper_warn_only",
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

describe("OrderManager risk warning flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists and publishes warnings while still creating the order", async () => {
    mockRiskManager.checkSignal.mockResolvedValue({
      allowed: true,
      warnings: [
        {
          reason: "daily_loss_limit_exceeded",
          details: { dailyLoss: 100000, limit: 50000 },
        },
      ],
    });

    query.mockResolvedValue({ rows: [], rowCount: 1 });

    const manager = new OrderManager();
    manager.publisher = mockPublisher;
    manager.validator.validateComplete = jest.fn().mockResolvedValue({ valid: true });
    manager.recordSignal = jest.fn().mockResolvedValue({ id: 101, status: "pending" });
    manager.createOrder = jest.fn().mockResolvedValue({
      id: 501,
      client_id: 1,
      strategy_instance_id: 7,
      event_id: "evt_1",
      symbol: "NIFTY 50",
      instrument: "NIFTY24MAR23600CE",
      side: "BUY",
      quantity: 25,
      price: 100,
      price_type: "MARKET",
      status: "created",
    });
    manager.transitionOrderState = jest.fn().mockResolvedValue(true);
    manager.orderQueue.enqueue = jest.fn().mockReturnValue(true);
    manager.publishOrderRequest = jest.fn().mockResolvedValue(true);
    manager.requestMarketDataRefresh = jest.fn().mockResolvedValue(true);

    const result = await manager.handleSignal({
      event_id: "evt_1",
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

    expect(result).toMatchObject({ id: 501, side: "BUY" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO system_logs"),
      expect.arrayContaining([
        "WARN",
        "order-manager",
        1,
      ]),
    );
    expect(mockPublisher.publishSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "risk_warning",
        warning_reason: "daily_loss_limit_exceeded",
      }),
    );
  });
});
