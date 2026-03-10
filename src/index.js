require('dotenv').config();
const config = require('../config/default');
const { logger, childLogger } = require('./core/logger/logger');
const { getRedisClient } = require('./core/eventBus/redisClient');
const { healthCheck: dbHealthCheck, close: closeDb } = require('./database/postgresClient');

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
    timestamp: new Date().toISOString(),
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
  
  console.log('='.repeat(50));
  console.log('Algo Trading Platform - Health Check');
  console.log('='.repeat(50));

  try {
    const results = await checkAll();
    
    console.log('\nHealth Status:', results.status.toUpperCase());
    console.log('Uptime:', results.uptime.toFixed(2), 'seconds');
    console.log('\nService Status:');
    
    results.services.forEach(service => {
      const status = service.status === 'online' ? '✓' : '✗';
      console.log(`  ${status} ${service.service}: ${service.status}`);
      if (service.error) {
        console.log(`    Error: ${service.error}`);
      }
    });

    console.log('='.repeat(50));

    await cleanup();
    process.exit(results.status === 'healthy' ? 0 : 1);
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    await cleanup();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkAll, checkPostgres, checkRedis, cleanup };
