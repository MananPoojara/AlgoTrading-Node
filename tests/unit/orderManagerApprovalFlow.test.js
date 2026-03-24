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
  policyMode: "live_enforce",
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

describe("OrderManager operator approval flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
  });

  it("creates a pending approval instead of an order for live soft-warn signals", async () => {
    mockRiskManager.checkSignal.mockResolvedValue({
      allowed: false,
      decision: "soft_warn",
      requiresApproval: true,
      warnings: [
        {
          reason: "daily_loss_limit_exceeded",
          details: { dailyLoss: 60000, limit: 50000 },
        },
      ],
    });

    query.mockResolvedValue({ rows: [{ id: 101 }], rowCount: 1 });

    const manager = new OrderManager();
    manager.publisher = mockPublisher;
    manager.validator.validateComplete = jest.fn().mockResolvedValue({ valid: true });
    manager.recordSignal = jest.fn().mockResolvedValue({ id: 11, status: "pending" });
    manager.insertSystemLog = jest.fn().mockResolvedValue({ id: 77 });
    manager.createOrder = jest.fn();

    const result = await manager.handleSignal({
      event_id: "evt_pending_1",
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

    expect(result).toEqual({
      pendingApproval: true,
      approvalId: 77,
      eventId: "evt_pending_1",
    });
    expect(manager.createOrder).not.toHaveBeenCalled();
    expect(manager.insertSystemLog).toHaveBeenCalledWith(
      "WARN",
      expect.stringContaining("Operator approval required"),
      expect.objectContaining({
        event_type: "operator_approval_pending",
        status: "pending",
      }),
      1,
      3,
    );
  });

  it("creates an order when a pending approval is approved", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 77,
            client_id: 1,
            strategy_id: 3,
            metadata: {
              event_type: "operator_approval_pending",
              status: "pending",
              signal: {
                signal_id: 11,
                event_id: "evt_pending_2",
                client_id: 1,
                strategy_id: 3,
                strategy_instance_id: 7,
                symbol: "NIFTY 50",
                instrument: "NIFTY24MAR23600CE",
                action: "BUY",
                quantity: 25,
                price_type: "MARKET",
                price: 100,
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 77, metadata: {} }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const manager = new OrderManager();
    manager.recordSignalDecision = jest.fn().mockResolvedValue(undefined);
    manager.createOrderFromSignal = jest.fn().mockResolvedValue({ id: 501 });

    await manager.handleOperatorAction({
      approval_id: 77,
      action: "approve",
      operator_id: 1,
      operator_username: "dealer",
    });

    expect(manager.createOrderFromSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        signal_id: 11,
        event_id: "evt_pending_2",
        action: "BUY",
      }),
    );
  });
});
