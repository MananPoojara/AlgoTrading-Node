const {
  DEFAULT_LOG_LEVELS,
  filterLogRecordsByLevels,
  normalizeRequestedLevels,
  normalizeRequestedServices,
  parseDockerLogLine,
} = require("../../apps/api/src/services/dockerOps");

describe("docker ops helpers", () => {
  test("parses docker log lines into normalized records", () => {
    const record = parseDockerLogLine(
      "strategy-engine",
      "2026-03-19T08:42:00.000000000Z 2026-03-19T14:12:00.000+05:30 [algo-trading] error: Strategy failed",
    );

    expect(record).toMatchObject({
      service: "strategy-engine",
      level: "error",
      message: "Strategy failed",
      source: "docker",
      timestamp: "2026-03-19T08:42:00.000000000Z",
    });
    expect(record.id).toContain("strategy-engine");
  });

  test("normalizes requested services to the supported core set", () => {
    expect(
      normalizeRequestedServices(
        "strategy-engine,unknown,api-server,market-data-service",
      ),
    ).toEqual(["strategy-engine", "api-server", "market-data-service"]);
  });

  test("defaults requested levels to warn and error", () => {
    expect(normalizeRequestedLevels()).toEqual(DEFAULT_LOG_LEVELS);
    expect(normalizeRequestedLevels("info,invalid,error")).toEqual([
      "info",
      "error",
    ]);
  });

  test("filters log records by selected levels", () => {
    const records = [
      { id: "1", level: "info" },
      { id: "2", level: "warn" },
      { id: "3", level: "error" },
    ];

    expect(filterLogRecordsByLevels(records, ["warn", "error"])).toEqual([
      { id: "2", level: "warn" },
      { id: "3", level: "error" },
    ]);
  });
});
