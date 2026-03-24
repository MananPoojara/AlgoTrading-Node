const { evaluateSchedulerWindow } = require("../../packages/automation/marketClock");

describe("marketClock", () => {
  it("evaluates the configured feed and strategy windows in IST", () => {
    const schedule = {
      feedStart: "09:00",
      strategyStart: "09:15",
      squareOff: "15:15",
      strategyPause: "15:45",
      feedStop: "16:10",
    };

    expect(
      evaluateSchedulerWindow(new Date("2026-03-16T03:45:00.000Z"), schedule),
    ).toMatchObject({
      feedShouldRun: true,
      strategiesShouldRun: true,
      squareOffShouldRun: false,
      archiveShouldRun: false,
      tradingDate: "2026-03-16",
    });

    expect(
      evaluateSchedulerWindow(new Date("2026-03-16T10:20:00.000Z"), schedule),
    ).toMatchObject({
      feedShouldRun: true,
      strategiesShouldRun: false,
      squareOffShouldRun: true,
      archiveShouldRun: false,
    });

    expect(
      evaluateSchedulerWindow(new Date("2026-03-16T10:45:00.000Z"), schedule),
    ).toMatchObject({
      feedShouldRun: false,
      strategiesShouldRun: false,
      squareOffShouldRun: false,
      archiveShouldRun: true,
    });
  });
});
