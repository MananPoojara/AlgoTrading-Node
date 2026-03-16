jest.mock("../src/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../src/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => ({
    publishMarketTick: jest.fn().mockResolvedValue(true),
    publishSystemAlert: jest.fn().mockResolvedValue(true),
  })),
  CHANNELS: {},
}));

jest.mock("../src/marketData/angelWebsocket", () => ({
  AngelWebSocket: jest.fn(),
}));

jest.mock("../src/marketData/dataNormalizer", () => ({
  DataNormalizer: jest.fn().mockImplementation(() => ({
    normalizeTick: jest.fn(() => ({
      symbol: "99926000",
      instrument_token: "99926000",
      ltp: 24123.4,
      timestamp: "2026-03-16T05:00:00.000Z",
      exchange: "NSE",
    })),
    normalizeOHLC: jest.fn(() => null),
    getBufferStats: jest.fn(() => ({ totalTicks: 0, symbolCount: 0, symbols: [] })),
  })),
}));

const { query } = require("../src/database/postgresClient");
const { MarketDataService } = require("../src/marketData/marketDataService");

describe("MarketDataService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps token-only ticks to registered symbols before publishing", async () => {
    const service = new MarketDataService();
    service.publisher = {
      publishMarketTick: jest.fn().mockResolvedValue(true),
    };
    service.instrumentManager.registerInstrument("99926000", "NIFTY 50", {
      exchange: "NSE",
    });

    await service.handleMessage({
      feedType: "tick",
      token: "99926000",
      last_traded_price: "24123.4",
    });

    expect(service.publisher.publishMarketTick).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "NIFTY 50",
        instrument_token: "99926000",
      }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO market_ticks"),
      expect.arrayContaining(["99926000", "NIFTY 50", "NSE", 24123.4]),
    );
  });

  it("loads subscriptions from active strategy instances instead of hardcoded defaults", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            instance_id: 11,
            status: "running",
            instance_parameters: { symbol: "BANKNIFTY" },
            strategy_parameters: {},
            strategy_name: "BANKNIFTY_STRADDLE",
            file_path: "src/strategies/optionSelling/bankniftyStraddle.js",
          },
          {
            instance_id: 12,
            status: "paused",
            instance_parameters: {},
            strategy_parameters: { symbol: "NIFTY 50" },
            strategy_name: "STRATEGY1_LIVE",
            file_path: "src/strategies/intraday/strategy1Live.js",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            exchange: "NSE",
            symbol: "BANKNIFTY",
            instrument_token: "99926009",
            underlying_symbol: "BANKNIFTY",
            instrument_type: "INDEX",
          },
        ],
      })
      .mockResolvedValueOnce({
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

    const service = new MarketDataService();

    await service.initialize();

    expect(service.instrumentManager.getSubscribedTokens()).toEqual([
      "99926009",
      "99926000",
    ]);
    expect(service.instrumentManager.getInstrument("99926009")).toEqual(
      expect.objectContaining({ symbol: "BANKNIFTY" }),
    );
    expect(service.instrumentManager.getInstrument("99926000")).toEqual(
      expect.objectContaining({ symbol: "NIFTY 50" }),
    );
  });

  it("unsubscribes tokens that are no longer needed after a refresh", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            instance_id: 11,
            status: "running",
            instance_parameters: { symbol: "BANKNIFTY" },
            strategy_parameters: {},
            strategy_name: "BANKNIFTY_STRADDLE",
            file_path: "src/strategies/optionSelling/bankniftyStraddle.js",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            exchange: "NSE",
            symbol: "BANKNIFTY",
            instrument_token: "99926009",
            underlying_symbol: "BANKNIFTY",
            instrument_type: "INDEX",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            instance_id: 12,
            status: "running",
            instance_parameters: { symbol: "NIFTY 50" },
            strategy_parameters: {},
            strategy_name: "STRATEGY1_LIVE",
            file_path: "src/strategies/intraday/strategy1Live.js",
          },
        ],
      })
      .mockResolvedValueOnce({
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

    const service = new MarketDataService();

    await service.refreshInstrumentSubscriptions({ reason: "first" });
    await service.refreshInstrumentSubscriptions({ reason: "second" });

    expect(service.instrumentManager.getSubscribedTokens()).toEqual(["99926000"]);
  });
});
