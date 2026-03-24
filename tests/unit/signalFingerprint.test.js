const {
  buildSignalFingerprint,
  getSignalFingerprint,
} = require("../../packages/core/utils/signalFingerprint");

describe("signalFingerprint", () => {
  it("builds a stable fingerprint for the same signal trigger", () => {
    const first = buildSignalFingerprint({
      strategyInstanceId: 12,
      symbol: "NIFTY 50",
      action: "BUY",
      triggerBarTime: "2026-03-20T10:05:00+05:30",
    });
    const second = buildSignalFingerprint({
      strategyInstanceId: 12,
      symbol: "nifty 50",
      action: "buy",
      triggerBarTime: "2026-03-20T10:05:00+05:30",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes the fingerprint when the trigger bar changes", () => {
    const first = buildSignalFingerprint({
      strategyInstanceId: 12,
      symbol: "NIFTY 50",
      action: "BUY",
      triggerBarTime: "2026-03-20T10:05:00+05:30",
    });
    const second = buildSignalFingerprint({
      strategyInstanceId: 12,
      symbol: "NIFTY 50",
      action: "BUY",
      triggerBarTime: "2026-03-20T10:06:00+05:30",
    });

    expect(first).not.toBe(second);
  });

  it("derives the fingerprint from a signal payload", () => {
    const fingerprint = getSignalFingerprint({
      strategy_instance_id: 12,
      symbol: "NIFTY 50",
      action: "SELL",
      metadata: {
        trigger_bar_time: "2026-03-20T15:15:00+05:30",
      },
    });

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
