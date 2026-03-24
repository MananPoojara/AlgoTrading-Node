/**
 * Tests for the atomic Redis SET NX signal deduplication gate.
 * Verifies that the gate drops duplicate signals before any DB work.
 */

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
    publishSystemAlert: jest.fn().mockResolvedValue(true),
  })),
  CHANNELS: {},
}));

jest.mock("../../packages/core/eventBus/redisClient", () => ({
  getRedisClient: jest.fn(() => mockRedisClient),
}));

jest.mock("../../apps/risk-manager/src/marginCalculator", () => ({
  getMarginCalculator: jest.fn(() => ({})),
}));

jest.mock("../../apps/risk-manager/src/circuitBreaker", () => ({
  getCircuitBreaker: jest.fn(() => ({})),
}));

jest.mock("../../apps/risk-manager/src/riskManager", () => ({
  RiskManager: jest.fn().mockImplementation(() => ({
    policyMode: "paper_warn_only",
    loadFromDatabase: jest.fn().mockResolvedValue(undefined),
    checkSignal: jest.fn().mockResolvedValue({ allowed: true, warnings: [] }),
    onOrderPlaced: jest.fn(),
    onOrderFilled: jest.fn().mockResolvedValue(undefined),
    onOrderCancelled: jest.fn(),
  })),
}));

// Mockable Redis client with setNx
const mockRedisClient = {
  setNx: jest.fn(),
};

const { OrderManager } = require("../../apps/order-manager/src/orderManager");

const makeSignalWithFingerprint = (overrides = {}) => ({
  event_id: "evt_dedup_test_001",
  strategy_instance_id: 12,
  client_id: 1,
  strategy_id: 99,
  symbol: "NIFTY 50",
  instrument: "NIFTY24MAR23600CE",
  action: "BUY",
  quantity: 25,
  price_type: "MARKET",
  price: 100,
  metadata: {
    trigger_bar_time: "2026-03-20T10:05:00+05:30",
    signal_fingerprint: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    instrument_resolution_status: "resolved",
  },
  signal_fingerprint: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  trigger_bar_time: "2026-03-20T10:05:00+05:30",
  instrument_resolution_status: "resolved",
  ...overrides,
});

describe("OrderManager atomic signal dedup gate", () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new OrderManager();
    manager.redis = mockRedisClient;
  });

  it("allows a signal through when fingerprint key does not exist in Redis (first seen)", async () => {
    // SET NX succeeds (key didn't exist) → 'OK' returned
    mockRedisClient.setNx.mockResolvedValue("OK");
    manager.handleSignal = jest.fn().mockResolvedValue(null);

    const result = await manager.isSignalDuplicate(makeSignalWithFingerprint());

    expect(result).toBe(false);
    expect(mockRedisClient.setNx).toHaveBeenCalledWith(
      expect.stringMatching(/^signal:dedup:/),
      "1",
      86400,
    );
  });

  it("drops a signal when fingerprint key already exists in Redis (duplicate)", async () => {
    // SET NX fails (key already exists) → null returned
    mockRedisClient.setNx.mockResolvedValue(null);

    const result = await manager.isSignalDuplicate(makeSignalWithFingerprint());

    expect(result).toBe(true);
  });

  it("falls back to allowing the signal when Redis setNx throws (non-fatal)", async () => {
    mockRedisClient.setNx.mockRejectedValue(new Error("Redis timeout"));

    const result = await manager.isSignalDuplicate(makeSignalWithFingerprint());

    // Should not block on Redis failure
    expect(result).toBe(false);
  });

  it("skips the Redis check when the signal has no extractable fingerprint", async () => {
    const signalWithoutFingerprint = {
      event_id: "evt_no_fingerprint",
      strategy_instance_id: 12,
      client_id: 1,
      symbol: "NIFTY 50",
      action: "BUY",
      quantity: 25,
      // No signal_fingerprint or metadata.signal_fingerprint
    };

    const result = await manager.isSignalDuplicate(signalWithoutFingerprint);

    // Should skip Redis and allow through (DB-level dedup will handle it)
    expect(result).toBe(false);
    expect(mockRedisClient.setNx).not.toHaveBeenCalled();
  });

  it("increments duplicate stat counter when dedup gate fires", async () => {
    // First call: allow through
    mockRedisClient.setNx.mockResolvedValueOnce("OK");
    // Subsequent calls: duplicate
    mockRedisClient.setNx.mockResolvedValue(null);

    // Stub validation to fail fast (signal still has fingerprint extracted before validation)
    manager.validator = { validateComplete: jest.fn().mockResolvedValue({ valid: false, reason: "test" }) };
    manager.recordSignal = jest.fn().mockResolvedValue(null);
    manager.recordSignalDecision = jest.fn().mockResolvedValue(null);
    manager.publishRejectedSignal = jest.fn().mockResolvedValue(null);

    const signal = makeSignalWithFingerprint();

    // First signal: not a duplicate
    await manager.handleSignal(signal);
    const statsAfterFirst = manager.stats.duplicates;

    // Second signal with same fingerprint: duplicate
    await manager.handleSignal({ ...signal, event_id: "evt_dedup_test_002" });

    expect(manager.stats.duplicates).toBe(statsAfterFirst + 1);
  });
});
