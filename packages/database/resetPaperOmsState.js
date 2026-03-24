require("../core/bootstrap/loadEnv").loadEnv();

const { logger } = require("../core/logger/logger");
const { query, close } = require("./postgresClient");

const PAPER_OMS_RESET_TABLES = [
  "order_events",
  "trades",
  "orders",
  "signals",
  "positions",
  "portfolio_snapshots",
];

function buildResetPaperOmsSql() {
  return `
    BEGIN;
    TRUNCATE TABLE ${PAPER_OMS_RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE;
    COMMIT;
  `;
}

async function fetchTableCounts(dbQuery) {
  const counts = {};

  for (const tableName of PAPER_OMS_RESET_TABLES) {
    const result = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
    counts[tableName] = Number(result.rows[0]?.count || 0);
  }

  return counts;
}

async function resetPaperOmsState(options = {}) {
  const dbQuery = options.query || query;
  const beforeCounts = await fetchTableCounts(dbQuery);

  logger.info("Resetting paper OMS state", {
    tables: PAPER_OMS_RESET_TABLES,
    beforeCounts,
  });

  await dbQuery(buildResetPaperOmsSql());

  const afterCounts = await fetchTableCounts(dbQuery);

  logger.info("Paper OMS reset completed", {
    tables: PAPER_OMS_RESET_TABLES,
    afterCounts,
  });

  return {
    tables: [...PAPER_OMS_RESET_TABLES],
    beforeCounts,
    afterCounts,
  };
}

module.exports = {
  PAPER_OMS_RESET_TABLES,
  buildResetPaperOmsSql,
  fetchTableCounts,
  resetPaperOmsState,
};

if (require.main === module) {
  resetPaperOmsState()
    .then(async (result) => {
      logger.info("Paper OMS reset summary", result);
      await close();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error("Paper OMS reset failed", { error: error.message });
      try {
        await close();
      } catch (closeError) {
        logger.error("Failed to close database pool after reset error", {
          error: closeError.message,
        });
      }
      process.exit(1);
    });
}
