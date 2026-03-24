jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => ({
    publishMarketTick: jest.fn().mockResolvedValue(true),
    publishSystemAlert: jest.fn().mockResolvedValue(true),
  })),
  CHANNELS: {},
}));

jest.mock("../../packages/core/eventBus/subscriber", () => ({
  getSubscriber: jest.fn(() => ({
    subscribeToMarketDataControl: jest.fn().mockResolvedValue(true),
  })),
}));

const mockConnect = jest.fn().mockResolvedValue(true);
const mockAuthenticate = jest.fn().mockResolvedValue(true);
const mockSubscribe = jest.fn();
const mockDisconnect = jest.fn().mockResolvedValue(true);

jest.mock("../../apps/market-data-service/src/angelWebsocket", () => ({
  AngelWebSocket: jest.fn().mockImplementation((options = {}) => ({
    connect: jest.fn().mockImplementation(async () => {
      await mockConnect();
      if (options.onConnect) {
        options.onConnect();
      }
      return true;
    }),
    authenticate: mockAuthenticate,
    subscribe: mockSubscribe,
    disconnect: mockDisconnect,
    isConnected: true,
  })),
}));

const mockLogin = jest.fn().mockResolvedValue({ success: true });

jest.mock("../../packages/broker-adapters/angel-one/angelOneBroker", () => ({
  AngelOneBrokerAPI: jest.fn().mockImplementation(() => ({
    login: mockLogin,
    logout: jest.fn().mockResolvedValue({ success: true }),
    jwtToken: "jwt-token",
    feedToken: "feed-token",
    isConnected: true,
  })),
}));

jest.mock("../../packages/core/utils/totp", () => ({
  generateTOTP: jest.fn(() => "123456"),
}));

jest.mock("../../config/default", () => ({
  angelOne: {
    apiKey: "api-key",
    clientCode: "client-code",
    password: "password",
    totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    wsUrl: "wss://example.test/feed",
  },
  paperMode: true,
  marketHours: {
    open: "09:15",
    close: "15:30",
    squareOff: "15:15",
  },
}));

const { AngelWebSocket } = require("../../apps/market-data-service/src/angelWebsocket");
const { AngelOneBrokerAPI } = require("../../packages/broker-adapters/angel-one/angelOneBroker");
const { generateTOTP } = require("../../packages/core/utils/totp");
const { query } = require("../../packages/database/postgresClient");
const { MarketDataService } = require("../../apps/market-data-service/src/marketDataService");

describe("MarketDataService.start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockImplementation((sql, params = []) => {
      if (sql.includes("FROM strategy_instances si")) {
        return Promise.resolve({
          rows: [
            {
              instance_id: 7,
              status: "running",
              instance_parameters: { symbol: "NIFTY 50" },
              strategy_parameters: {},
              strategy_name: "STRATEGY1_LIVE",
              file_path: "packages/strategies/intraday/strategy1Live.js",
            },
          ],
        });
      }

      if (sql.includes("FROM instruments")) {
        const requested = params[1];

        if (requested === "NIFTY 50") {
          return Promise.resolve({
            rows: [
              {
                exchange: "NSE",
                symbol: "NIFTY 50",
                instrument_token: "99926000",
                underlying_symbol: "NIFTY",
                instrument_type: "INDEX",
              },
            ],
          });
        }
      }

      return Promise.resolve({ rows: [] });
    });
  });

  it("creates an Angel session before opening the V2 market feed", async () => {
    const service = new MarketDataService();

    await service.initialize();
    await service.start();

    expect(generateTOTP).toHaveBeenCalledWith(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
    expect(AngelOneBrokerAPI).toHaveBeenCalledWith({
      apiKey: "api-key",
      clientCode: "client-code",
      password: "password",
    });
    expect(mockLogin).toHaveBeenCalledWith(
      "client-code",
      "password",
      "123456",
    );
    expect(AngelWebSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "api-key",
        clientCode: "client-code",
        jwtToken: "jwt-token",
        feedToken: "feed-token",
        wsUrl: "wss://example.test/feed",
      }),
    );
    expect(mockConnect).toHaveBeenCalled();
    expect(mockAuthenticate).toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledWith(["99926000"]);

    await service.stop();
  });
});
