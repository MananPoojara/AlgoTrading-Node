const { query } = require("../../packages/database/postgresClient");
const { getRedisClient } = require("../../packages/core/eventBus/redisClient");

jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/core/eventBus/redisClient", () => ({
  getRedisClient: jest.fn(),
}));

jest.mock("../../packages/core/eventBus/publisher", () => ({
  getPublisher: jest.fn(() => ({
    publish: jest.fn().mockResolvedValue("stream-id-1"),
  })),
}));

jest.mock("../../apps/api/src/websocketServer", () => ({
  getWebSocketServer: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
  })),
}));

const { app } = require("../../apps/api/src/server");

describe("health routes", () => {
  let server;
  let baseUrl;

  beforeEach(async () => {
    jest.clearAllMocks();
    query.mockResolvedValue({ rows: [{ ok: 1 }] });
    getRedisClient.mockReturnValue({
      connect: jest.fn().mockResolvedValue(undefined),
      healthCheck: jest.fn().mockResolvedValue({ status: "online" }),
    });

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server = null;
    }
  });

  it("serves GET /health without auth", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("healthy");
    expect(query).toHaveBeenCalledWith("SELECT 1");
  });

  it("serves GET /ready without auth", async () => {
    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ready");
  });
});
