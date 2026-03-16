const { evaluateStrategy1 } = require("../src/strategies/intraday/strategy1Core");

describe("strategy1Core", () => {
  it("emits a BUY decision when NIFTYBANK reaches five consecutive red bars", () => {
    const bars = [
      { date: "2026-03-01", open: 100, high: 101, low: 98, close: 99 },
      { date: "2026-03-02", open: 99, high: 100, low: 97, close: 98 },
      { date: "2026-03-03", open: 98, high: 99, low: 96, close: 97 },
      { date: "2026-03-04", open: 97, high: 98, low: 95, close: 96 },
      { date: "2026-03-05", open: 96, high: 97, low: 94, close: 95 },
    ];

    const result = evaluateStrategy1(
      bars,
      { inPosition: false, lastEvaluatedDate: null, symbol: "NIFTYBANK" },
      { ticker: "NIFTYBANK" },
    );

    expect(result.action).toBe("BUY");
    expect(result.entryDate).toBe("2026-03-05");
    expect(result.referencePrice).toBe(95);
  });

  it("emits a SELL decision when the ATR trailing stop is broken", () => {
    const bars = [
      { date: "2026-03-01", open: 100, high: 102, low: 99, close: 101 },
      { date: "2026-03-02", open: 101, high: 104, low: 100, close: 103 },
      { date: "2026-03-03", open: 103, high: 106, low: 102, close: 105 },
      { date: "2026-03-04", open: 105, high: 108, low: 104, close: 107 },
      { date: "2026-03-05", open: 107, high: 110, low: 106, close: 109 },
      { date: "2026-03-06", open: 109, high: 111, low: 95, close: 99 },
    ];

    const result = evaluateStrategy1(
      bars,
      {
        inPosition: true,
        entryDate: "2026-03-05",
        lastEvaluatedDate: null,
        symbol: "NIFTYBANK",
      },
      { ticker: "NIFTYBANK" },
    );

    expect(result.action).toBe("SELL");
    expect(result.reason).toBe("atr_trailing_exit");
    expect(result.trailingStop).toBe(100.4);
  });
});
