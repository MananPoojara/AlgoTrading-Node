const {
  buildRecordedSessionBreakdown,
  buildStrategy1ReplayPerformance,
  buildStrategy1VwapGateSummary,
  compareStrategy1Session,
  inspectCandleContinuity,
  isValidationWindowOpen,
  replayStrategy1DailyFromMinuteHistory,
  replayStrategy1DailyHistory,
  replayStrategy1Session,
} = require("../../packages/strategies/intraday/strategy1Validation");

function makeBar(minute, open, high, low, close, volume = 1000) {
  const mm = String(minute).padStart(2, "0");
  return {
    date: "2026-03-24",
    barTime: `2026-03-24T09:${mm}:00+05:30`,
    open,
    high,
    low,
    close,
    volume,
  };
}

function makeDailyMinuteBars(date, open, close) {
  return [
    {
      date,
      barTime: `${date}T09:15:00+05:30`,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close: open,
      volume: 100,
    },
    {
      date,
      barTime: `${date}T15:00:00+05:30`,
      open,
      high: Math.max(open, close) + 2,
      low: Math.min(open, close) - 1,
      close,
      volume: 1000,
    },
  ];
}

describe("strategy1Validation", () => {
  it("replays a BUY after three consecutive red candles", () => {
    const bars = [
      makeBar(15, 95, 96, 94, 94),
      makeBar(16, 103, 104, 102, 102),
      makeBar(17, 101, 102, 100, 100),
      makeBar(18, 99, 100, 98, 98),
      makeBar(19, 98, 99, 97, 97),
    ];

    const replay = replayStrategy1Session({
      bars,
      symbol: "NIFTY 50",
      fixedMax: true,
      maxRed: 3,
      timeframe: "1min",
    });

    expect(replay.events).toEqual([
      expect.objectContaining({
        action: "BUY",
        barTime: "2026-03-24T09:17:00+05:30",
        reason: "consecutive_red_entry",
      }),
    ]);
    expect(replay.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "BUY",
          redCount: 3,
          vwapGatePassed: true,
        }),
      ]),
    );
  });

  it("replays a daily-timeframe BUY only in the end-of-day window", () => {
    const bars = [
      ...makeDailyMinuteBars("2026-03-20", 90, 91),
      ...makeDailyMinuteBars("2026-03-21", 91, 92),
      ...makeDailyMinuteBars("2026-03-22", 102, 101),
      ...makeDailyMinuteBars("2026-03-23", 101, 100),
      {
        date: "2026-03-24",
        barTime: "2026-03-24T09:15:00+05:30",
        open: 130,
        high: 130,
        low: 50,
        close: 60,
        volume: 100,
      },
      {
        date: "2026-03-24",
        barTime: "2026-03-24T15:00:00+05:30",
        open: 130,
        high: 130,
        low: 120,
        close: 120,
        volume: 1000,
      },
    ];

    const replay = replayStrategy1Session({
      bars,
      symbol: "NIFTY 50",
      fixedMax: true,
      maxRed: 3,
      timeframe: "1day",
    });

    expect(replay.events).toEqual([
      expect.objectContaining({
        action: "BUY",
        barTime: "2026-03-24T15:00:00+05:30",
        reason: "consecutive_red_entry",
      }),
    ]);
  });

  it("replays completed daily history without the live evaluation window", () => {
    const bars = [
      { date: "2026-03-20", barTime: "2026-03-20T15:30:00+05:30", open: 100, high: 101, low: 98, close: 99 },
      { date: "2026-03-21", barTime: "2026-03-21T15:30:00+05:30", open: 99, high: 100, low: 97, close: 98 },
      { date: "2026-03-24", barTime: "2026-03-24T15:30:00+05:30", open: 98, high: 99, low: 96, close: 97 },
      { date: "2026-03-25", barTime: "2026-03-25T15:30:00+05:30", open: 97, high: 100, low: 96, close: 99 },
    ];

    const replay = replayStrategy1DailyHistory({
      bars,
      symbol: "NIFTY 50",
      fixedMax: true,
      maxRed: 3,
    });

    expect(replay.events).toEqual([
      expect.objectContaining({
        action: "BUY",
        barTime: "2026-03-24T15:30:00+05:30",
        signalAnchorTime: "2026-03-24T09:15:00+05:30",
        reason: "consecutive_red_entry",
      }),
    ]);
    expect(replay.timeline[replay.timeline.length - 1]).toEqual(
      expect.objectContaining({
        barTime: "2026-03-25T15:30:00+05:30",
        timeframe: "1day",
      }),
    );
  });


  it("replays daily validation from minute history with the live daily VWAP window", () => {
    const bars = [
      ...makeDailyMinuteBars("2026-03-20", 90, 91),
      ...makeDailyMinuteBars("2026-03-21", 91, 92),
      ...makeDailyMinuteBars("2026-03-22", 102, 101),
      ...makeDailyMinuteBars("2026-03-23", 101, 100),
      {
        date: "2026-03-24",
        barTime: "2026-03-24T09:15:00+05:30",
        open: 130,
        high: 130,
        low: 50,
        close: 60,
        volume: 100,
      },
      {
        date: "2026-03-24",
        barTime: "2026-03-24T15:00:00+05:30",
        open: 130,
        high: 130,
        low: 120,
        close: 120,
        volume: 1000,
      },
    ];

    const replay = replayStrategy1DailyFromMinuteHistory({
      bars,
      symbol: "NIFTY 50",
      fixedMax: true,
      maxRed: 3,
    });

    expect(replay.events).toEqual([
      expect.objectContaining({
        action: "BUY",
        barTime: "2026-03-24T15:00:00+05:30",
        signalAnchorTime: "2026-03-24T09:15:00+05:30",
        reason: "consecutive_red_entry",
      }),
    ]);
    expect(replay.timeline[replay.timeline.length - 1]).toEqual(
      expect.objectContaining({
        vwapGatePassed: true,
        timeframe: "1day",
      }),
    );
  });

  it("keeps pre-VWAP candidate BUY signals visible when VWAP is unavailable", () => {
    const bars = [
      ...makeDailyMinuteBars("2026-03-20", 90, 91),
      ...makeDailyMinuteBars("2026-03-21", 91, 92),
      ...makeDailyMinuteBars("2026-03-22", 102, 101),
      ...makeDailyMinuteBars("2026-03-23", 101, 100),
      {
        date: "2026-03-24",
        barTime: "2026-03-24T09:15:00+05:30",
        open: 103,
        high: 104,
        low: 101,
        close: 103,
        volume: 0,
      },
      {
        date: "2026-03-24",
        barTime: "2026-03-24T15:00:00+05:30",
        open: 103,
        high: 104,
        low: 100,
        close: 101,
        volume: 0,
      },
    ];

    const replay = replayStrategy1DailyFromMinuteHistory({
      bars,
      symbol: "NIFTY 50",
      fixedMax: true,
      maxRed: 3,
    });

    expect(replay.events).toEqual([]);
    expect(replay.candidate_events).toEqual([
      expect.objectContaining({
        action: "BUY",
        barTime: "2026-03-24T15:00:00+05:30",
        signalAnchorTime: "2026-03-24T09:15:00+05:30",
        reason: "consecutive_red_entry",
        gateReason: "vwap_unavailable",
        blockedByVwap: true,
      }),
    ]);
    expect(replay.timeline[replay.timeline.length - 1]).toEqual(
      expect.objectContaining({
        baseAction: "BUY",
        baseReason: "consecutive_red_entry",
        action: null,
        reason: "vwap_unavailable",
      }),
    );
  });

  it("summarizes per-day VWAP gate diagnostics from daily replay timeline", () => {
    const summary = buildStrategy1VwapGateSummary({
      timeline: [
        {
          barTime: "2026-03-20T15:00:00+05:30",
          signalAnchorTime: "2026-03-20T09:15:00+05:30",
          action: "BUY",
          reason: "consecutive_red_entry",
          decisionPrice: 105,
          vwap: 100,
          vwapGatePassed: true,
        },
        {
          barTime: "2026-03-21T15:00:00+05:30",
          signalAnchorTime: "2026-03-21T09:15:00+05:30",
          action: null,
          reason: "vwap_entry_blocked",
          decisionPrice: 98,
          vwap: 100,
          vwapGatePassed: false,
        },
        {
          barTime: "2026-03-24T15:00:00+05:30",
          signalAnchorTime: "2026-03-24T09:15:00+05:30",
          action: null,
          reason: "vwap_unavailable",
          decisionPrice: 101,
          vwap: null,
          vwapGatePassed: false,
        },
      ],
    });

    expect(summary).toEqual(
      expect.objectContaining({
        totalDays: 3,
        passedDays: 1,
        blockedDays: 1,
        unavailableDays: 1,
        signalDays: 1,
      }),
    );
    expect(summary.days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tradeDate: "2026-03-20",
          vwapGatePassed: true,
        }),
        expect.objectContaining({
          tradeDate: "2026-03-21",
          reason: "vwap_entry_blocked",
        }),
        expect.objectContaining({
          tradeDate: "2026-03-24",
          reason: "vwap_unavailable",
        }),
      ]),
    );
  });

  it("builds synthetic replay performance from replayed buy and sell events", () => {
    const replay = {
      events: [
        {
          action: "BUY",
          barTime: "2026-03-20T15:30:00+05:30",
          signalAnchorTime: "2026-03-20T09:15:00+05:30",
          price: 100,
          reason: "consecutive_red_entry",
        },
        {
          action: "SELL",
          barTime: "2026-03-24T15:30:00+05:30",
          signalAnchorTime: "2026-03-24T09:15:00+05:30",
          price: 112,
          reason: "atr_trailing_exit",
        },
      ],
      timeline: [
        { barTime: "2026-03-20T15:30:00+05:30", close: 100 },
        { barTime: "2026-03-21T15:30:00+05:30", close: 104 },
        { barTime: "2026-03-24T15:30:00+05:30", close: 112 },
      ],
    };

    const performance = buildStrategy1ReplayPerformance(replay, {
      startingCapital: 100000,
    });

    expect(performance.syntheticOrders).toEqual([
      expect.objectContaining({
        entry_date: "2026-03-20T15:30:00+05:30",
        exit_date: "2026-03-24T15:30:00+05:30",
        entry_price: 100,
        exit_price: 112,
        pnl: 12,
      }),
    ]);
    expect(performance.stats).toEqual(
      expect.objectContaining({
        totalTrades: 1,
        wins: 1,
        losses: 0,
        netPnl: 12,
        endingEquity: 100012,
        openPositionAtEnd: false,
      }),
    );
    expect(performance.equityCurve[1]).toEqual(
      expect.objectContaining({
        barTime: "2026-03-21T15:30:00+05:30",
        in_position: true,
        unrealized_pnl: 4,
      }),
    );
  });

  it("detects candle gaps in retained history", () => {
    const audit = inspectCandleContinuity([
      makeBar(15, 100, 101, 99, 100),
      makeBar(16, 100, 101, 99, 99),
      makeBar(19, 99, 100, 98, 98),
    ]);

    expect(audit.gapCount).toBe(1);
    expect(audit.totalMissingMinutes).toBe(2);
    expect(audit.gaps[0]).toEqual({
      fromBarTime: "2026-03-24T09:16:00+05:30",
      toBarTime: "2026-03-24T09:19:00+05:30",
      missingMinutes: 2,
    });
  });

  it("separates manual override exits from replay parity inputs", () => {
    const breakdown = buildRecordedSessionBreakdown({
      actualSignals: [
        {
          id: 1,
          event_id: "evt_strategy",
          action: "BUY",
          trigger_bar_time: "2026-03-24T09:17:00+05:30",
          metadata: {},
        },
        {
          id: 2,
          event_id: "evt_manual",
          action: "SELL",
          trigger_bar_time: "2026-03-24T09:45:00+05:30",
          metadata: { exit_reason: "manual_stop" },
          price: 101,
        },
      ],
      actualOrders: [
        {
          id: 11,
          event_id: "evt_strategy",
          side: "BUY",
          status: "filled",
          created_at: "2026-03-24T09:19:05+05:30",
        },
        {
          id: 12,
          event_id: "evt_manual",
          side: "SELL",
          status: "filled",
          created_at: "2026-03-24T09:45:05+05:30",
        },
      ],
    });

    expect(breakdown.strategySignals).toEqual([
      expect.objectContaining({ id: 1, origin: "STRATEGY" }),
    ]);
    expect(breakdown.strategyOrders).toEqual([
      expect.objectContaining({ id: 11, linked_signal_origin: "STRATEGY" }),
    ]);
    expect(breakdown.manualOverrides).toEqual([
      expect.objectContaining({
        event_id: "evt_manual",
        reason: "manual_stop",
      }),
    ]);
  });

  it("classifies missing orders as WARN and missing signals as FAIL", () => {
    const replay = {
      events: [{ action: "BUY", barTime: "2026-03-24T09:17:00+05:30" }],
    };

    const withMissingOrder = compareStrategy1Session({
      replay,
      actualSignals: [
        {
          id: 11,
          event_id: "evt_1",
          action: "BUY",
          trigger_bar_time: "2026-03-24T09:17:00+05:30",
        },
      ],
      actualOrders: [],
    });

    expect(withMissingOrder.verdict).toBe("WARN");
    expect(withMissingOrder.summary.missingOrders).toBe(1);
    expect(withMissingOrder.mismatches[0]).toEqual(
      expect.objectContaining({
        kind: "missing_order",
        expectedAction: "BUY",
      }),
    );

    const withMissingSignal = compareStrategy1Session({
      replay,
      actualSignals: [],
      actualOrders: [],
    });

    expect(withMissingSignal.verdict).toBe("FAIL");
    expect(withMissingSignal.summary.missingSignals).toBe(1);
    expect(withMissingSignal.mismatches[0]).toEqual(
      expect.objectContaining({
        kind: "missing_signal",
        expectedAction: "BUY",
      }),
    );
  });

  it("opens validation for past dates and after 16:15 IST for today", () => {
    expect(
      isValidationWindowOpen(
        "2026-03-23",
        new Date("2026-03-24T09:00:00.000Z"),
      ),
    ).toBe(true);

    expect(
      isValidationWindowOpen(
        "2026-03-24",
        new Date("2026-03-24T10:30:00.000Z"),
      ),
    ).toBe(false);

    expect(
      isValidationWindowOpen(
        "2026-03-24",
        new Date("2026-03-24T10:45:00.000Z"),
      ),
    ).toBe(true);
  });
});
