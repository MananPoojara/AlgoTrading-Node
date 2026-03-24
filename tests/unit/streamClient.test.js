/**
 * Tests for Redis Stream event bus (StreamPublisher + StreamConsumer).
 */

const { StreamPublisher, StreamConsumer } = require('../../packages/core/eventBus/streamClient');

const makeRedisClient = (overrides = {}) => ({
  getClient: jest.fn(() => mockIoRedis),
  setNx: jest.fn().mockResolvedValue('OK'),
  ...overrides,
});

const mockIoRedis = {
  xadd: jest.fn(),
  xgroup: jest.fn(),
  xreadgroup: jest.fn(),
  xack: jest.fn(),
  xautoclaim: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── StreamPublisher ───────────────────────────────────────────────────────────

describe('StreamPublisher', () => {
  it('publishes to stream:strategy_signals with XADD', async () => {
    mockIoRedis.xadd.mockResolvedValue('1234567890-0');

    const redisClient = makeRedisClient();
    const publisher = new StreamPublisher(redisClient);

    const id = await publisher.publish('strategy_signals', {
      event_id: 'evt_001',
      action: 'BUY',
    });

    expect(id).toBe('1234567890-0');
    expect(mockIoRedis.xadd).toHaveBeenCalledWith(
      'stream:strategy_signals',
      '*',
      'payload',
      expect.stringContaining('"event_id":"evt_001"'),
    );
  });

  it('throws when XADD fails', async () => {
    mockIoRedis.xadd.mockRejectedValue(new Error('Redis OOM'));

    const publisher = new StreamPublisher(makeRedisClient());

    await expect(
      publisher.publish('strategy_signals', { event_id: 'evt_002' }),
    ).rejects.toThrow('Redis OOM');
  });
});

// ── StreamConsumer ────────────────────────────────────────────────────────────

describe('StreamConsumer.ensureGroup', () => {
  it('creates consumer group with XGROUP CREATE MKSTREAM', async () => {
    mockIoRedis.xgroup.mockResolvedValue('OK');

    const consumer = new StreamConsumer(makeRedisClient(), {
      streamName: 'strategy_signals',
      groupName: 'order-manager',
      consumerName: 'test-1',
      handler: jest.fn(),
    });

    await consumer.ensureGroup();

    expect(mockIoRedis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      'stream:strategy_signals',
      'order-manager',
      '$',
      'MKSTREAM',
    );
  });

  it('ignores BUSYGROUP error when group already exists (idempotent)', async () => {
    mockIoRedis.xgroup.mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists'));

    const consumer = new StreamConsumer(makeRedisClient(), {
      streamName: 'strategy_signals',
      groupName: 'order-manager',
      consumerName: 'test-1',
      handler: jest.fn(),
    });

    // Should not throw
    await expect(consumer.ensureGroup()).resolves.toBeUndefined();
  });

  it('propagates non-BUSYGROUP errors from XGROUP CREATE', async () => {
    mockIoRedis.xgroup.mockRejectedValue(new Error('WRONGTYPE Operation against a key'));

    const consumer = new StreamConsumer(makeRedisClient(), {
      streamName: 'strategy_signals',
      groupName: 'order-manager',
      consumerName: 'test-1',
      handler: jest.fn(),
    });

    await expect(consumer.ensureGroup()).rejects.toThrow('WRONGTYPE');
  });
});

describe('StreamConsumer._processEntry', () => {
  const makeConsumer = (handler, redisOverrides = {}) => {
    const redisClient = makeRedisClient(redisOverrides);
    const consumer = new StreamConsumer(redisClient, {
      streamName: 'strategy_signals',
      groupName: 'order-manager',
      consumerName: 'test-1',
      handler,
    });
    return { consumer, redisClient };
  };

  it('parses payload, calls handler, and ACKs message on success', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    mockIoRedis.xack.mockResolvedValue(1);

    const { consumer, redisClient } = makeConsumer(handler);
    // First call: setNx returns 'OK' (not yet processed)
    redisClient.setNx.mockResolvedValue('OK');

    await consumer._processEntry('1234-0', [
      'payload', JSON.stringify({ event_id: 'evt_stream_01', action: 'BUY' }),
    ]);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ event_id: 'evt_stream_01' }));
    expect(mockIoRedis.xack).toHaveBeenCalledWith(
      'stream:strategy_signals',
      'order-manager',
      '1234-0',
    );
  });

  it('skips handler and ACKs when message was already processed (idempotent)', async () => {
    const handler = jest.fn();
    mockIoRedis.xack.mockResolvedValue(1);

    const { consumer, redisClient } = makeConsumer(handler);
    // setNx returns null → key already exists → already processed
    redisClient.setNx.mockResolvedValue(null);

    await consumer._processEntry('1234-1', [
      'payload', JSON.stringify({ event_id: 'evt_already_seen', action: 'SELL' }),
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(mockIoRedis.xack).toHaveBeenCalled();
  });

  it('processes distinct lifecycle messages that share one event_id', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    mockIoRedis.xack.mockResolvedValue(1);

    const { consumer, redisClient } = makeConsumer(handler);
    redisClient.setNx.mockResolvedValue('OK');

    const payload = { event_id: 'evt_shared', side: 'BUY', strategy_instance_id: 'inst_1' };

    await consumer._processEntry('1234-4', [
      'payload', JSON.stringify({ ...payload, status: 'acknowledged' }),
    ]);
    await consumer._processEntry('1234-5', [
      'payload', JSON.stringify({ ...payload, status: 'filled' }),
    ]);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(redisClient.setNx).toHaveBeenNthCalledWith(1, 'processed:stream:strategy_signals:1234-4', '1', 86400);
    expect(redisClient.setNx).toHaveBeenNthCalledWith(2, 'processed:stream:strategy_signals:1234-5', '1', 86400);
    expect(mockIoRedis.xack).toHaveBeenCalledTimes(2);
  });

  it('does NOT ACK when handler throws (message will be redelivered)', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('handler crash'));
    mockIoRedis.xack.mockResolvedValue(1);

    const { consumer, redisClient } = makeConsumer(handler);
    redisClient.setNx.mockResolvedValue('OK');

    await consumer._processEntry('1234-2', [
      'payload', JSON.stringify({ event_id: 'evt_crash', action: 'BUY' }),
    ]);

    expect(handler).toHaveBeenCalled();
    // xack should NOT be called since handler threw
    expect(mockIoRedis.xack).not.toHaveBeenCalled();
  });

  it('ACKs and skips when payload field is missing (malformed message)', async () => {
    const handler = jest.fn();
    mockIoRedis.xack.mockResolvedValue(1);

    const { consumer } = makeConsumer(handler);

    await consumer._processEntry('1234-3', ['other_field', 'value']);

    expect(handler).not.toHaveBeenCalled();
    expect(mockIoRedis.xack).toHaveBeenCalled();
  });
});
