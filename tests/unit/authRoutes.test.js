jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn(),
}));

jest.mock("bcryptjs", () => ({
  compare: jest.fn(),
}));

jest.mock("../../packages/core/logger/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const bcrypt = require("bcryptjs");
const { query } = require("../../packages/database/postgresClient");
const router = require("../../apps/api/src/routes/auth");

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

describe("auth routes", () => {
  const postLogin = getRouteHandler("post", "/login");

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("logs in an active operator and creates an api token", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            username: "admin",
            role: "admin",
            status: "active",
            password_hash: "stored-hash",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    bcrypt.compare.mockResolvedValue(true);

    const req = {
      body: {
        email: "admin@algotrading.local",
        password: "admin123",
      },
    };
    const res = createResponse();

    await postLogin(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      username: "admin",
      role: "admin",
      client_id: 1,
    });
    expect(typeof res.body.data.token).toBe("string");
    expect(res.body.data.token.length).toBeGreaterThan(20);
    expect(bcrypt.compare).toHaveBeenCalledWith("admin123", "stored-hash");
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT id FROM clients WHERE status = $1 ORDER BY id ASC LIMIT 1",
      ["active"],
    );
  });

  test("rejects invalid credentials", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          username: "admin",
          role: "admin",
          status: "active",
          password_hash: "stored-hash",
        },
      ],
    });
    bcrypt.compare.mockResolvedValue(false);

    const req = {
      body: {
        username: "admin",
        password: "wrong-password",
      },
    };
    const res = createResponse();

    await postLogin(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: "Invalid credentials",
    });
  });
});
