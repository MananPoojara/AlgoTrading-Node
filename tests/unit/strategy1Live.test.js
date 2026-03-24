jest.mock("../../packages/core/logger/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../packages/strategies/intraday/atmOptionResolver", () => ({
  resolveAtmOptionInstrument: jest.fn().mockResolvedValue({
    instrument: "NIFTY 50 100 CE",
    instrumentToken: "SIM_TOKEN",
    source: "fallback",
  }),
}));

jest.mock("../../apps/market-data-service/src/angelHistoricalDataClient", () => ({
  getAngelHistoricalDataClient: jest.fn(),
}));

jest.mock("../../packages/database/postgresClient", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock("fs", () => ({
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(
    () =>
      [
        "Ticker,Date,Time,Open,High,Low,Close",
        "NIFTY 50,2026-03-10,09:15:00,100,101,99,101",
        "NIFTY 50,2026-03-10,09:16:00,101,102,100,102",
        "NIFTY 50,2026-03-10,09:17:00,102,103,101,103",
      ].join("\n"),
  ),
}));

const { Strategy1Live } = require("../../packages/strategies/intraday/strategy1Live");
const { logger } = require("../../packages/core/logger/logger");
const { query } = require("../../packages/database/postgresClient");

describe("Strategy1Live", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });

  it("bootstraps minute bars from CSV fallback instead of daily bars", async () => {
    const strategy = new Strategy1Live({
      instanceId: 1,
      clientId: 1,
      strategyId: 1,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    expect(strategy.barHistory).toEqual([
      {
        date: "2026-03-10",
        barTime: "2026-03-10T09:15:00+05:30",
        open: 100,
        high: 101,
        low: 99,
        close: 101,
      },
      {
        date: "2026-03-10",
        barTime: "2026-03-10T09:16:00+05:30",
        open: 101,
        high: 102,
        low: 100,
        close: 102,
      },
      {
        date: "2026-03-10",
        barTime: "2026-03-10T09:17:00+05:30",
        open: 102,
        high: 103,
        low: 101,
        close: 103,
      },
    ]);
  });

  it("emits a BUY signal after three consecutive completed red 1-minute candles", async () => {
    const strategy = new Strategy1Live({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    await strategy.processTick({
      timestamp: "2026-03-11T09:15:10+05:30",
      ltp: 105,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:15:50+05:30",
      ltp: 104,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:16:00+05:30",
      ltp: 103,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:16:20+05:30",
      ltp: 102,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:17:00+05:30",
      ltp: 101,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:17:20+05:30",
      ltp: 100,
    });
    const signal = await strategy.processTick({
      timestamp: "2026-03-11T09:18:00+05:30",
      ltp: 99,
    });

    expect(signal).toMatchObject({
      action: "BUY",
      instrument: "NIFTY 50 100 CE",
      instrument_token: "SIM_TOKEN",
      price: 100,
      strategy_instance_id: 5,
      strategy_id: 6,
      client_id: 1,
    });
    expect(strategy.getDiagnostics()).toMatchObject({
      instanceId: 5,
      strategyId: 6,
      symbol: "NIFTY 50",
      evaluationTimeframe: "1m",
      currentBar: {
        date: "2026-03-11",
        open: 99,
        high: 99,
        low: 99,
        close: 99,
      },
      lastEvaluation: {
        symbol: "NIFTY 50",
        action: "BUY",
        reason: "consecutive_red_entry",
        tradeDate: "2026-03-11T09:17:00+05:30",
        price: 100,
        redCount: 3,
        maxRed: 3,
        referencePrice: 100,
      },
    });
    expect(strategy.entryContext).toBeNull();
    expect(strategy.pendingEntryContext).toMatchObject({
      eventId: signal.event_id,
      entryDate: "2026-03-11T09:17:00+05:30",
      instrument: "NIFTY 50 100 CE",
      instrumentToken: "SIM_TOKEN",
      entryPrice: 100,
    });
  });

  it("moves into position only after a BUY execution update is filled", async () => {
    const strategy = new Strategy1Live({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    await strategy.processTick({ timestamp: "2026-03-11T09:15:10+05:30", ltp: 105 });
    await strategy.processTick({ timestamp: "2026-03-11T09:15:50+05:30", ltp: 104 });
    await strategy.processTick({ timestamp: "2026-03-11T09:16:00+05:30", ltp: 103 });
    await strategy.processTick({ timestamp: "2026-03-11T09:16:20+05:30", ltp: 102 });
    await strategy.processTick({ timestamp: "2026-03-11T09:17:00+05:30", ltp: 101 });
    await strategy.processTick({ timestamp: "2026-03-11T09:17:20+05:30", ltp: 100 });
    const signal = await strategy.processTick({
      timestamp: "2026-03-11T09:18:00+05:30",
      ltp: 99,
    });

    strategy.handleExecutionUpdate({
      strategy_instance_id: 5,
      event_id: signal.event_id,
      side: "BUY",
      status: "filled",
    });

    expect(strategy.pendingEntryContext).toBeNull();
    expect(strategy.entryContext).toMatchObject({
      entryDate: "2026-03-11T09:17:00+05:30",
      instrument: "NIFTY 50 100 CE",
      instrumentToken: "SIM_TOKEN",
      entryPrice: 100,
    });
  });

  it("restores runtime state on initialize and persists it after execution updates", async () => {
    const persistRuntimeState = jest.fn().mockResolvedValue(undefined);
    const strategy = new Strategy1Live({
      instanceId: 9,
      clientId: 1,
      strategyId: 6,
      persistRuntimeState,
      runtimeState: {
        lastEvaluatedBarTime: "2026-03-11T09:17:00+05:30",
        entryContext: {
          entryDate: "2026-03-11T09:17:00+05:30",
          instrument: "NIFTY 50 100 CE",
          instrumentToken: "SIM_TOKEN",
          entryPrice: 100,
        },
        pendingExitContext: {
          eventId: "pending_sell_1",
          instrument: "NIFTY 50 100 CE",
          reason: "intraday_square_off",
        },
      },
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    expect(strategy.lastEvaluatedBarTime).toBe("2026-03-11T09:17:00+05:30");
    expect(strategy.entryContext).toMatchObject({
      instrument: "NIFTY 50 100 CE",
      instrumentToken: "SIM_TOKEN",
    });
    expect(strategy.pendingExitContext).toMatchObject({
      eventId: "pending_sell_1",
      reason: "intraday_square_off",
    });

    strategy.handleExecutionUpdate({
      strategy_instance_id: 9,
      event_id: "pending_sell_1",
      side: "SELL",
      status: "filled",
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(persistRuntimeState).toHaveBeenCalled();
    expect(strategy.entryContext).toBeNull();
    expect(strategy.pendingExitContext).toBeNull();
  });

  it("adds trigger_bar_time and signal_fingerprint to emitted buy signals", async () => {
    const strategy = new Strategy1Live({
      instanceId: 11,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    await strategy.processTick({ timestamp: "2026-03-11T09:15:10+05:30", ltp: 105 });
    await strategy.processTick({ timestamp: "2026-03-11T09:15:50+05:30", ltp: 104 });
    await strategy.processTick({ timestamp: "2026-03-11T09:16:00+05:30", ltp: 103 });
    await strategy.processTick({ timestamp: "2026-03-11T09:16:20+05:30", ltp: 102 });
    await strategy.processTick({ timestamp: "2026-03-11T09:17:00+05:30", ltp: 101 });
    await strategy.processTick({ timestamp: "2026-03-11T09:17:20+05:30", ltp: 100 });
    const signal = await strategy.processTick({
      timestamp: "2026-03-11T09:18:00+05:30",
      ltp: 99,
    });

    expect(signal.trigger_bar_time).toBe("2026-03-11T09:17:00+05:30");
    expect(signal.signal_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(signal.metadata).toMatchObject({
      trigger_bar_time: "2026-03-11T09:17:00+05:30",
      instrument_resolution_status: "unresolved",
    });
  });

  it("does not synthesize dedup timestamps from wall-clock time", async () => {
    const strategy = new Strategy1Live({
      instanceId: 11,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    const metadata = strategy.buildSignalMetadata({
      action: "BUY",
      instrument: "NIFTY 50 100 CE",
      instrumentToken: "SIM_TOKEN",
      lastClosedBar: null,
      referencePrice: 100,
    });

    expect(metadata.trigger_bar_time).toBeNull();
    expect(metadata.signal_fingerprint).toBeNull();
    expect(metadata.metadata).toMatchObject({
      trigger_bar_time: null,
      signal_fingerprint: null,
    });
  });

  it("clears a pending BUY when execution is rejected", async () => {
    const strategy = new Strategy1Live({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    await strategy.processTick({ timestamp: "2026-03-11T09:15:10+05:30", ltp: 105 });
    await strategy.processTick({ timestamp: "2026-03-11T09:15:50+05:30", ltp: 104 });
    await strategy.processTick({ timestamp: "2026-03-11T09:16:00+05:30", ltp: 103 });
    await strategy.processTick({ timestamp: "2026-03-11T09:16:20+05:30", ltp: 102 });
    await strategy.processTick({ timestamp: "2026-03-11T09:17:00+05:30", ltp: 101 });
    await strategy.processTick({ timestamp: "2026-03-11T09:17:20+05:30", ltp: 100 });
    const signal = await strategy.processTick({
      timestamp: "2026-03-11T09:18:00+05:30",
      ltp: 99,
    });

    strategy.handleExecutionUpdate({
      strategy_instance_id: 5,
      event_id: signal.event_id,
      action: "BUY",
      status: "rejected",
    });

    expect(strategy.pendingEntryContext).toBeNull();
    expect(strategy.entryContext).toBeNull();
  });

  it("resets redCount after a green completed 1-minute candle", async () => {
    const strategy = new Strategy1Live({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    await strategy.processTick({
      timestamp: "2026-03-11T09:15:10+05:30",
      ltp: 105,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:15:50+05:30",
      ltp: 104,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:16:00+05:30",
      ltp: 103,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:16:20+05:30",
      ltp: 102,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:17:00+05:30",
      ltp: 101,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:17:20+05:30",
      ltp: 100,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:18:00+05:30",
      ltp: 101,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:18:50+05:30",
      ltp: 103,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:19:00+05:30",
      ltp: 104,
    });

    expect(strategy.getDiagnostics().lastEvaluation).toMatchObject({
      tradeDate: "2026-03-11T09:18:00+05:30",
      redCount: 0,
      reason: "no_entry",
    });
  });

  it("logs the last completed 1-minute candle in strategy diagnostics", async () => {
    const strategy = new Strategy1Live({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();

    await strategy.processTick({
      timestamp: "2026-03-11T09:15:10+05:30",
      ltp: 102,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:15:50+05:30",
      ltp: 101,
    });
    await strategy.processTick({
      timestamp: "2026-03-11T09:16:00+05:30",
      ltp: 100,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Strategy1 evaluation action=NONE reason=no_entry"),
      expect.objectContaining({
        instanceId: 5,
        strategyId: 6,
        symbol: "NIFTY 50",
        tradeDate: "2026-03-11T09:15:00+05:30",
        lastCompletedBar: {
          date: "2026-03-11",
          barTime: "2026-03-11T09:15:00+05:30",
          open: 102,
          high: 102,
          low: 101,
          close: 101,
        },
      }),
    );
  });

  it("IN_POSITION → PENDING_EXIT: emits SELL and sets pendingExitContext when ATR trailing stop is breached", async () => {
    // Build 6 uniform bars: open=100, high=100, low=80, close=80 (all red, range=20)
    // ATR(5) = 20 for bars[4] and bars[5], trailingBase = (100+80)/2 - 20*2 = 50
    // Entry at bar[4] barTime = 09:19. Bar[5] at 09:20 already in history (close=80 > 50, no exit yet).
    // A tick closing bar[6] at 09:21 with close=30 < 50 triggers SELL.
    const makeBar = (minuteStr) => ({
      date: `2026-03-11`,
      barTime: `2026-03-11T${minuteStr}:00+05:30`,
      open: 100,
      high: 100,
      low: 80,
      close: 80,
    });

    const capturedSignals = [];
    const strategy = new Strategy1Live({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: { symbol: "NIFTY 50", useHistoricalApi: false, fixedMax: true, maxRed: 3 },
    });

    await strategy.initialize();

    // Replace barHistory with controlled bars
    strategy.barHistory = [
      makeBar("09:15"),
      makeBar("09:16"),
      makeBar("09:17"),
      makeBar("09:18"),
      makeBar("09:19"), // index 4 — entry bar, ATR computed here
      makeBar("09:20"), // index 5 — already in history after entry
    ];
    strategy.entryContext = {
      entryDate: "2026-03-11T09:19:00+05:30",
      instrument: "NIFTY 50 100 CE",
      instrumentToken: "SIM_TOKEN",
      entryPrice: 80,
    };
    strategy.lastEvaluatedBarTime = "2026-03-11T09:20:00+05:30";
    strategy.onSignal = (signal) => capturedSignals.push(signal);

    // Open the 09:21 candle with ltp=45
    await strategy.processTick({ timestamp: "2026-03-11T09:21:10+05:30", ltp: 45 });
    // Drive close of the 09:21 candle down to 30
    await strategy.processTick({ timestamp: "2026-03-11T09:21:50+05:30", ltp: 30 });
    // Tick at 09:22 closes the 09:21 bar (close=30) — should trigger SELL
    const result = await strategy.processTick({ timestamp: "2026-03-11T09:22:00+05:30", ltp: 50 });

    // Either returned from processTick OR emitted via onSignal
    const sellSignal = result || capturedSignals.find((s) => s.action === "SELL");
    expect(sellSignal).toBeTruthy();
    expect(sellSignal.action).toBe("SELL");
    expect(strategy.pendingExitContext).toMatchObject({
      instrument: "NIFTY 50 100 CE",
      reason: "atr_trailing_exit",
    });
  });

  it("PENDING_EXIT → IDLE: clears entryContext and pendingExitContext when SELL fill arrives", async () => {
    const strategy = new Strategy1Live({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: { symbol: "NIFTY 50", useHistoricalApi: false },
    });

    await strategy.initialize();

    // Simulate being in PENDING_EXIT state (sell was emitted, waiting for fill)
    strategy.entryContext = {
      entryDate: "2026-03-11T09:17:00+05:30",
      instrument: "NIFTY 50 100 CE",
      instrumentToken: "SIM_TOKEN",
      entryPrice: 100,
    };
    strategy.pendingExitContext = {
      eventId: "sell_evt_exit_01",
      instrument: "NIFTY 50 100 CE",
      reason: "atr_trailing_exit",
    };

    // SELL fill arrives
    strategy.handleExecutionUpdate({
      strategy_instance_id: 5,
      event_id: "sell_evt_exit_01",
      side: "SELL",
      status: "filled",
    });

    expect(strategy.entryContext).toBeNull();
    expect(strategy.pendingExitContext).toBeNull();
  });

  it("emits a square-off SELL and pauses the strategy when squareOff is called in position", async () => {
    const strategy = new Strategy1Live({
      instanceId: 5,
      clientId: 1,
      strategyId: 6,
      parameters: {
        symbol: "NIFTY 50",
        useHistoricalApi: false,
      },
    });

    await strategy.initialize();
    strategy.entryContext = {
      entryDate: "2026-03-11T09:17:00+05:30",
      instrument: "NIFTY 50 100 CE",
      instrumentToken: "SIM_TOKEN",
      entryPrice: 100,
    };
    strategy.lastTick = {
      ltp: 97,
      timestamp: "2026-03-11T15:15:00+05:30",
    };

    await strategy.squareOff("scheduler_square_off");

    const diagnostics = strategy.getDiagnostics();
    expect(diagnostics.pendingExitContext).toMatchObject({
      instrument: "NIFTY 50 100 CE",
      reason: "scheduler_square_off",
    });
    expect(strategy.getState()).toBe("paused");
  });
});
