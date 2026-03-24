const { query } = require("./postgresClient");

const capabilityCache = new Map();

const CAPABILITY_LOADERS = {
  strategy_instance_runtime_state: async () => {
    return hasColumn("strategy_instances", "runtime_state");
  },
  signal_extended_columns: async () => {
    const [hasTriggerBarTime, hasSignalFingerprint] = await Promise.all([
      hasColumn("signals", "trigger_bar_time"),
      hasColumn("signals", "signal_fingerprint"),
    ]);

    return hasTriggerBarTime && hasSignalFingerprint;
  },
};

async function hasColumn(tableName, columnName) {
  const result = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName],
  );

  return result.rows.length > 0;
}

async function getSchemaCapability(name) {
  if (capabilityCache.has(name)) {
    return capabilityCache.get(name);
  }

  const loader = CAPABILITY_LOADERS[name];
  if (!loader) {
    return false;
  }

  const supported = await loader();
  capabilityCache.set(name, supported);
  return supported;
}

function markSchemaCapabilitySupported(name) {
  capabilityCache.set(name, true);
}

function markSchemaCapabilityUnsupported(name) {
  capabilityCache.set(name, false);
}

function resetSchemaCapabilityCache() {
  capabilityCache.clear();
}

module.exports = {
  getSchemaCapability,
  markSchemaCapabilitySupported,
  markSchemaCapabilityUnsupported,
  resetSchemaCapabilityCache,
};
