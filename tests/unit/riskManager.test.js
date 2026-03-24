const { RiskManager } = require("../../apps/risk-manager/src/riskManager");

describe("RiskManager paper mode behavior", () => {
  it("allows paper signals with warnings in paper_warn_only mode", async () => {
    const manager = new RiskManager({
      policyMode: "paper_warn_only",
      limits: {
        max_position_size: 1,
        max_daily_loss: 1,
        max_exposure: 1,
        max_margin_usage: 0.8,
        max_open_orders: 0,
      },
    });

    manager.circuitBreakerTriggered = true;

    const result = await manager.checkSignal({
      instrument: "NIFTY_OPT",
      action: "BUY",
      quantity: 25,
      price: 100,
    });

    expect(result.allowed).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings.map((warning) => warning.reason)).toEqual(
      expect.arrayContaining([
        "circuit_breaker_triggered",
        "position_limit_exceeded",
        "exposure_limit_exceeded",
        "open_orders_limit_exceeded",
      ]),
    );
  });

  it("does not count a BUY as realized daily loss", async () => {
    const manager = new RiskManager({ policyMode: "paper_warn_only" });

    await manager.onOrderFilled(
      {
        id: 1,
        instrument: "NIFTY_OPT",
        side: "BUY",
        quantity: 25,
      },
      100,
    );

    expect(manager.dailyPnL).toBe(0);
    expect(manager.dailyLoss).toBe(0);
    expect(manager.getPositions().NIFTY_OPT).toBe(25);
  });

  it("records realized loss only when the position is closed at a loss", async () => {
    const manager = new RiskManager({ policyMode: "paper_warn_only" });

    await manager.onOrderFilled(
      {
        id: 1,
        instrument: "NIFTY_OPT",
        side: "BUY",
        quantity: 25,
      },
      100,
    );

    await manager.onOrderFilled(
      {
        id: 2,
        instrument: "NIFTY_OPT",
        side: "SELL",
        quantity: 25,
      },
      90,
    );

    expect(manager.dailyPnL).toBe(-250);
    expect(manager.dailyLoss).toBe(250);
    expect(manager.getPositions().NIFTY_OPT).toBe(0);
  });

  it("nets later realized gains against earlier realized losses for daily loss", async () => {
    const manager = new RiskManager({ policyMode: "paper_warn_only" });

    await manager.onOrderFilled(
      {
        id: 1,
        instrument: "NIFTY_OPT",
        side: "BUY",
        quantity: 25,
      },
      100,
    );

    await manager.onOrderFilled(
      {
        id: 2,
        instrument: "NIFTY_OPT",
        side: "SELL",
        quantity: 25,
      },
      90,
    );

    await manager.onOrderFilled(
      {
        id: 3,
        instrument: "BANKNIFTY_OPT",
        side: "BUY",
        quantity: 25,
      },
      80,
    );

    await manager.onOrderFilled(
      {
        id: 4,
        instrument: "BANKNIFTY_OPT",
        side: "SELL",
        quantity: 25,
      },
      90,
    );

    expect(manager.dailyPnL).toBe(0);
    expect(manager.dailyLoss).toBe(0);
  });

  it("requires operator approval for soft-warn signals in live_enforce mode", async () => {
    const manager = new RiskManager({
      policyMode: "live_enforce",
      limits: {
        max_position_size: 1,
        max_daily_loss: 1,
        max_exposure: 1,
        max_margin_usage: 0.8,
        max_open_orders: 0,
      },
    });

    manager.circuitBreakerTriggered = true;

    const result = await manager.checkSignal({
      instrument: "NIFTY_OPT",
      action: "BUY",
      quantity: 25,
      price: 100,
    });

    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.decision).toBe("soft_warn");
    expect(result.warnings.map((warning) => warning.reason)).toEqual(
      expect.arrayContaining(["circuit_breaker_triggered"]),
    );
  });
});
