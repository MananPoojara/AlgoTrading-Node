jest.mock("../../packages/core/logger/logger", () => ({
  childLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  logAtLevel: jest.fn((targetLogger, level, message, meta) => {
    const method =
      typeof targetLogger?.[level] === "function" ? level : "info";
    targetLogger[method](message, meta);
  }),
}));

const mockSubscriber = {
  subscribeToStrategySignalsStream: jest.fn().mockResolvedValue(undefined),
  subscribeToOrderUpdatesStream: jest.fn().mockResolvedValue(undefined),
  subscribeToStrategySignals: jest.fn().mockResolvedValue(undefined),
  subscribeToTradeEvents: jest.fn().mockResolvedValue(undefined),
  subscribeToSystemAlerts: jest.fn().mockResolvedValue(undefined),
  subscribeToMarketTicks: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  unsubscribeHandler: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../../packages/core/eventBus/subscriber", () => ({
  getSubscriber: jest.fn(() => mockSubscriber),
  CHANNELS: {
    MARKET_TICKS: "market_ticks",
  },
}));

const { WebSocketServer } = require("../../apps/api/src/websocketServer");

describe("WebSocketServer market-data subscription lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("does not subscribe to market ticks until a client asks for market_data", async () => {
    const server = new WebSocketServer({ port: 19080 });

    await server.subscribeToEvents();

    expect(mockSubscriber.subscribeToMarketTicks).not.toHaveBeenCalled();
    expect(mockSubscriber.subscribeToStrategySignalsStream).toHaveBeenCalledTimes(1);
    expect(mockSubscriber.subscribeToOrderUpdatesStream).toHaveBeenCalledTimes(1);
    expect(mockSubscriber.subscribe).not.toHaveBeenCalledWith(
      "order_updates",
      expect.any(Function),
    );
  });

  test("subscribes and unsubscribes market ticks based on client demand", async () => {
    const server = new WebSocketServer({ port: 19080 });
    const ws = {
      clientId: "client_1",
      subscriptions: new Set(),
      send: jest.fn(),
    };

    server.clients.set(ws.clientId, { ws, subscriptions: ws.subscriptions });

    await server.handleSubscribe(ws, {
      type: "subscribe",
      payload: { channels: ["market_data", "orders"] },
    });

    expect(mockSubscriber.subscribeToMarketTicks).toHaveBeenCalledWith(
      server.marketTickHandler,
    );
    expect(server.marketTickSubscriptionActive).toBe(true);

    await server.handleUnsubscribe(ws, {
      type: "unsubscribe",
      payload: { channels: ["market_data"] },
    });

    expect(mockSubscriber.unsubscribeHandler).toHaveBeenCalledWith(
      "market_ticks",
      server.marketTickHandler,
    );
    expect(server.marketTickSubscriptionActive).toBe(false);
  });
});
