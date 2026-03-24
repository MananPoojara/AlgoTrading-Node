const {
  PAPER_OMS_RESET_TABLES,
  buildResetPaperOmsSql,
  fetchTableCounts,
  resetPaperOmsState,
} = require("../../packages/database/resetPaperOmsState");

describe("resetPaperOmsState", () => {
  it("builds one truncate statement for all paper OMS tables", () => {
    const sql = buildResetPaperOmsSql();

    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
    expect(sql).toContain(
      `TRUNCATE TABLE ${PAPER_OMS_RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE;`,
    );
  });

  it("reads counts before and after reset", async () => {
    const countsByTable = {
      order_events: [6, 0],
      trades: [4, 0],
      orders: [4, 0],
      signals: [4, 0],
      positions: [2, 0],
      portfolio_snapshots: [3, 0],
    };
    const executedSql = [];

    const mockQuery = jest.fn(async (sql) => {
      const normalizedSql = String(sql).trim();
      executedSql.push(normalizedSql);

      if (normalizedSql.startsWith("SELECT COUNT(*)::int AS count FROM")) {
        const tableName = normalizedSql.split("FROM")[1].trim();
        const count = countsByTable[tableName].shift();
        return { rows: [{ count }] };
      }

      if (normalizedSql.startsWith("BEGIN;")) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    });

    const result = await resetPaperOmsState({ query: mockQuery });

    expect(result.beforeCounts).toEqual({
      order_events: 6,
      trades: 4,
      orders: 4,
      signals: 4,
      positions: 2,
      portfolio_snapshots: 3,
    });
    expect(result.afterCounts).toEqual({
      order_events: 0,
      trades: 0,
      orders: 0,
      signals: 0,
      positions: 0,
      portfolio_snapshots: 0,
    });
    expect(executedSql).toContain(
      `BEGIN;
    TRUNCATE TABLE ${PAPER_OMS_RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE;
    COMMIT;`,
    );
  });

  it("fetches counts in table order", async () => {
    const seen = [];

    const mockQuery = jest.fn(async (sql) => {
      const tableName = String(sql).split("FROM")[1].trim();
      seen.push(tableName);
      return { rows: [{ count: 0 }] };
    });

    await fetchTableCounts(mockQuery);

    expect(seen).toEqual(PAPER_OMS_RESET_TABLES);
  });
});
