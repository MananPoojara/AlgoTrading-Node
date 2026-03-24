/**
 * Tests for startup reconciliation:
 * - Loads DB positions and ATR stops into Redis
 * - Detects orphaned broker positions in live mode
 * - Skips broker fetch in paper mode
 */

jest.mock('../../packages/database/postgresClient', () => ({
  query: jest.fn(),
}));

const mockRedisSet = jest.fn().mockResolvedValue('OK');

jest.mock('../../packages/core/eventBus/redisClient', () => ({
  getRedisClient: jest.fn(() => ({
    set: mockRedisSet,
  })),
}));

jest.mock('../../config/default', () => ({
  paperMode: true,
  marketHours: { open: '09:15', close: '15:30', squareOff: '15:15' },
}));

const { query } = require('../../packages/database/postgresClient');
const { runStartupReconciliation } = require('../../packages/core/bootstrap/reconcile');

const OPEN_POSITION_ROW = {
  id: 1,
  client_id: 10,
  strategy_instance_id: 42,
  instrument: 'NIFTY50_CE_24000',
  position: 50,
  average_price: '125.50',
  updated_at: '2026-03-20T05:15:00Z',
  runtime_state: JSON.stringify({
    entryContext: { trailingStop: 118.25, instrument: 'NIFTY50_CE_24000' },
  }),
};

describe('runStartupReconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads open positions from DB into Redis', async () => {
    query.mockResolvedValueOnce({ rows: [OPEN_POSITION_ROW] });

    await runStartupReconciliation();

    expect(mockRedisSet).toHaveBeenCalledWith(
      'position:42:NIFTY50_CE_24000',
      expect.stringContaining('"position":50'),
      expect.any(Number),
    );
  });

  it('restores ATR trailing stop into Redis', async () => {
    query.mockResolvedValueOnce({ rows: [OPEN_POSITION_ROW] });

    await runStartupReconciliation();

    expect(mockRedisSet).toHaveBeenCalledWith(
      'atr_stop:42',
      expect.stringContaining('"trailingStop":118.25'),
      expect.any(Number),
    );
  });

  it('does not write ATR stop when runtime_state has no trailingStop', async () => {
    query.mockResolvedValueOnce({
      rows: [{ ...OPEN_POSITION_ROW, runtime_state: JSON.stringify({ entryContext: {} }) }],
    });

    await runStartupReconciliation();

    // position key should still be written, but NOT the atr_stop key
    const atrCalls = mockRedisSet.mock.calls.filter(([key]) =>
      key.startsWith('atr_stop:'),
    );
    expect(atrCalls).toHaveLength(0);
  });

  it('returns correct counts from reconciliation', async () => {
    query.mockResolvedValueOnce({ rows: [OPEN_POSITION_ROW] });

    const result = await runStartupReconciliation();

    expect(result.positionsLoaded).toBe(1);
    expect(result.atrStopsLoaded).toBe(1);
    expect(result.orphans).toBe(0);
  });

  it('returns zeros when no open positions in DB', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await runStartupReconciliation();

    expect(result.positionsLoaded).toBe(0);
    expect(result.atrStopsLoaded).toBe(0);
    expect(result.orphans).toBe(0);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('skips broker fetch in paper mode', async () => {
    const mockBrokerApi = { getPositions: jest.fn() };
    query.mockResolvedValueOnce({ rows: [] });

    await runStartupReconciliation({ brokerApi: mockBrokerApi });

    expect(mockBrokerApi.getPositions).not.toHaveBeenCalled();
  });

  it('detects orphaned broker positions in live mode', async () => {
    // Re-import with paperMode: false
    jest.resetModules();
    jest.doMock('../../config/default', () => ({
      paperMode: false,
      marketHours: { open: '09:15', close: '15:30', squareOff: '15:15' },
    }));
    jest.doMock('../../packages/database/postgresClient', () => ({
      query: jest.fn().mockResolvedValueOnce({ rows: [] }), // no DB positions
    }));
    jest.doMock('../../packages/core/eventBus/redisClient', () => ({
      getRedisClient: jest.fn(() => ({ set: jest.fn().mockResolvedValue('OK') })),
    }));

    const { runStartupReconciliation: reconcileLive } = require('../../packages/core/bootstrap/reconcile');

    const mockBrokerApi = {
      getPositions: jest.fn().mockResolvedValue({
        success: true,
        positions: [
          { tradingsymbol: 'NIFTY24MAR50CE', netqty: 50 },
        ],
      }),
    };

    const result = await reconcileLive({ brokerApi: mockBrokerApi });

    expect(mockBrokerApi.getPositions).toHaveBeenCalled();
    expect(result.orphans).toBe(1);
  });
});
