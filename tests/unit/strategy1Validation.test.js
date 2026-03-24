const {
  compareStrategy1Session,
  inspectCandleContinuity,
  isValidationWindowOpen,
  replayStrategy1Session,
} = require("../../packages/strategies/intraday/strategy1Validation");

function makeBar(minute, open, high, low, close) {
  const mm = String(minute).padStart(2, "0");
  return {
    date: "2026-03-24",
    barTime: `2026-03-24T09:${mm}:00+05:30`,
    open,
    high,
    low,
    close,
  };
}

describe("strategy1Validation", () => {
  it("replays a BUY after three consecutive red candles", () => {
    const bars = [
      makeBar(15, 100, 101, 99, 100),
      makeBar(16, 100, 101, 99, 100),
      makeBar(17, 100, 101, 99, 99),
      makeBar(18, 99, 100, 98, 98),
      makeBar(19, 98, 99, 97, 97),
    ];

    const replay = replayStrategy1Session({
      bars,
      symbol: "NIFTY 50",
      fixedMax: true,
      maxRed: 3,
    });

    expect(replay.events).toEqual([
      expect.objectContaining({
        action: "BUY",
        barTime: "2026-03-24T09:19:00+05:30",
        reason: "consecutive_red_entry",
      }),
    ]);
    expect(replay.timeline[replay.timeline.length - 1]).toEqual(
      expect.objectContaining({
        action: "BUY",
        redCount: 3,
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

  it("classifies missing orders as WARN and missing signals as FAIL", () => {
    const replay = {
      events: [
        { action: "BUY", barTime: "2026-03-24T09:19:00+05:30" },
      ],
    };

    const withMissingOrder = compareStrategy1Session({
      replay,
      actualSignals: [
        {
          id: 11,
          event_id: "evt_1",
          action: "BUY",
          trigger_bar_time: "2026-03-24T09:19:00+05:30",
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
