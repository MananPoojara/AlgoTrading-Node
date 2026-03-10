require('dotenv').config();
const { pool, runMigrations, createDatabase } = require('./postgresClient');
const { logger } = require('../core/logger/logger');
const path = require('path');

const migrationsPath = path.join(__dirname, 'migrations');

async function main() {
  logger.info('Starting database migration...');

  try {
    logger.info('Ensuring database exists...');
    await createDatabase();

    logger.info('Running migrations...');
    const result = await runMigrations(migrationsPath);

    logger.info('Migration completed successfully', { count: result.count });
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

main();
