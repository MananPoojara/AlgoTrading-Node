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

const mockRiskLoadFromDatabase = jest.fn().mockResolvedValue(undefined);

jest.mock("../../apps/risk-manager/src/riskManager", () => ({
  RiskManager: jest.fn().mockImplementation(() => ({
    loadFromDatabase: mockRiskLoadFromDatabase,
    checkSignal: jest.fn().mockResolvedValue({ allowed: true }),
    onOrderPlaced: jest.fn(),
    onOrderFilled: jest.fn().mockResolvedValue(undefined),
  })),
}));

const { query } = require("../../packages/database/postgresClient");
const { OrderManager } = require("../../apps/order-manager/src/orderManager");
const {
  ORDER_STATES,
} = require("../../apps/order-manager/src/orderStateMachine");

describe("OrderManager restart recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
  });

  it("loads risk state and requeues recoverable paper orders on initialize", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 21,
          client_id: 1,
          strategy_instance_id: 3,
          event_id: "replay_order_1",
          symbol: "NIFTY",
          instrument: "NIFTY24APRCE",
          side: "BUY",
          quantity: 2,
          price: 100,
          price_type: "MARKET",
          status: "queued",
          execution_mode: "paper",
        },
        {
          id: 22,
          client_id: 1,
          strategy_instance_id: 3,
          event_id: "replay_order_2",
          symbol: "SIMNIFTY",
          instrument: "NIFTY24APRPE",
          side: "BUY",
          quantity: 1,
          price: 90,
          price_type: "MARKET",
          status: "validated",
          execution_mode: "paper",
        },
        {
          id: 23,
          client_id: 1,
          strategy_instance_id: 3,
          event_id: "replay_order_3",
          symbol: "SIMNIFTY",
          instrument: "NIFTY24APRPE",
          side: "BUY",
          quantity: 1,
          price: 95,
          price_type: "MARKET",
          status: "created",
          execution_mode: "paper",
        },
      ],
    });

    const manager = new OrderManager();
    manager.transitionOrderState = jest.fn().mockResolvedValue(true);
    await manager.initialize();

    expect(mockRiskLoadFromDatabase).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(manager.transitionOrderState).toHaveBeenNthCalledWith(
      1,
      22,
      ORDER_STATES.QUEUED,
      { recovery: true },
    );
    expect(manager.transitionOrderState).toHaveBeenNthCalledWith(
      2,
      23,
      ORDER_STATES.VALIDATED,
      { recovery: true },
    );
    expect(manager.transitionOrderState).toHaveBeenNthCalledWith(
      3,
      23,
      ORDER_STATES.QUEUED,
      { recovery: true },
    );
    expect(manager.orderQueue.getSize()).toBe(3);
    expect(manager.orderQueue.getAll().queue.map((order) => order.id)).toEqual(
      [21, 22, 23],
    );

    manager.stopOrderProcessing();
    manager.stopApprovalTimeoutSweep();
  });
});
