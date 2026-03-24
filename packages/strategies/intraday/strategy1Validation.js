const { evaluateStrategy1 } = require("./strategy1Core");
const { formatIST, getTodayIST, getISTParts } = require("../../core/utils/time");

function toBarTime(value) {
  const formatted = formatIST(value);
  if (!formatted) {
    return null;
  }

  return formatted.replace(/\.\d{3}\+05:30$/, "+05:30");
}

function toMinuteKey(value) {
  const barTime = typeof value === "string" && value.includes("T")
    ? toBarTime(new Date(value)) || value
    : toBarTime(value);

  return barTime ? barTime.slice(0, 16) : null;
}

function inspectCandleContinuity(bars = []) {
  const gaps = [];

  for (let index = 1; index < bars.length; index += 1) {
    const previous = new Date(bars[index - 1].barTime);
    const current = new Date(bars[index].barTime);
    const diffMinutes = Math.round((current.getTime() - previous.getTime()) / 60000);

    if (diffMinutes > 1) {
      gaps.push({
        fromBarTime: bars[index - 1].barTime,
        toBarTime: bars[index].barTime,
        missingMinutes: diffMinutes - 1,
      });
    }
  }

  return {
    count: bars.length,
    firstBarTime: bars[0]?.barTime || null,
    lastBarTime: bars[bars.length - 1]?.barTime || null,
    gapCount: gaps.length,
    totalMissingMinutes: gaps.reduce((sum, gap) => sum + gap.missingMinutes, 0),
    gaps,
  };
}

function replayStrategy1Session({ bars = [], symbol = "NIFTY 50", fixedMax = true, maxRed = 3 } = {}) {
  const normalizedBars = (bars || []).map((bar) => ({
    barTime: bar.barTime,
    date: bar.date || String(bar.barTime || "").slice(0, 10),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
  }));

  const state = {
    inPosition: false,
    entryDate: null,
    lastEvaluatedDate: null,
    symbol,
  };

  const events = [];
  const timeline = [];

  normalizedBars.forEach((bar, index) => {
    const evaluation = evaluateStrategy1(
      normalizedBars.slice(0, index + 1),
      state,
      { ticker: symbol, fixedMax, maxRed },
    );

    const indicators = evaluation.indicators || {};
    const latestIndex = index;
    const redCount = indicators.redCounts?.[latestIndex] ?? null;
    const atr = indicators.atr?.[latestIndex] ?? null;
    const trailingBase = indicators.trailingBase?.[latestIndex] ?? null;

    timeline.push({
      barTime: bar.barTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      action: evaluation.action || null,
      reason: evaluation.reason || null,
      redCount,
      atr: atr == null ? null : Math.round(Number(atr) * 100) / 100,
      trailingBase:
        trailingBase == null ? null : Math.round(Number(trailingBase) * 100) / 100,
      trailingStop:
        evaluation.trailingStop == null
          ? null
          : Math.round(Number(evaluation.trailingStop) * 100) / 100,
      referencePrice:
        evaluation.referencePrice == null
          ? null
          : Math.round(Number(evaluation.referencePrice) * 100) / 100,
    });

    if (evaluation.action === "BUY" || evaluation.action === "SELL") {
      events.push({
        barTime: bar.barTime,
        action: evaluation.action,
        reason: evaluation.reason,
        price: evaluation.referencePrice ?? bar.close,
      });
    }

    if (evaluation.action === "BUY") {
      state.inPosition = true;
      state.entryDate = evaluation.entryDate || bar.barTime;
    } else if (evaluation.action === "SELL") {
      state.inPosition = false;
      state.entryDate = null;
    }

    state.lastEvaluatedDate = bar.barTime;
  });

  return {
    symbol,
    events,
    timeline,
  };
}

function compareStrategy1Session({ replay, actualSignals = [], actualOrders = [] }) {
  const mismatches = [];
  const matchedSignalIds = new Set();
  const matchedOrderIds = new Set();
  const signalBuckets = new Map();

  actualSignals.forEach((signal) => {
    const key = `${signal.action}:${toMinuteKey(signal.trigger_bar_time || signal.timestamp)}`;
    const bucket = signalBuckets.get(key) || [];
    bucket.push(signal);
    signalBuckets.set(key, bucket);
  });

  let matchedSignals = 0;
  let missingSignals = 0;
  let missingOrders = 0;
  let failedOrders = 0;

  replay.events.forEach((event) => {
    const key = `${event.action}:${toMinuteKey(event.barTime)}`;
    const candidates = signalBuckets.get(key) || [];
    const actualSignal = candidates.find((signal) => !matchedSignalIds.has(signal.id));

    if (!actualSignal) {
      missingSignals += 1;
      mismatches.push({
        kind: "missing_signal",
        barTime: event.barTime,
        expectedAction: event.action,
        actualAction: null,
        orderStatus: null,
        note: `Replay emitted ${event.action} but no recorded signal exists for this candle.`,
      });
      return;
    }

    matchedSignals += 1;
    matchedSignalIds.add(actualSignal.id);

    const matchingOrder = actualOrders.find(
      (order) => String(order.event_id) === String(actualSignal.event_id),
    );

    if (!matchingOrder) {
      missingOrders += 1;
      mismatches.push({
        kind: "missing_order",
        barTime: event.barTime,
        expectedAction: event.action,
        actualAction: actualSignal.action,
        orderStatus: null,
        note: `Signal ${actualSignal.event_id} exists but no order was recorded for it.`,
      });
      return;
    }

    matchedOrderIds.add(matchingOrder.id);

    if (["rejected", "failed", "cancelled"].includes(String(matchingOrder.status || "").toLowerCase())) {
      failedOrders += 1;
      mismatches.push({
        kind: "order_not_completed",
        barTime: event.barTime,
        expectedAction: event.action,
        actualAction: actualSignal.action,
        orderStatus: matchingOrder.status,
        note: `Order ${matchingOrder.id} ended as ${matchingOrder.status}.`,
      });
    }
  });

  actualSignals
    .filter((signal) => !matchedSignalIds.has(signal.id))
    .forEach((signal) => {
      mismatches.push({
        kind: "extra_signal",
        barTime: signal.trigger_bar_time || signal.timestamp,
        expectedAction: null,
        actualAction: signal.action,
        orderStatus: null,
        note: `Recorded ${signal.action} signal has no replay match for this candle.`,
      });
    });

  actualOrders
    .filter((order) => !matchedOrderIds.has(order.id))
    .forEach((order) => {
      mismatches.push({
        kind: "extra_order",
        barTime: order.created_at,
        expectedAction: null,
        actualAction: order.side,
        orderStatus: order.status,
        note: `Order ${order.id} has no matched replay signal.`,
      });
    });

  const extraSignals = actualSignals.length - matchedSignals;
  const extraOrders = actualOrders.length - matchedOrderIds.size;
  const verdict =
    missingSignals > 0 || extraSignals > 0
      ? "FAIL"
      : missingOrders > 0 || failedOrders > 0 || extraOrders > 0
        ? "WARN"
        : "PASS";

  return {
    verdict,
    summary: {
      replaySignals: replay.events.length,
      actualSignals: actualSignals.length,
      actualOrders: actualOrders.length,
      matchedSignals,
      missingSignals,
      extraSignals,
      missingOrders,
      failedOrders,
      extraOrders,
    },
    mismatches,
  };
}

function isValidationWindowOpen(tradeDate, now = new Date()) {
  const todayIst = getTodayIST();
  if (!tradeDate || tradeDate !== todayIst) {
    return true;
  }

  const parts = getISTParts(now);
  if (!parts) {
    return false;
  }

  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  return currentMinutes >= 16 * 60 + 15;
}

module.exports = {
  compareStrategy1Session,
  inspectCandleContinuity,
  isValidationWindowOpen,
  replayStrategy1Session,
  toBarTime,
  toMinuteKey,
};
