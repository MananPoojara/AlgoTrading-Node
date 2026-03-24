/**
 * Startup Reconciliation
 *
 * Runs before any strategy worker starts.  Reconciles:
 *   1. Open positions from Angel One REST API vs PostgreSQL
 *   2. Loads verified positions into Redis cache
 *   3. Restores ATR trailing-stop values into Redis from persisted runtime_state
 *
 * In paper mode the broker-side fetch is skipped (no live positions exist),
 * but the DB→Redis load still runs so strategy workers can read fast path.
 */

require('./loadEnv').loadEnv();
const { childLogger } = require('../logger/logger');
const { query } = require('../../database/postgresClient');
const { getRedisClient } = require('../eventBus/redisClient');
const config = require('../../../config/default');

const logger = childLogger('reconcile');

const POSITION_KEY = (instanceId, instrument) =>
  `position:${instanceId}:${instrument}`;
const ATR_STOP_KEY = (instanceId) => `atr_stop:${instanceId}`;
const POSITION_TTL_SECONDS = 8 * 60 * 60; // 8 hours — covers full trading day

async function fetchBrokerPositions(brokerApi) {
  try {
    const result = await brokerApi.getPositions();
    if (!result.success) {
      logger.warn('Failed to fetch broker positions for reconciliation', {
        event: 'reconcile_broker_fetch_failed',
        error: result.error,
        timestamp_utc: new Date().toISOString(),
      });
      return [];
    }
    return (result.positions || []).filter(
      (p) => Number(p.netqty || p.netQuantity || 0) !== 0,
    );
  } catch (error) {
    logger.warn('Exception fetching broker positions for reconciliation', {
      event: 'reconcile_broker_exception',
      error: error.message,
      timestamp_utc: new Date().toISOString(),
    });
    return [];
  }
}

async function fetchDbPositions() {
  const result = await query(
    `SELECT
       p.id,
       p.client_id,
       p.strategy_instance_id,
       p.instrument,
       p.position,
       p.average_price,
       p.updated_at,
       si.runtime_state
     FROM positions p
     LEFT JOIN strategy_instances si ON si.id = p.strategy_instance_id
     WHERE p.position != 0
     ORDER BY p.strategy_instance_id, p.instrument`,
  );
  return result.rows;
}

function normalizeBrokerSymbol(position) {
  return String(
    position.tradingsymbol || position.symbol || position.token || '',
  ).toUpperCase();
}

function detectOrphans(brokerPositions, dbPositions) {
  const dbSymbols = new Set(
    dbPositions.map((p) => String(p.instrument || '').toUpperCase()),
  );

  return brokerPositions.filter((bp) => {
    const symbol = normalizeBrokerSymbol(bp);
    return symbol && !dbSymbols.has(symbol);
  });
}

async function loadPositionsIntoRedis(redis, dbPositions) {
  let loaded = 0;

  for (const pos of dbPositions) {
    if (!pos.strategy_instance_id || !pos.instrument) {
      continue;
    }

    const key = POSITION_KEY(pos.strategy_instance_id, pos.instrument);
    const value = JSON.stringify({
      clientId: pos.client_id,
      instanceId: pos.strategy_instance_id,
      instrument: pos.instrument,
      position: Number(pos.position),
      averagePrice: Number(pos.average_price),
      updatedAt: pos.updated_at,
    });

    await redis.set(key, value, POSITION_TTL_SECONDS);
    loaded++;
  }

  return loaded;
}

async function loadAtrStopsIntoRedis(redis, dbPositions) {
  let loaded = 0;
  const seenInstances = new Set();

  for (const pos of dbPositions) {
    if (!pos.strategy_instance_id || seenInstances.has(pos.strategy_instance_id)) {
      continue;
    }

    seenInstances.add(pos.strategy_instance_id);

    let runtimeState = null;
    try {
      runtimeState =
        typeof pos.runtime_state === 'string'
          ? JSON.parse(pos.runtime_state)
          : pos.runtime_state;
    } catch {
      continue;
    }

    const trailingStop = runtimeState?.entryContext?.trailingStop;
    if (trailingStop == null) {
      continue;
    }

    const key = ATR_STOP_KEY(pos.strategy_instance_id);
    const value = JSON.stringify({
      instanceId: pos.strategy_instance_id,
      instrument: pos.instrument,
      trailingStop: Number(trailingStop),
      restoredAt: new Date().toISOString(),
    });

    await redis.set(key, value, POSITION_TTL_SECONDS);
    loaded++;
  }

  return loaded;
}

/**
 * Run startup reconciliation.
 *
 * @param {object} options
 * @param {object|null} [options.brokerApi] - Connected AngelOneBrokerAPI instance.
 *   If null or paper mode, broker reconciliation is skipped.
 * @returns {Promise<{orphans: number, positionsLoaded: number, atrStopsLoaded: number}>}
 */
async function runStartupReconciliation(options = {}) {
  const { brokerApi = null } = options;
  const isPaper = config.paperMode !== false;

  logger.info('Starting startup reconciliation', {
    event: 'reconcile_start',
    paperMode: isPaper,
    timestamp_utc: new Date().toISOString(),
  });

  const redis = getRedisClient();

  // 1. Fetch open positions from DB (always)
  const dbPositions = await fetchDbPositions();

  logger.info('DB open positions loaded', {
    event: 'reconcile_db_positions',
    count: dbPositions.length,
    instances: [...new Set(dbPositions.map((p) => p.strategy_instance_id))],
    timestamp_utc: new Date().toISOString(),
  });

  // 2. Broker reconciliation (live mode only)
  let orphans = 0;
  if (!isPaper && brokerApi) {
    const brokerPositions = await fetchBrokerPositions(brokerApi);

    logger.info('Broker open positions fetched', {
      event: 'reconcile_broker_positions',
      count: brokerPositions.length,
      timestamp_utc: new Date().toISOString(),
    });

    const orphanedPositions = detectOrphans(brokerPositions, dbPositions);
    orphans = orphanedPositions.length;

    if (orphanedPositions.length > 0) {
      logger.error('ORPHANED POSITIONS DETECTED — broker has positions not in DB', {
        event: 'reconcile_orphaned_positions',
        count: orphanedPositions.length,
        positions: orphanedPositions.map((p) => ({
          symbol: normalizeBrokerSymbol(p),
          qty: p.netqty || p.netQuantity,
          product: p.producttype || p.product,
        })),
        action_required: 'Manual review required before proceeding',
        timestamp_utc: new Date().toISOString(),
      });
    } else {
      logger.info('Broker reconciliation clean — no orphaned positions', {
        event: 'reconcile_no_orphans',
        timestamp_utc: new Date().toISOString(),
      });
    }
  } else if (isPaper) {
    logger.info('Paper mode — broker reconciliation skipped', {
      event: 'reconcile_paper_mode_skip',
      timestamp_utc: new Date().toISOString(),
    });
  }

  // 3. Load verified DB positions into Redis
  const positionsLoaded = await loadPositionsIntoRedis(redis, dbPositions);

  // 4. Restore ATR trailing stops into Redis
  const atrStopsLoaded = await loadAtrStopsIntoRedis(redis, dbPositions);

  logger.info('Startup reconciliation complete', {
    event: 'reconcile_complete',
    dbPositions: dbPositions.length,
    orphans,
    positionsLoaded,
    atrStopsLoaded,
    timestamp_utc: new Date().toISOString(),
  });

  return { orphans, positionsLoaded, atrStopsLoaded };
}

module.exports = { runStartupReconciliation };
