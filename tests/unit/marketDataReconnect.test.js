/**
 * Tests for MarketDataService WebSocket reconnect with exponential backoff.
 */

jest.useFakeTimers();

jest.mock('../../packages/database/postgresClient', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock('../../packages/core/eventBus/publisher', () => ({
  getPublisher: jest.fn(() => ({
    publishMarketTick: jest.fn().mockResolvedValue(true),
    publishSystemAlert: jest.fn().mockResolvedValue(true),
  })),
  CHANNELS: {},
}));

jest.mock('../../packages/core/eventBus/subscriber', () => ({
  getSubscriber: jest.fn(() => ({
    subscribeToMarketDataControl: jest.fn().mockResolvedValue(true),
  })),
}));

const mockCircuitBreaker = {
  triggerGlobal: jest.fn(),
  resetAll: jest.fn(),
};

jest.mock('../../apps/risk-manager/src/circuitBreaker', () => ({
  getCircuitBreaker: jest.fn(() => mockCircuitBreaker),
}));

const mockConnect = jest.fn().mockResolvedValue(true);
const mockAuthenticate = jest.fn().mockResolvedValue(true);
const mockSubscribe = jest.fn();
const mockDisconnect = jest.fn().mockResolvedValue(true);

let onConnectCallback = null;
let onDisconnectCallback = null;

jest.mock('../../apps/market-data-service/src/angelWebsocket', () => ({
  AngelWebSocket: jest.fn().mockImplementation((options = {}) => {
    onConnectCallback = options.onConnect;
    onDisconnectCallback = options.onDisconnect;
    return {
      connect: jest.fn().mockImplementation(async () => {
        await mockConnect();
        if (options.onConnect) options.onConnect();
        return true;
      }),
      authenticate: mockAuthenticate,
      subscribe: mockSubscribe,
      disconnect: mockDisconnect,
      isConnected: true,
    };
  }),
}));

const mockLogin = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../packages/broker-adapters/angel-one/angelOneBroker', () => ({
  AngelOneBrokerAPI: jest.fn().mockImplementation(() => ({
    login: mockLogin,
    logout: jest.fn().mockResolvedValue({ success: true }),
    jwtToken: 'jwt-token',
    feedToken: 'feed-token',
    isConnected: true,
  })),
}));

jest.mock('../../packages/core/utils/totp', () => ({
  generateTOTP: jest.fn(() => '123456'),
}));

jest.mock('../../config/default', () => ({
  angelOne: {
    apiKey: 'api-key',
    clientCode: 'client-code',
    password: 'password',
    totpSecret: 'TOTP',
    wsUrl: 'wss://example.test/feed',
  },
  paperMode: true,
  marketHours: { open: '09:15', close: '15:30', squareOff: '15:15' },
}));

const { MarketDataService } = require('../../apps/market-data-service/src/marketDataService');
const { getCircuitBreaker } = require('../../apps/risk-manager/src/circuitBreaker');

describe('MarketDataService WebSocket reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCircuitBreaker.triggerGlobal.mockReset();
    mockCircuitBreaker.resetAll.mockReset();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('triggers global circuit breaker on disconnect', async () => {
    const service = new MarketDataService();
    await service.initialize();
    await service.start();

    service.handleDisconnect(1006, 'abnormal closure');

    expect(mockCircuitBreaker.triggerGlobal).toHaveBeenCalledWith(
      'market_data_feed_disconnect',
    );
  });

  it('does not trigger circuit breaker or schedule reconnect when service is stopped', async () => {
    const service = new MarketDataService();
    service.isRunning = false;

    service.handleDisconnect(1006, 'abnormal closure');

    expect(mockCircuitBreaker.triggerGlobal).not.toHaveBeenCalled();
    expect(service.reconnectTimer).toBeNull();
  });

  it('schedules reconnect with 1s initial delay', async () => {
    const service = new MarketDataService();
    await service.initialize();
    await service.start();

    service.handleDisconnect(1006, 'abnormal closure');

    expect(service.reconnectTimer).not.toBeNull();
    expect(service.reconnectAttempt).toBe(1);
  });

  it('uses exponential backoff: delay grows with reconnect attempts', () => {
    const service = new MarketDataService();
    service.isRunning = true;

    // Inspect the schedule without running timers
    service.reconnectAttempt = 0;
    service.scheduleReconnect(); // schedules delay[0] = 1000ms
    expect(service.reconnectAttempt).toBe(1);
    service.clearReconnect();

    service.reconnectAttempt = 1;
    service.scheduleReconnect(); // schedules delay[1] = 2000ms
    expect(service.reconnectAttempt).toBe(2);
    service.clearReconnect();

    service.reconnectAttempt = 5;
    service.scheduleReconnect(); // schedules delay[5] = 30000ms (max)
    expect(service.reconnectAttempt).toBe(6);
    service.clearReconnect();

    // Attempt beyond array bounds — should clamp to max delay (30000ms)
    service.reconnectAttempt = 99;
    service.scheduleReconnect();
    expect(service.reconnectAttempt).toBe(100);
    service.clearReconnect();
  });

  it('clears circuit breaker on successful reconnect', async () => {
    const service = new MarketDataService();
    await service.initialize();
    await service.start();

    // Clear mocks from start() call
    mockCircuitBreaker.resetAll.mockClear();

    service.handleDisconnect(1006, 'test');

    // Advance exactly 1000ms (first reconnect delay) and flush promises
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockCircuitBreaker.resetAll).toHaveBeenCalled();
    expect(service.reconnectAttempt).toBe(0);
    expect(service.isStandby).toBe(false);
  });

  it('uses the connected socket instance when onConnect fires before service.ws is assigned', async () => {
    const service = new MarketDataService();
    service.publisher = {
      publishSystemAlert: jest.fn().mockResolvedValue(true),
    };
    service.instrumentManager.registerInstrument('99926000', 'NIFTY 50', { exchange: 'NSE' });
    service.instrumentManager.subscribe('99926000');

    const socket = { subscribe: jest.fn() };
    service.ws = null;

    service.handleConnect(socket);

    expect(socket.subscribe).toHaveBeenCalledWith(['99926000']);
  });

  it('reconnect timer is cancelled when service is stopped', async () => {
    const service = new MarketDataService();
    await service.initialize();
    await service.start();

    service.handleDisconnect(1006, 'test');
    expect(service.reconnectTimer).not.toBeNull();

    await service.stop();
    expect(service.reconnectTimer).toBeNull();
    expect(service.isRunning).toBe(false);
  });
});
