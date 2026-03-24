const { formatIST, getTodayIST } = require("../../packages/core/utils/time");

describe("time utils", () => {
  it("formats timestamps in IST with +05:30 offset", () => {
    expect(formatIST(new Date("2026-03-17T04:30:15.123Z"))).toBe(
      "2026-03-17T10:00:15.123+05:30",
    );
  });

  it("returns the IST calendar date", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-03-17T20:30:00.000Z"));

    expect(getTodayIST()).toBe("2026-03-18");

    jest.useRealTimers();
  });
});
