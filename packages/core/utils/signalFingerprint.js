const crypto = require("crypto");

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function getSignalTriggerBarTime(signal = {}) {
  return (
    signal.trigger_bar_time ||
    signal.triggerBarTime ||
    signal.metadata?.trigger_bar_time ||
    null
  );
}

function buildSignalFingerprint({
  strategyInstanceId,
  symbol,
  action,
  triggerBarTime,
} = {}) {
  if (!strategyInstanceId || !symbol || !action || !triggerBarTime) {
    return null;
  }

  const rawFingerprint = [
    Number(strategyInstanceId),
    normalizeText(symbol),
    normalizeText(action),
    String(triggerBarTime),
  ].join("|");

  return crypto.createHash("sha256").update(rawFingerprint).digest("hex");
}

function getSignalFingerprint(signal = {}) {
  return (
    signal.signal_fingerprint ||
    buildSignalFingerprint({
      strategyInstanceId: signal.strategy_instance_id,
      symbol: signal.symbol,
      action: signal.action,
      triggerBarTime: getSignalTriggerBarTime(signal),
    })
  );
}

module.exports = {
  buildSignalFingerprint,
  getSignalFingerprint,
  getSignalTriggerBarTime,
};
