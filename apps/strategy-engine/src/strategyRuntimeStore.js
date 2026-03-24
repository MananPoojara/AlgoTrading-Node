const { query } = require("../../../packages/database/postgresClient");
const {
  getSchemaCapability,
  markSchemaCapabilitySupported,
  markSchemaCapabilityUnsupported,
} = require("../../../packages/database/schemaCapabilities");

const RECOVERABLE_ORDER_STATUSES = [
  "created",
  "validated",
  "queued",
  "sent_to_broker",
  "acknowledged",
];

function cloneContext(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return JSON.parse(JSON.stringify(value));
}

function normalizeRuntimeState(runtimeState = {}) {
  const entryCtx = cloneContext(runtimeState.entryContext);

  // Preserve persisted trailingStop inside entryContext so ATR state survives
  // restarts even if bar history is incomplete. Value is recomputed from bars
  // on each evaluation and wins over the persisted value when bars are present.
  if (entryCtx && runtimeState.entryContext?.trailingStop != null) {
    entryCtx.trailingStop = Number(runtimeState.entryContext.trailingStop) || null;
  }

  return {
    lastEvaluatedBarTime: runtimeState.lastEvaluatedBarTime || null,
    lastSignalFingerprint: runtimeState.lastSignalFingerprint || null,
    entryContext: entryCtx,
    pendingEntryContext: cloneContext(runtimeState.pendingEntryContext),
    pendingExitContext: cloneContext(runtimeState.pendingExitContext),
  };
}

async function persistStrategyRuntimeState(instanceId, runtimeState = {}) {
  if (!instanceId) {
    return null;
  }

  const normalizedState = normalizeRuntimeState(runtimeState);
  const runtimeStateSupported = await getSchemaCapability(
    "strategy_instance_runtime_state",
  );

  if (!runtimeStateSupported) {
    return normalizedState;
  }

  try {
    await query(
      `UPDATE strategy_instances
       SET runtime_state = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [instanceId, JSON.stringify(normalizedState)],
    );
    markSchemaCapabilitySupported("strategy_instance_runtime_state");
  } catch (error) {
    if (error?.code === "42703") {
      markSchemaCapabilityUnsupported("strategy_instance_runtime_state");
      return normalizedState;
    }
    throw error;
  }

  return normalizedState;
}

async function findInstrumentToken(instrument) {
  if (!instrument) {
    return null;
  }

  const result = await query(
    `SELECT instrument_token
     FROM instruments
     WHERE symbol = $1
     LIMIT 1`,
    [instrument],
  );

  return result.rows[0]?.instrument_token || null;
}

async function loadLatestOpenPosition(instanceId) {
  const result = await query(
    `SELECT instrument, position, average_price, updated_at
     FROM positions
     WHERE strategy_instance_id = $1
       AND position > 0
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [instanceId],
  );

  return result.rows[0] || null;
}

async function loadLatestFilledBuy(instanceId) {
  const signalColumnsSupported = await getSchemaCapability(
    "signal_extended_columns",
  );
  let result;
  if (signalColumnsSupported) {
    try {
      result = await query(
        `SELECT
           o.event_id,
           o.instrument,
           COALESCE(o.average_fill_price, o.average_price, o.price, 0) AS entry_price,
           s.trigger_bar_time
         FROM orders o
         LEFT JOIN signals s ON s.id = o.signal_id
         WHERE o.strategy_instance_id = $1
           AND o.side = 'BUY'
           AND o.status = 'filled'
         ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
         LIMIT 1`,
        [instanceId],
      );
      markSchemaCapabilitySupported("signal_extended_columns");
    } catch (error) {
      if (error?.code !== "42703") {
        throw error;
      }
      markSchemaCapabilityUnsupported("signal_extended_columns");
      result = null;
    }
  }

  if (!result) {
    result = await query(
      `SELECT
         o.event_id,
         o.instrument,
         COALESCE(o.average_fill_price, o.average_price, o.price, 0) AS entry_price,
         NULL::timestamptz AS trigger_bar_time
       FROM orders o
       WHERE o.strategy_instance_id = $1
         AND o.side = 'BUY'
         AND o.status = 'filled'
       ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
       LIMIT 1`,
      [instanceId],
    );
  }

  return result.rows[0] || null;
}

async function loadLatestPendingOrder(instanceId, side) {
  const signalColumnsSupported = await getSchemaCapability(
    "signal_extended_columns",
  );
  let result;
  if (signalColumnsSupported) {
    try {
      result = await query(
        `SELECT
           o.event_id,
           o.instrument,
           o.status,
           COALESCE(o.average_fill_price, o.average_price, o.price, 0) AS reference_price,
           s.trigger_bar_time
         FROM orders o
         LEFT JOIN signals s ON s.id = o.signal_id
         WHERE o.strategy_instance_id = $1
           AND o.side = $2
           AND o.status = ANY($3::text[])
         ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
         LIMIT 1`,
        [instanceId, side, RECOVERABLE_ORDER_STATUSES],
      );
      markSchemaCapabilitySupported("signal_extended_columns");
    } catch (error) {
      if (error?.code !== "42703") {
        throw error;
      }
      markSchemaCapabilityUnsupported("signal_extended_columns");
      result = null;
    }
  }

  if (!result) {
    result = await query(
      `SELECT
         o.event_id,
         o.instrument,
         o.status,
         COALESCE(o.average_fill_price, o.average_price, o.price, 0) AS reference_price,
         NULL::timestamptz AS trigger_bar_time
       FROM orders o
       WHERE o.strategy_instance_id = $1
         AND o.side = $2
         AND o.status = ANY($3::text[])
       ORDER BY o.updated_at DESC NULLS LAST, o.id DESC
       LIMIT 1`,
      [instanceId, side, RECOVERABLE_ORDER_STATUSES],
    );
  }

  return result.rows[0] || null;
}

async function loadStrategyRecoveryState(instanceId, runtimeState = {}) {
  const normalizedState = normalizeRuntimeState(runtimeState);

  if (!instanceId) {
    return normalizedState;
  }

  const [openPosition, latestFilledBuy, pendingBuyOrder, pendingSellOrder] =
    await Promise.all([
      loadLatestOpenPosition(instanceId),
      loadLatestFilledBuy(instanceId),
      loadLatestPendingOrder(instanceId, "BUY"),
      loadLatestPendingOrder(instanceId, "SELL"),
    ]);

  let entryContext = normalizedState.entryContext;
  if (openPosition) {
    const entryInstrument =
      openPosition.instrument ||
      latestFilledBuy?.instrument ||
      normalizedState.entryContext?.instrument ||
      null;

    entryContext = {
      entryDate:
        latestFilledBuy?.trigger_bar_time ||
        normalizedState.entryContext?.entryDate ||
        normalizedState.lastEvaluatedBarTime ||
        null,
      instrument: entryInstrument,
      instrumentToken:
        normalizedState.entryContext?.instrumentToken ||
        (await findInstrumentToken(entryInstrument)),
      entryPrice: Number(
        openPosition.average_price ||
          latestFilledBuy?.entry_price ||
          normalizedState.entryContext?.entryPrice ||
          0,
      ),
    };
  } else {
    entryContext = null;
  }

  let pendingEntryContext = null;
  if (!openPosition && (pendingBuyOrder || normalizedState.pendingEntryContext)) {
    const instrument =
      pendingBuyOrder?.instrument ||
      normalizedState.pendingEntryContext?.instrument ||
      null;

    pendingEntryContext = {
      eventId:
        pendingBuyOrder?.event_id ||
        normalizedState.pendingEntryContext?.eventId ||
        null,
      entryDate:
        pendingBuyOrder?.trigger_bar_time ||
        normalizedState.pendingEntryContext?.entryDate ||
        normalizedState.lastEvaluatedBarTime ||
        null,
      instrument,
      instrumentToken:
        normalizedState.pendingEntryContext?.instrumentToken ||
        (await findInstrumentToken(instrument)),
      entryPrice: Number(
        pendingBuyOrder?.reference_price ||
          normalizedState.pendingEntryContext?.entryPrice ||
          0,
      ),
    };
  }

  let pendingExitContext = null;
  if (entryContext && (pendingSellOrder || normalizedState.pendingExitContext)) {
    const instrument =
      pendingSellOrder?.instrument ||
      normalizedState.pendingExitContext?.instrument ||
      entryContext.instrument;

    pendingExitContext = {
      eventId:
        pendingSellOrder?.event_id ||
        normalizedState.pendingExitContext?.eventId ||
        null,
      instrument,
      reason:
        normalizedState.pendingExitContext?.reason ||
        "recovered_exit_pending",
    };
  }

  return {
    ...normalizedState,
    entryContext,
    pendingEntryContext,
    pendingExitContext,
  };
}

module.exports = {
  normalizeRuntimeState,
  persistStrategyRuntimeState,
  loadStrategyRecoveryState,
};
