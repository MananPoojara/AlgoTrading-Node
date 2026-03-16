jest.mock("ws", () => {
  return jest.fn().mockImplementation(function MockWebSocket(url, options) {
    this.url = url;
    this.options = options;
    this.handlers = {};
    this.send = jest.fn();
    this.close = jest.fn();
    this.on = (event, handler) => {
      this.handlers[event] = handler;
    };
  });
});

const WebSocket = require("ws");
const { AngelWebSocket } = require("../src/marketData/angelWebsocket");

describe("AngelWebSocket", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("connects with SmartAPI V2 headers", async () => {
    const socket = new AngelWebSocket({
      apiKey: "api-key",
      clientCode: "client-code",
      jwtToken: "jwt-token",
      feedToken: "feed-token",
      wsUrl: "wss://example.test/feed",
    });

    const connectPromise = socket.connect();
    const wsInstance = WebSocket.mock.instances[0];
    wsInstance.handlers.open();
    await connectPromise;

    expect(WebSocket).toHaveBeenCalledWith("wss://example.test/feed", {
      headers: {
        "x-client-code": "client-code",
        Authorization: "jwt-token",
        "x-api-key": "api-key",
        "x-feed-token": "feed-token",
      },
    });

    await socket.disconnect();
  });

  it("sends V2 subscribe payloads", async () => {
    const socket = new AngelWebSocket({
      apiKey: "api-key",
      clientCode: "client-code",
      jwtToken: "jwt-token",
      feedToken: "feed-token",
    });

    const connectPromise = socket.connect();
    const wsInstance = WebSocket.mock.instances[0];
    wsInstance.handlers.open();
    await connectPromise;

    socket.subscribe(["260105", "260001"], {
      correlationID: "cid-1",
    });

    expect(wsInstance.send).toHaveBeenCalledWith(
      JSON.stringify({
        correlationID: "cid-1",
        action: 1,
        params: {
          mode: 1,
          tokenList: [
            {
              exchangeType: 1,
              tokens: ["260105", "260001"],
            },
          ],
        },
      }),
    );

    await socket.disconnect();
  });

  it("decodes binary LTP packets into normalized tick payloads", () => {
    const socket = new AngelWebSocket({
      apiKey: "api-key",
      clientCode: "client-code",
      jwtToken: "jwt-token",
      feedToken: "feed-token",
    });

    const buffer = Buffer.alloc(47);
    buffer.writeUInt8(1, 0);
    buffer.writeUInt8(1, 1);
    buffer.write("99926000", 2, "utf8");
    buffer.writeBigInt64LE(10n, 27);
    buffer.writeBigInt64LE(1710567900000n, 35);
    buffer.writeInt32LE(2412340, 43);

    expect(socket.decodeBinaryTick(buffer)).toEqual(
      expect.objectContaining({
        feedType: "tick",
        token: "99926000",
        exchange: "NSE",
        last_traded_price: 24123.4,
        timestamp: 1710567900000,
      }),
    );
  });
});
