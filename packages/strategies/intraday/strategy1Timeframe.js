const DAILY_WINDOW_START_MINUTES = 15 * 60;
const DAILY_WINDOW_END_MINUTES = 15 * 60 + 15;

const TIMEFRAME_ALIASES = {
  "1m": "1min",
  "1min": "1min",
  "5m": "5min",
  "5min": "5min",
  "15m": "15min",
  "15min": "15min",
  daily: "1day",
  day: "1day",
  "1d": "1day",
  "1day": "1day",
};

function normalizeStrategy1Timeframe(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TIMEFRAME_ALIASES[normalized] || "1day";
}

function sortBars(bars = []) {
  return [...bars].sort((left, right) => String(left.barTime).localeCompare(String(right.barTime)));
}

function parseBarParts(barTime) {
  const normalized = String(barTime || "");
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }

  return {
    tradeDate: match[1],
    hour: Number(match[2]),
    minute: Number(match[3]),
  };
}

function formatAnchor(tradeDate, hour, minute) {
  return `${tradeDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`;
}

function getMinuteBucketAnchor(barTime, bucketMinutes) {
  const parts = parseBarParts(barTime);
  if (!parts) {
    return null;
  }

  const anchorMinute = Math.floor(parts.minute / bucketMinutes) * bucketMinutes;
  return formatAnchor(parts.tradeDate, parts.hour, anchorMinute);
}

function aggregateBucket(
  bucketBars,
  anchorTime,
  latestBarTime = null,
  signalAnchorTime = null,
) {
  if (!bucketBars.length || !anchorTime) {
    return null;
  }

  return {
    date: anchorTime.slice(0, 10),
    barTime: latestBarTime || anchorTime,
    signalAnchorTime: signalAnchorTime || anchorTime,
    open: Number(bucketBars[0].open),
    high: Math.max(...bucketBars.map((bar) => Number(bar.high))),
    low: Math.min(...bucketBars.map((bar) => Number(bar.low))),
    close: Number(bucketBars[bucketBars.length - 1].close),
    volume: bucketBars.reduce((sum, bar) => sum + Number(bar.volume || 0), 0),
  };
}

function aggregateIntradayBars(minuteBars, bucketMinutes) {
  const buckets = new Map();

  sortBars(minuteBars).forEach((bar) => {
    const anchorTime = getMinuteBucketAnchor(bar.barTime, bucketMinutes);
    if (!anchorTime) {
      return;
    }

    const bucket = buckets.get(anchorTime) || [];
    bucket.push(bar);
    buckets.set(anchorTime, bucket);
  });

  return Array.from(buckets.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([anchorTime, bucketBars]) => aggregateBucket(bucketBars, anchorTime));
}

function aggregateDailyBars(minuteBars) {
  const buckets = new Map();

  sortBars(minuteBars).forEach((bar) => {
    const tradeDate = String(bar.date || bar.barTime || "").slice(0, 10);
    if (!tradeDate) {
      return;
    }

    const bucket = buckets.get(tradeDate) || [];
    bucket.push(bar);
    buckets.set(tradeDate, bucket);
  });

  return Array.from(buckets.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([tradeDate, bucketBars]) => {
      const latestBar = bucketBars[bucketBars.length - 1];
      const signalAnchorTime = `${tradeDate}T09:15:00+05:30`;
      return aggregateBucket(
        bucketBars,
        signalAnchorTime,
        latestBar?.barTime || signalAnchorTime,
        signalAnchorTime,
      );
    });
}

function aggregateStrategy1Bars(minuteBars = [], timeframe = "1day") {
  const normalizedTimeframe = normalizeStrategy1Timeframe(timeframe);
  const bars = sortBars(minuteBars).map((bar) => ({
    ...bar,
    signalAnchorTime: bar.signalAnchorTime || bar.barTime,
    volume: Number(bar.volume || 0),
  }));

  if (normalizedTimeframe === "1min") {
    return bars;
  }

  if (normalizedTimeframe === "5min") {
    return aggregateIntradayBars(bars, 5);
  }

  if (normalizedTimeframe === "15min") {
    return aggregateIntradayBars(bars, 15);
  }

  return aggregateDailyBars(bars);
}

function isIntradayBucketClosed(latestMinuteBarTime, timeframe) {
  const parts = parseBarParts(latestMinuteBarTime);
  if (!parts) {
    return false;
  }

  const minute = parts.minute;
  if (timeframe === "5min") {
    return minute % 5 === 4;
  }

  if (timeframe === "15min") {
    return minute % 15 === 14;
  }

  return true;
}

function isDailyEvaluationWindowOpen(barTime) {
  const parts = parseBarParts(barTime);
  if (!parts) {
    return false;
  }

  const currentMinutes = parts.hour * 60 + parts.minute;
  return currentMinutes >= DAILY_WINDOW_START_MINUTES && currentMinutes <= DAILY_WINDOW_END_MINUTES;
}

function calculateSessionVwapSeries(minuteBars = []) {
  let cumulativeWeightedPrice = 0;
  let cumulativeVolume = 0;
  let currentTradeDate = null;

  return sortBars(minuteBars)
    .map((bar) => {
      const tradeDate = bar.date || String(bar.barTime || "").slice(0, 10);
      if (tradeDate !== currentTradeDate) {
        currentTradeDate = tradeDate;
        cumulativeWeightedPrice = 0;
        cumulativeVolume = 0;
      }

      const volume = Number(bar.volume || 0);
      const typicalPrice =
        (Number(bar.high || 0) + Number(bar.low || 0) + Number(bar.close || 0)) /
        3;

      if (volume > 0) {
        cumulativeWeightedPrice += typicalPrice * volume;
        cumulativeVolume += volume;
      }

      const vwap =
        cumulativeVolume > 0 ? cumulativeWeightedPrice / cumulativeVolume : null;

      return {
        barTime: bar.barTime,
        signalAnchorTime: bar.signalAnchorTime || bar.barTime,
        date: tradeDate,
        close: Number(bar.close || 0),
        volume,
        vwap,
      };
    })
    .filter((bar) => bar.vwap != null);
}

function getLatestSessionVwapPoint(vwapSeries = [], latestMinuteBar = null) {
  if (!latestMinuteBar?.barTime) {
    return null;
  }

  const latestTradeDate =
    latestMinuteBar.date || String(latestMinuteBar.barTime).slice(0, 10);
  const latestBarTime = String(latestMinuteBar.barTime);

  for (let index = vwapSeries.length - 1; index >= 0; index -= 1) {
    const point = vwapSeries[index];
    const pointTradeDate = point.date || String(point.barTime || "").slice(0, 10);

    if (pointTradeDate !== latestTradeDate) {
      continue;
    }

    if (String(point.barTime || "") <= latestBarTime) {
      return point;
    }
  }

  return null;
}

function getDecisionPriceForTimeframe({
  timeframe,
  latestBar = null,
  latestMinuteBar = null,
} = {}) {
  if (timeframe === "1day") {
    return Number(latestMinuteBar?.close ?? latestBar?.close ?? 0);
  }

  return Number(latestBar?.close ?? latestMinuteBar?.close ?? 0);
}

function applyStrategy1VwapGate(evaluation = {}, evaluationContext = {}) {
  if (evaluation.action !== "BUY") {
    return evaluation;
  }

  const vwap = Number(evaluationContext.latestVwapPoint?.vwap);
  const decisionPrice = Number(evaluationContext.decisionPrice);

  if (!Number.isFinite(vwap) || !Number.isFinite(decisionPrice)) {
    return {
      ...evaluation,
      action: null,
      reason: "vwap_unavailable",
      vwapGatePassed: false,
    };
  }

  const vwapGatePassed = decisionPrice > vwap;
  if (!vwapGatePassed) {
    return {
      ...evaluation,
      action: null,
      reason: "vwap_entry_blocked",
      referencePrice: decisionPrice,
      vwapGatePassed,
    };
  }

  return {
    ...evaluation,
    referencePrice: decisionPrice,
    vwapGatePassed,
  };
}

function buildStrategy1EvaluationContext({ minuteBars = [], timeframe = "1day" } = {}) {
  const normalizedTimeframe = normalizeStrategy1Timeframe(timeframe);
  const sortedMinuteBars = sortBars(minuteBars);
  const aggregatedBars = aggregateStrategy1Bars(sortedMinuteBars, normalizedTimeframe);
  const latestMinuteBar = sortedMinuteBars[sortedMinuteBars.length - 1] || null;
  const vwapSeries = calculateSessionVwapSeries(sortedMinuteBars);
  const latestVwapPoint = getLatestSessionVwapPoint(vwapSeries, latestMinuteBar);
  const latestBar = aggregatedBars[aggregatedBars.length - 1] || null;
  const decisionPrice = getDecisionPriceForTimeframe({
    timeframe: normalizedTimeframe,
    latestBar,
    latestMinuteBar,
  });

  if (normalizedTimeframe === "1day") {
    const evaluationWindowOpen = isDailyEvaluationWindowOpen(latestMinuteBar?.barTime);
    return {
      timeframe: normalizedTimeframe,
      evaluationTimeframe: normalizedTimeframe,
      bars: aggregatedBars,
      latestBar,
      latestMinuteBar,
      vwapSeries,
      latestVwapPoint,
      decisionPrice,
      evaluationEligible: Boolean(evaluationWindowOpen && aggregatedBars.length > 0),
      evaluationWindowOpen,
      reason: evaluationWindowOpen ? "ready" : "evaluation_window_closed",
    };
  }

  if (["5min", "15min"].includes(normalizedTimeframe)) {
    const latestBucketClosed = isIntradayBucketClosed(latestMinuteBar?.barTime, normalizedTimeframe);
    const evaluationBars = latestBucketClosed ? aggregatedBars : aggregatedBars.slice(0, -1);
    return {
      timeframe: normalizedTimeframe,
      evaluationTimeframe: normalizedTimeframe,
      bars: evaluationBars,
      latestBar: evaluationBars[evaluationBars.length - 1] || null,
      latestMinuteBar,
      vwapSeries,
      latestVwapPoint,
      decisionPrice,
      evaluationEligible: evaluationBars.length > 0,
      evaluationWindowOpen: true,
      reason: evaluationBars.length > 0 ? "ready" : "waiting_for_timeframe_close",
    };
  }

  return {
    timeframe: normalizedTimeframe,
    evaluationTimeframe: normalizedTimeframe,
    bars: aggregatedBars,
    latestBar,
    latestMinuteBar,
    vwapSeries,
    latestVwapPoint,
    decisionPrice,
    evaluationEligible: aggregatedBars.length > 0,
    evaluationWindowOpen: true,
    reason: aggregatedBars.length > 0 ? "ready" : "insufficient_data",
  };
}

module.exports = {
  DAILY_WINDOW_END_MINUTES,
  DAILY_WINDOW_START_MINUTES,
  applyStrategy1VwapGate,
  aggregateStrategy1Bars,
  buildStrategy1EvaluationContext,
  calculateSessionVwapSeries,
  getLatestSessionVwapPoint,
  getDecisionPriceForTimeframe,
  isDailyEvaluationWindowOpen,
  normalizeStrategy1Timeframe,
};
