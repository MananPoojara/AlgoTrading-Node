jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("../../packages/core/logger/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../apps/strategy-engine/src/workerManager", () => ({
  getWorkerManager: jest.fn(),
}));

const { query } = require("../../packages/database/postgresClient");
const router = require("../../apps/api/src/routes/strategies");

function getRouteHandler(method, path) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method],
  );

  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }

  return layer.route.stack[0].handle;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("strategy settings route", () => {
  const patchSettings = getRouteHandler("patch", "/instances/:id/settings");

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stores a normalized timeframe and marks the change as restart-required", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 9,
            client_id: 3,
            parameters: { symbol: "NIFTY 50", quantity: 25 },
            risk_limits: { max_daily_loss: 50000 },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 9,
            parameters: { symbol: "NIFTY 50", quantity: 25, timeframe: "1day" },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const req = {
      params: { id: "9" },
      body: { timeframe: "daily" },
    };
    const res = createResponse();

    await patchSettings(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.parameters.timeframe).toBe("1day");
    expect(res.body.data.restart_required).toBe(true);
  });
});
