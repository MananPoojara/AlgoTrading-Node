const { evaluateStrategy1 } = require("./strategy1Core");
const { formatIST } = require("../../core/utils/time");
const {
  applyStrategy1VwapGate,
  buildStrategy1EvaluationContext,
  calculateSessionVwapSeries,
  normalizeStrategy1Timeframe,
} = require("./strategy1Timeframe");

function toBarTime(value) {
  const formatted = formatIST(value);
  if (!formatted) {
    return null;
  }

  return formatted.replace(/\.\d{3}\+05:30$/, "+05:30");
}

function toMinuteKey(value) {
  const barTime =
    typeof value === "string" && value.includes("T")
      ? toBarTime(new Date(value)) || value
      : toBarTime(value);

  return barTime ? barTime.slice(0, 16) : null;
}

function toDailyBarTime(tradeDate) {
  return tradeDate ? `${tradeDate}T15:30:00+05:30` : null;
}

function inspectCandleContinuity(bars = []) {
  const gaps = [];

  for (let index = 1; index < bars.length; index += 1) {
    const previous = new Date(bars[index - 1].barTime);
    const current = new Date(bars[index].barTime);
    const diffMinutes = Math.round(
      (current.getTime() - previous.getTime()) / 60000,
    );

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

function normalizeBars(bars = []) {
  return (bars || []).map((bar) => ({
    barTime: bar.barTime,
    signalAnchorTime: bar.signalAnchorTime || bar.barTime,
    date: bar.date || String(bar.barTime || "").slice(0, 10),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume || 0),
  }));
}

function buildReplaySnapshot({
  minuteBar,
  baseEvaluation,
  evaluation,
  latestBar,
  historyBootstrapSource,
  timeframe,
  bars,
  evaluationContext = {},
}) {
  const latestIndex = bars.length - 1;
  const indicators = evaluation.indicators || {};
  const redCount = indicators.redCounts?.[latestIndex] ?? null;
  const atr = indicators.atr?.[latestIndex] ?? null;
  const latestBarHigh = latestBar?.high ?? minuteBar?.high;
  const latestBarLow = latestBar?.low ?? minuteBar?.low;
  const trailingBase = indicators.trailingBase?.[latestIndex] ?? null;

  return {
    barTime: minuteBar?.barTime || latestBar?.barTime || null,
    evaluationBarTime: latestBar?.barTime || null,
    signalAnchorTime: latestBar?.signalAnchorTime || latestBar?.barTime || null,
    open: Number(minuteBar?.open ?? latestBar?.open ?? 0),
    high: Number(minuteBar?.high ?? latestBarHigh ?? 0),
    low: Number(minuteBar?.low ?? latestBarLow ?? 0),
    close: Number(minuteBar?.close ?? latestBar?.close ?? 0),
    baseAction: baseEvaluation?.action || null,
    baseReason: baseEvaluation?.reason || null,
    baseReferencePrice:
      baseEvaluation?.referencePrice == null
        ? null
        : Math.round(Number(baseEvaluation.referencePrice) * 100) / 100,
    action: evaluation.action || null,
    reason: evaluation.reason || null,
    redCount,
    atr: atr == null ? null : Math.round(Number(atr) * 100) / 100,
    trailingBase:
      trailingBase == null
        ? null
        : Math.round(Number(trailingBase) * 100) / 100,
    trailingStop:
      evaluation.trailingStop == null
        ? null
        : Math.round(Number(evaluation.trailingStop) * 100) / 100,
    referencePrice:
      evaluation.referencePrice == null
        ? null
        : Math.round(Number(evaluation.referencePrice) * 100) / 100,
    decisionPrice:
      evaluationContext.decisionPrice == null
        ? null
        : Math.round(Number(evaluationContext.decisionPrice) * 100) / 100,
    vwap:
      evaluationContext.latestVwapPoint?.vwap == null
        ? null
        : Math.round(Number(evaluationContext.latestVwapPoint.vwap) * 100) / 100,
    vwapGatePassed:
      evaluation.vwapGatePassed === undefined
        ? null
        : Boolean(evaluation.vwapGatePassed),
    timeframe,
    historyBootstrapSource,
  };
}

function replayStrategy1Session({
  bars = [],
  symbol = "NIFTY 50",
  fixedMax = true,
  maxRed = 3,
  timeframe,
} = {}) {
  const normalizedBars = normalizeBars(bars);
  const normalizedTimeframe = normalizeStrategy1Timeframe(timeframe);
  const state = {
    inPosition: false,
    entryDate: null,
    lastEvaluatedDate: null,
    symbol,
  };

  const events = [];
  const candidateEvents = [];
  const timeline = [];

  normalizedBars.forEach((minuteBar, index) => {
    const minuteHistory = normalizedBars.slice(0, index + 1);
    const evaluationContext = buildStrategy1EvaluationContext({
      minuteBars: minuteHistory,
      timeframe: normalizedTimeframe,
    });

    if (!evaluationContext.evaluationEligible || !evaluationContext.latestBar) {
      timeline.push({
        barTime: minuteBar.barTime,
        evaluationBarTime: evaluationContext.latestBar?.barTime || null,
        signalAnchorTime: evaluationContext.latestBar?.signalAnchorTime || null,
        open: minuteBar.open,
        high: minuteBar.high,
        low: minuteBar.low,
        close: minuteBar.close,
        action: null,
        reason: evaluationContext.reason,
        redCount: null,
        atr: null,
        trailingBase: null,
        trailingStop: null,
        referencePrice: null,
        timeframe: normalizedTimeframe,
      });
      return;
    }

    const baseEvaluation = evaluateStrategy1(evaluationContext.bars, state, {
      ticker: symbol,
      fixedMax,
      maxRed,
    });
    const evaluation = applyStrategy1VwapGate(baseEvaluation, evaluationContext);

    timeline.push(
      buildReplaySnapshot({
        minuteBar,
        baseEvaluation,
        evaluation,
        latestBar: evaluationContext.latestBar,
        historyBootstrapSource: "validation_replay",
        timeframe: normalizedTimeframe,
        bars: evaluationContext.bars,
        evaluationContext,
      }),
    );

    if (baseEvaluation.action === "BUY" || baseEvaluation.action === "SELL") {
      candidateEvents.push({
        barTime: evaluationContext.latestBar.barTime,
        signalAnchorTime:
          evaluationContext.latestBar.signalAnchorTime ||
          evaluationContext.latestBar.barTime,
        action: baseEvaluation.action,
        reason: baseEvaluation.reason,
        price:
          baseEvaluation.referencePrice ?? evaluationContext.latestBar.close,
        timeframe: normalizedTimeframe,
        blockedByVwap:
          baseEvaluation.action === "BUY" && evaluation.action !== "BUY",
        gateReason:
          baseEvaluation.action === "BUY" && evaluation.action !== "BUY"
            ? evaluation.reason || null
            : null,
        finalAction: evaluation.action || null,
      });
    }

    if (evaluation.action === "BUY" || evaluation.action === "SELL") {
      events.push({
        barTime: evaluationContext.latestBar.barTime,
        signalAnchorTime:
          evaluationContext.latestBar.signalAnchorTime ||
          evaluationContext.latestBar.barTime,
        action: evaluation.action,
        reason: evaluation.reason,
        price: evaluation.referencePrice ?? evaluationContext.latestBar.close,
        timeframe: normalizedTimeframe,
      });
    }

    if (evaluation.action === "BUY") {
      state.inPosition = true;
      state.entryDate =
        evaluation.entryDate ||
        evaluationContext.latestBar.signalAnchorTime ||
        evaluationContext.latestBar.barTime;
    } else if (evaluation.action === "SELL") {
      state.inPosition = false;
      state.entryDate = null;
    }

    state.lastEvaluatedDate =
      evaluationContext.latestBar.signalAnchorTime ||
      evaluationContext.latestBar.barTime;
  });

  return {
    symbol,
    timeframe: normalizedTimeframe,
    events,
    candidate_events: candidateEvents,
    timeline,
    vwapSeries: calculateSessionVwapSeries(normalizedBars),
  };
}

function replayStrategy1DailyFromMinuteHistory({
  bars = [],
  symbol = "NIFTY 50",
  fixedMax = true,
  maxRed = 3,
} = {}) {
  return replayStrategy1Session({
    bars,
    symbol,
    fixedMax,
    maxRed,
    timeframe: "1day",
  });
}

function replayStrategy1DailyHistory({
  bars = [],
  symbol = "NIFTY 50",
  fixedMax = true,
  maxRed = 3,
} = {}) {
  const normalizedBars = normalizeBars(bars)
    .map((bar) => {
      const tradeDate = bar.date || String(bar.barTime || "").slice(0, 10);
      const signalAnchorTime = tradeDate
        ? `${tradeDate}T09:15:00+05:30`
        : bar.signalAnchorTime || bar.barTime;
      return {
        ...bar,
        date: tradeDate,
        signalAnchorTime,
      };
    })
    .sort((left, right) => String(left.barTime).localeCompare(String(right.barTime)));

  const state = {
    inPosition: false,
    entryDate: null,
    lastEvaluatedDate: null,
    symbol,
  };

  const events = [];
  const timeline = [];

  normalizedBars.forEach((dailyBar, index) => {
    const history = normalizedBars.slice(0, index + 1);
    const evaluation = evaluateStrategy1(history, state, {
      ticker: symbol,
      fixedMax,
      maxRed,
    });

    timeline.push(
      buildReplaySnapshot({
        minuteBar: dailyBar,
        evaluation,
        latestBar: dailyBar,
        historyBootstrapSource: "validation_daily_history",
        timeframe: "1day",
        bars: history,
      }),
    );

    if (evaluation.action === "BUY" || evaluation.action === "SELL") {
      events.push({
        barTime: dailyBar.barTime,
        signalAnchorTime: dailyBar.signalAnchorTime || dailyBar.barTime,
        action: evaluation.action,
        reason: evaluation.reason,
        price: evaluation.referencePrice ?? dailyBar.close,
        timeframe: "1day",
      });
    }

    if (evaluation.action === "BUY") {
      state.inPosition = true;
      state.entryDate =
        evaluation.entryDate || dailyBar.signalAnchorTime || dailyBar.barTime;
    } else if (evaluation.action === "SELL") {
      state.inPosition = false;
      state.entryDate = null;
    }

    state.lastEvaluatedDate =
      dailyBar.signalAnchorTime || dailyBar.barTime || state.lastEvaluatedDate;
  });

  return {
    symbol,
    timeframe: "1day",
    events,
    candidate_events: events.map((event) => ({
      ...event,
      blockedByVwap: false,
      gateReason: null,
      finalAction: event.action,
    })),
    timeline,
  };
}

function summarizeDailyReplayRows(replay = {}) {
  const timeline = Array.isArray(replay.timeline) ? replay.timeline : [];
  const byTradeDate = new Map();

  function scoreRow(row = {}) {
    let score = 0;

    if (row.action) {
      score += 100;
    }
    if (
      row.reason &&
      !["evaluation_window_closed", "waiting_for_timeframe_close"].includes(
        row.reason,
      )
    ) {
      score += 50;
    }
    if (row.vwapGatePassed === true) {
      score += 20;
    }
    if (row.vwap != null) {
      score += 10;
    }
    if (row.decisionPrice != null) {
      score += 5;
    }

    return score;
  }

  timeline.forEach((row) => {
    const tradeDate = String(row.signalAnchorTime || row.barTime || "").slice(0, 10);
    if (!tradeDate) {
      return;
    }

    const snapshot = {
      tradeDate,
      barTime: row.barTime || null,
      signalAnchorTime: row.signalAnchorTime || null,
      action: row.action || null,
      reason: row.reason || null,
      decisionPrice:
        row.decisionPrice == null ? null : roundMetric(row.decisionPrice),
      vwap: row.vwap == null ? null : roundMetric(row.vwap),
      vwapGatePassed:
        row.vwapGatePassed === undefined ? null : Boolean(row.vwapGatePassed),
      close: row.close == null ? null : roundMetric(row.close),
    };

    const existing = byTradeDate.get(tradeDate);
    if (!existing) {
      byTradeDate.set(tradeDate, snapshot);
      return;
    }

    const nextScore = scoreRow(snapshot);
    const existingScore = scoreRow(existing);
    if (
      nextScore > existingScore ||
      (nextScore === existingScore &&
        String(snapshot.barTime || "").localeCompare(String(existing.barTime || "")) > 0)
    ) {
      byTradeDate.set(tradeDate, snapshot);
    }
  });

  return Array.from(byTradeDate.values()).sort((left, right) =>
    String(left.barTime || left.tradeDate).localeCompare(
      String(right.barTime || right.tradeDate),
    ),
  );
}

function buildStrategy1VwapGateSummary(replay = {}) {
  const days = summarizeDailyReplayRows(replay);

  return {
    totalDays: days.length,
    passedDays: days.filter((day) => day.vwapGatePassed === true).length,
    blockedDays: days.filter((day) => day.reason === "vwap_entry_blocked").length,
    unavailableDays: days.filter(
      (day) =>
        day.reason === "vwap_unavailable" ||
        (day.vwap == null && day.decisionPrice != null),
    ).length,
    signalDays: days.filter((day) => Boolean(day.action)).length,
    days,
  };
}

function roundMetric(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return 0;
  }

  return Math.round(Number(value) * 100) / 100;
}

function buildStrategy1ReplayPerformance(replay = {}, options = {}) {
  const events = Array.isArray(replay.events) ? replay.events : [];
  const timeline = Array.isArray(replay.timeline) ? replay.timeline : [];
  const startingCapital = Number(options.startingCapital || 0);
  const syntheticOrders = [];
  const eventMap = new Map();
  let openTrade = null;
  let realizedPnl = 0;

  events.forEach((event) => {
    const key = String(event.barTime || event.signalAnchorTime || "");
    const bucket = eventMap.get(key) || [];
    bucket.push(event);
    eventMap.set(key, bucket);
  });

  const equityCurve = timeline.map((row) => {
    const rowEvents =
      eventMap.get(String(row.barTime || row.signalAnchorTime || "")) || [];

    rowEvents.forEach((event) => {
      const eventPrice = Number(event.price ?? row.close ?? 0);
      if (event.action === "BUY" && !openTrade) {
        openTrade = {
          entryDate: event.barTime,
          entrySignalAnchorTime: event.signalAnchorTime || event.barTime,
          entryPrice: eventPrice,
          entryReason: event.reason || null,
        };
      } else if (event.action === "SELL" && openTrade) {
        const pnl = roundMetric(eventPrice - openTrade.entryPrice);
        realizedPnl = roundMetric(realizedPnl + pnl);
        syntheticOrders.push({
          side: "LONG",
          entry_date: openTrade.entryDate,
          exit_date: event.barTime,
          entry_price: roundMetric(openTrade.entryPrice),
          exit_price: roundMetric(eventPrice),
          pnl,
          exit_reason: event.reason || null,
          entry_reason: openTrade.entryReason,
        });
        openTrade = null;
      }
    });

    const unrealizedPnl = openTrade
      ? roundMetric(Number(row.close ?? 0) - Number(openTrade.entryPrice))
      : 0;
    const equity = roundMetric(startingCapital + realizedPnl + unrealizedPnl);

    return {
      time: row.barTime,
      barTime: row.barTime,
      close: roundMetric(row.close),
      realized_pnl: roundMetric(realizedPnl),
      unrealized_pnl: unrealizedPnl,
      equity,
      in_position: Boolean(openTrade),
    };
  });

  const totalTrades = syntheticOrders.length;
  const wins = syntheticOrders.filter((trade) => trade.pnl > 0).length;
  const losses = syntheticOrders.filter((trade) => trade.pnl < 0).length;
  const grossProfit = roundMetric(
    syntheticOrders.reduce(
      (sum, trade) => sum + (trade.pnl > 0 ? trade.pnl : 0),
      0,
    ),
  );
  const grossLoss = roundMetric(
    Math.abs(
      syntheticOrders.reduce(
        (sum, trade) => sum + (trade.pnl < 0 ? trade.pnl : 0),
        0,
      ),
    ),
  );
  const netPnl = roundMetric(
    syntheticOrders.reduce((sum, trade) => sum + trade.pnl, 0),
  );
  const averagePnlPerTrade =
    totalTrades > 0 ? roundMetric(netPnl / totalTrades) : 0;
  const maxWin =
    totalTrades > 0
      ? roundMetric(Math.max(...syntheticOrders.map((trade) => trade.pnl)))
      : 0;
  const maxLoss =
    totalTrades > 0
      ? roundMetric(Math.min(...syntheticOrders.map((trade) => trade.pnl)))
      : 0;
  const winRate = totalTrades > 0 ? roundMetric((wins / totalTrades) * 100) : 0;

  let maxDrawdown = 0;
  let peakEquity = startingCapital;
  equityCurve.forEach((point) => {
    peakEquity = Math.max(peakEquity, point.equity);
    maxDrawdown = Math.max(maxDrawdown, roundMetric(peakEquity - point.equity));
  });

  return {
    syntheticOrders,
    equityCurve,
    stats: {
      totalTrades,
      wins,
      losses,
      winRate,
      grossProfit,
      grossLoss,
      netPnl,
      averagePnlPerTrade,
      maxWin,
      maxLoss,
      startingCapital: roundMetric(startingCapital),
      endingEquity:
        equityCurve.length > 0
          ? equityCurve[equityCurve.length - 1].equity
          : roundMetric(startingCapital),
      maxDrawdown,
      openPositionAtEnd: Boolean(openTrade),
    },
  };
}

function extractExitReason(row = {}) {
  return (
    row.exit_reason ||
    row.metadata?.exit_reason ||
    row.event_data?.exit_reason ||
    null
  );
}

function isManualOverrideReason(reason) {
  return typeof reason === "string" && /(manual|override)/i.test(reason);
}

function buildRecordedSessionBreakdown({
  actualSignals = [],
  actualOrders = [],
} = {}) {
  const normalizedSignals = actualSignals.map((signal) => {
    const exitReason = extractExitReason(signal);
    return {
      ...signal,
      exit_reason: exitReason,
      origin: isManualOverrideReason(exitReason)
        ? "MANUAL_OVERRIDE"
        : "STRATEGY",
    };
  });

  const signalByEventId = new Map(
    normalizedSignals
      .filter((signal) => signal.event_id)
      .map((signal) => [String(signal.event_id), signal]),
  );

  const strategySignals = normalizedSignals.filter(
    (signal) => signal.origin === "STRATEGY",
  );
  const manualOverrideSignals = normalizedSignals.filter(
    (signal) => signal.origin === "MANUAL_OVERRIDE",
  );

  const strategyOrders = [];
  const manualOverrideOrders = [];

  actualOrders.forEach((order) => {
    const linkedSignal =
      signalByEventId.get(String(order.event_id || "")) || null;
    const exitReason = extractExitReason(linkedSignal || order);
    const enrichedOrder = {
      ...order,
      linked_signal_id: linkedSignal?.id || null,
      linked_signal_action: linkedSignal?.action || null,
      linked_signal_origin: linkedSignal?.origin || "RECORDED_ONLY",
      exit_reason: exitReason,
    };

    if (linkedSignal?.origin === "MANUAL_OVERRIDE") {
      manualOverrideOrders.push(enrichedOrder);
      return;
    }

    strategyOrders.push(enrichedOrder);
  });

  const manualOverrides = manualOverrideSignals.map((signal) => {
    const linkedOrder = manualOverrideOrders.find(
      (order) => String(order.event_id || "") === String(signal.event_id || ""),
    );

    return {
      id: signal.id || linkedOrder?.id || null,
      event_id: signal.event_id || linkedOrder?.event_id || null,
      action: signal.action || linkedOrder?.side || "SELL",
      timestamp:
        signal.trigger_bar_time ||
        signal.timestamp ||
        linkedOrder?.created_at ||
        null,
      trigger_bar_time: signal.trigger_bar_time || signal.timestamp || null,
      reason:
        signal.exit_reason || linkedOrder?.exit_reason || signal.reason || null,
      price: Number(
        signal.price ||
          linkedOrder?.average_fill_price ||
          linkedOrder?.average_price ||
          linkedOrder?.price ||
          0,
      ),
      instrument:
        linkedOrder?.instrument || signal.instrument || signal.symbol || null,
      order_id: linkedOrder?.id || null,
      order_status: linkedOrder?.status || null,
    };
  });

  return {
    allSignals: normalizedSignals,
    strategySignals,
    strategyOrders,
    manualOverrides,
    manualOverrideOrders,
    operatorTrades: [],
  };
}

function compareStrategy1Session({
  replay,
  actualSignals = [],
  actualOrders = [],
}) {
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
    const actualSignal = candidates.find(
      (signal) => !matchedSignalIds.has(signal.id),
    );

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

    if (
      ["rejected", "failed", "cancelled"].includes(
        String(matchingOrder.status || "").toLowerCase(),
      )
    ) {
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
  const todayIst = toBarTime(now)?.slice(0, 10) || null;
  if (!tradeDate || tradeDate !== todayIst) {
    return true;
  }

  const parts = toBarTime(now);
  if (!parts) {
    return false;
  }

  const currentMinutes =
    Number(parts.slice(11, 13)) * 60 + Number(parts.slice(14, 16));
  return currentMinutes >= 16 * 60 + 15;
}

module.exports = {
  buildRecordedSessionBreakdown,
  buildStrategy1ReplayPerformance,
  buildStrategy1VwapGateSummary,
  compareStrategy1Session,
  inspectCandleContinuity,
  isManualOverrideReason,
  isValidationWindowOpen,
  replayStrategy1DailyFromMinuteHistory,
  replayStrategy1DailyHistory,
  replayStrategy1Session,
  toBarTime,
  toDailyBarTime,
  toMinuteKey,
};
