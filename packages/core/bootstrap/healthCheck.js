require("./loadEnv").loadEnv();
const { childLogger } = require("../logger/logger");
const { getRedisClient } = require("../eventBus/redisClient");
const { healthCheck: dbHealthCheck, close: closeDb } = require("../../database/postgresClient");
const { formatIST } = require("../utils/time");

const serviceName = process.env.SERVICE_NAME || 'health-check';
const logger = childLogger(serviceName);

let redisInstance = null;

async function getRedis() {
  if (!redisInstance) {
    redisInstance = getRedisClient();
    await redisInstance.connect();
  }
  return redisInstance;
}

async function checkPostgres() {
  const result = await dbHealthCheck();
  return {
    service: 'postgres',
    ...result
  };
}

async function checkRedis() {
  try {
    const redis = await getRedis();
    const result = await redis.healthCheck();
    return {
      service: 'redis',
      ...result
    };
  } catch (error) {
    return {
      service: 'redis',
      status: 'offline',
      error: error.message
    };
  }
}

async function checkAll() {
  logger.info('Running health checks...');

  const results = {
    timestamp: formatIST(),
    uptime: process.uptime(),
    services: []
  };

  const [postgres, redis] = await Promise.all([
    checkPostgres(),
    checkRedis()
  ]);

  results.services.push(postgres, redis);

  const allHealthy = results.services.every(s => s.status === 'online');
  results.status = allHealthy ? 'healthy' : 'degraded';

  logger.info('Health check completed', { status: results.status });

  return results;
}

async function cleanup() {
  try {
    if (redisInstance) {
      await redisInstance.disconnect();
    }
    await closeDb();
  } catch (error) {
    logger.error('Cleanup error', { error: error.message });
  }
}

function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down...`);
    await cleanup();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function main() {
  setupGracefulShutdown();

  logger.info({ event: 'health_check_start', service: serviceName }, 'Algo Trading Platform - Health Check starting');

  try {
    const results = await checkAll();

    logger.info({
      event: 'health_check_result',
      service: serviceName,
      status: results.status,
      uptime_seconds: parseFloat(results.uptime.toFixed(2)),
      services: results.services.map(s => ({ name: s.service, status: s.status, error: s.error || null })),
      timestamp_utc: new Date().toISOString(),
    }, `Health check completed: ${results.status.toUpperCase()}`);

    await cleanup();
    process.exit(results.status === 'healthy' ? 0 : 1);
  } catch (error) {
    logger.error({ event: 'health_check_failed', service: serviceName, error: error.message }, 'Health check failed');
    await cleanup();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkAll, checkPostgres, checkRedis, cleanup };
