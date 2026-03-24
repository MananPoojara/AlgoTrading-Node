const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { logger } = require('../core/logger/logger');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: process.env.POSTGRES_PORT || 5432,
  database: process.env.POSTGRES_DB || 'algo_trading',
  user: process.env.POSTGRES_USER || 'algo',
  password: process.env.POSTGRES_PASSWORD || 'algo123',
  options: "-c timezone=Asia/Kolkata",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  logger.error('Unexpected database error', { error: err.message });
});

const query = async (text, params = []) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    if (process.env.LOG_SQL === 'true') {
      logger.debug('SQL executed', { text, duration, rows: result.rowCount });
    }
    
    return result;
  } catch (error) {
    logger.error('SQL error', { text, error: error.message });
    throw error;
  }
};

const getClient = async () => {
  return await pool.connect();
};

const healthCheck = async () => {
  try {
    const result = await query('SELECT NOW() as now, version() as version');
    return { 
      status: 'online', 
      timestamp: result.rows[0].now,
      version: result.rows[0].version 
    };
  } catch (error) {
    return { status: 'offline', error: error.message };
  }
};

const close = async () => {
  await pool.end();
  logger.info('Database pool closed');
};

const runMigrations = async (migrationsPath) => {
  // Ensure schema_migrations tracking table exists (idempotent)
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  const files = fs.readdirSync(migrationsPath)
    .filter(f => f.endsWith('.sql'))
    .sort();

  logger.info('Found migration files', { count: files.length });

  // Fetch already-applied migrations
  const appliedResult = await query(`SELECT filename FROM schema_migrations`);
  const applied = new Set(appliedResult.rows.map(r => r.filename));

  let newCount = 0;

  for (const file of files) {
    if (applied.has(file)) {
      logger.info('Migration already applied — skipping', { file });
      continue;
    }

    logger.info('Running migration', { file });
    const filePath = path.join(migrationsPath, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    try {
      await query(sql);
      await query(
        `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
        [file],
      );
      logger.info('Migration completed', { file });
      newCount++;
    } catch (error) {
      logger.error('Migration failed', { file, error: error.message });
      throw error;
    }
  }

  logger.info('All migrations processed', { total: files.length, new: newCount, skipped: files.length - newCount });
  return { success: true, count: newCount };
};

const createDatabase = async () => {
  const dbName = process.env.POSTGRES_DB || 'algo_trading';
  const adminUser = process.env.POSTGRES_USER || 'algo';
  const adminPassword = process.env.POSTGRES_PASSWORD || 'algo123';
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || 5432;

  const adminPool = new Pool({
    host,
    port,
    database: 'postgres',
    user: adminUser,
    password: adminPassword,
    options: "-c timezone=Asia/Kolkata",
    max: 1
  });

  try {
    const result = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (result.rows.length === 0) {
      const safeDbName = dbName.replace(/[^a-zA-Z0-9_]/g, '');
      await adminPool.query(`CREATE DATABASE "${safeDbName}"`);
      logger.info(`Database ${safeDbName} created`);
    }
  } catch (error) {
    logger.error('Failed to create database', { error: error.message });
    throw error;
  } finally {
    await adminPool.end();
  }
};

module.exports = {
  pool,
  query,
  getClient,
  healthCheck,
  close,
  runMigrations,
  createDatabase
};
