const {
  aggregateStrategy1Bars,
  applyStrategy1VwapGate,
  buildStrategy1EvaluationContext,
  calculateSessionVwapSeries,
  getLatestSessionVwapPoint,
  normalizeStrategy1Timeframe,
} = require("../../packages/strategies/intraday/strategy1Timeframe");

function makeMinuteBar(barTime, open, high, low, close) {
  return {
    date: String(barTime).slice(0, 10),
    barTime,
    open,
    high,
    low,
    close,
  };
}

describe("strategy1Timeframe", () => {
  it("defaults missing or invalid timeframe values to 1day and normalizes aliases", () => {
    expect(normalizeStrategy1Timeframe()).toBe("1day");
    expect(normalizeStrategy1Timeframe("invalid")).toBe("1day");
    expect(normalizeStrategy1Timeframe("1m")).toBe("1min");
    expect(normalizeStrategy1Timeframe("5m")).toBe("5min");
    expect(normalizeStrategy1Timeframe("15m")).toBe("15min");
    expect(normalizeStrategy1Timeframe("daily")).toBe("1day");
  });

  it("aggregates minute bars into 5-minute buckets", () => {
    const bars = [
      makeMinuteBar("2026-03-24T09:15:00+05:30", 100, 101, 99, 100),
      makeMinuteBar("2026-03-24T09:16:00+05:30", 100, 102, 99, 101),
      makeMinuteBar("2026-03-24T09:17:00+05:30", 101, 103, 100, 102),
      makeMinuteBar("2026-03-24T09:18:00+05:30", 102, 104, 101, 103),
      makeMinuteBar("2026-03-24T09:19:00+05:30", 103, 105, 102, 104),
      makeMinuteBar("2026-03-24T09:20:00+05:30", 104, 106, 103, 105),
    ];

    const aggregated = aggregateStrategy1Bars(bars, "5min");

    expect(aggregated).toEqual([
      expect.objectContaining({
        date: "2026-03-24",
        barTime: "2026-03-24T09:15:00+05:30",
        signalAnchorTime: "2026-03-24T09:15:00+05:30",
        open: 100,
        high: 105,
        low: 99,
        close: 104,
      }),
      expect.objectContaining({
        date: "2026-03-24",
        barTime: "2026-03-24T09:20:00+05:30",
        signalAnchorTime: "2026-03-24T09:20:00+05:30",
        open: 104,
        high: 106,
        low: 103,
        close: 105,
      }),
    ]);
  });

  it("opens daily evaluation only in the 15:00-15:15 IST window and keeps a stable day anchor", () => {
    const beforeWindow = buildStrategy1EvaluationContext({
      minuteBars: [
        makeMinuteBar("2026-03-24T14:59:00+05:30", 100, 101, 99, 100),
      ],
      timeframe: "1day",
    });

    expect(beforeWindow.evaluationEligible).toBe(false);
    expect(beforeWindow.reason).toBe("evaluation_window_closed");

    const inWindow = buildStrategy1EvaluationContext({
      minuteBars: [
        makeMinuteBar("2026-03-24T14:59:00+05:30", 100, 101, 99, 100),
        makeMinuteBar("2026-03-24T15:00:00+05:30", 100, 102, 99, 101),
      ],
      timeframe: "1day",
    });

    expect(inWindow.evaluationEligible).toBe(true);
    expect(inWindow.latestBar).toEqual(
      expect.objectContaining({
        barTime: "2026-03-24T15:00:00+05:30",
        signalAnchorTime: "2026-03-24T09:15:00+05:30",
      }),
    );
  });

  it("blocks BUY entries when the decision price is below session VWAP", () => {
    const evaluation = applyStrategy1VwapGate(
      {
        action: "BUY",
        reason: "consecutive_red_entry",
        referencePrice: 100,
      },
      {
        decisionPrice: 100,
        latestVwapPoint: { vwap: 101.25 },
      },
    );

    expect(evaluation).toEqual(
      expect.objectContaining({
        action: null,
        reason: "vwap_entry_blocked",
        vwapGatePassed: false,
      }),
    );
  });

  it("resets session VWAP at the start of each trading day", () => {
    const series = calculateSessionVwapSeries([
      {
        date: "2026-03-24",
        barTime: "2026-03-24T15:00:00+05:30",
        high: 102,
        low: 98,
        close: 100,
        volume: 100,
      },
      {
        date: "2026-03-25",
        barTime: "2026-03-25T09:15:00+05:30",
        high: 202,
        low: 198,
        close: 200,
        volume: 100,
      },
    ]);

    expect(series).toEqual([
      expect.objectContaining({
        date: "2026-03-24",
        vwap: 100,
      }),
      expect.objectContaining({
        date: "2026-03-25",
        vwap: 200,
      }),
    ]);
  });

  it("does not reuse the previous session VWAP when the current day has no volume", () => {
    const series = calculateSessionVwapSeries([
      {
        date: "2026-03-24",
        barTime: "2026-03-24T15:00:00+05:30",
        high: 102,
        low: 98,
        close: 100,
        volume: 100,
      },
      {
        date: "2026-03-25",
        barTime: "2026-03-25T09:15:00+05:30",
        high: 202,
        low: 198,
        close: 200,
        volume: 0,
      },
    ]);

    const latestVwapPoint = getLatestSessionVwapPoint(series, {
      date: "2026-03-25",
      barTime: "2026-03-25T09:15:00+05:30",
    });

    expect(latestVwapPoint).toBeNull();
  });

});
