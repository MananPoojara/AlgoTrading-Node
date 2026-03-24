jest.useFakeTimers();

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
  onOrderCancelled: jest.fn(),
};

jest.mock("../../apps/risk-manager/src/riskManager", () => ({
  RiskManager: jest.fn().mockImplementation(() => mockRiskManager),
}));

const { OrderManager } = require("../../apps/order-manager/src/orderManager");

describe("OrderManager paper fill robustness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("fails a paper order instead of filling at zero when no usable price exists", async () => {
    const manager = new OrderManager();
    manager.publisher = mockPublisher;
    manager.publishRiskWarnings = jest.fn().mockResolvedValue(undefined);
    manager.transitionOrderState = jest.fn().mockResolvedValue(true);
    manager.updateSignalStatus = jest.fn().mockResolvedValue(undefined);
    manager.insertSystemLog = jest.fn().mockResolvedValue(undefined);
    manager.orderQueue.complete = jest.fn();
    manager.paperPortfolioWriter.syncAfterFill = jest.fn().mockResolvedValue(undefined);

    manager.simulatePaperFill({
      id: 42,
      event_id: "evt_missing_price",
      client_id: 1,
      strategy_instance_id: 9,
      symbol: "NIFTY 50",
      instrument: "NIFTY24MAR23600CE",
      side: "BUY",
      quantity: 25,
      price_type: "MARKET",
      price: 0,
    });

    await jest.runAllTimersAsync();

    expect(manager.transitionOrderState).toHaveBeenCalledWith(
      42,
      "failed",
      expect.objectContaining({
        rejectionReason: "paper_fill_missing_price",
      }),
    );
    expect(manager.updateSignalStatus).toHaveBeenCalledWith(42, "rejected");
    expect(mockRiskManager.onOrderCancelled).toHaveBeenCalledWith(42);
    expect(mockRiskManager.onOrderFilled).not.toHaveBeenCalled();
    expect(manager.paperPortfolioWriter.syncAfterFill).not.toHaveBeenCalled();
    expect(manager.publishRiskWarnings).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "evt_missing_price",
      }),
      expect.arrayContaining([
        expect.objectContaining({
          reason: "paper_fill_missing_price",
        }),
      ]),
    );
  });

  test("classifies stale option ticks separately from fresh live option ticks", () => {
    jest.setSystemTime(new Date("2026-03-20T10:00:40.000Z"));

    const manager = new OrderManager();
    manager.marketPrices.set("NIFTY 50 100 CE", {
      price: 123.45,
      timestampMs: new Date("2026-03-20T10:00:00.000Z").getTime(),
    });

    const paperFill = manager.resolvePaperFill({
      instrument: "NIFTY 50 100 CE",
      symbol: "NIFTY 50",
      price: 0,
    });

    expect(paperFill).toMatchObject({
      fillPrice: 123.45,
      source: "stale_option_tick",
      ageSeconds: 40,
      warning: "paper_fill_using_stale_option_tick",
    });
  });
});
