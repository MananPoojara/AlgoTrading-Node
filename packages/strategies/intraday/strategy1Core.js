function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function getBarKey(bar = {}) {
  return bar.signalAnchorTime || bar.barTime || bar.date || null;
}

function getStrategy1Params(ticker, fixedMax = false, manualMax = 3) {
  let maxRed;
  if (fixedMax) maxRed = manualMax;
  else if (ticker === "NIFTY 50") maxRed = 7;
  else if (ticker === "NIFTYBANK") maxRed = 5;
  else maxRed = 6;

  return {
    maxRed,
    atrPeriod: 5,
    atrFactor: ticker !== "NIFTYMIDCAP100" ? 2 : 4,
  };
}

function computeIndicators(bars, params) {
  const redCounts = new Array(bars.length).fill(0);
  const atr = new Array(bars.length).fill(null);
  const trailingBase = new Array(bars.length).fill(null);
  let redRun = 0;
  let trueRangeSum = 0;

  for (let index = 0; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    const isRed = Number(current.open) > Number(current.close);
    redRun = isRed ? redRun + 1 : 0;
    redCounts[index] = redRun;

    const high = Number(current.high);
    const low = Number(current.low);
    const prevClose = previous ? Number(previous.close) : null;
    const highLow = high - low;
    const highPrevClose = prevClose === null ? 0 : Math.abs(high - prevClose);
    const lowPrevClose = prevClose === null ? 0 : Math.abs(low - prevClose);
    const trueRange = Math.max(highLow, highPrevClose, lowPrevClose);

    trueRangeSum += trueRange;
    if (index >= params.atrPeriod) {
      const exitingBar = bars[index - params.atrPeriod];
      const exitingPrevClose =
        index - params.atrPeriod - 1 >= 0
          ? Number(bars[index - params.atrPeriod - 1].close)
          : null;
      const exitingHighLow = Number(exitingBar.high) - Number(exitingBar.low);
      const exitingHighPrev =
        exitingPrevClose === null
          ? 0
          : Math.abs(Number(exitingBar.high) - exitingPrevClose);
      const exitingLowPrev =
        exitingPrevClose === null
          ? 0
          : Math.abs(Number(exitingBar.low) - exitingPrevClose);
      trueRangeSum -= Math.max(exitingHighLow, exitingHighPrev, exitingLowPrev);
    }

    if (index >= params.atrPeriod - 1) {
      const averageTrueRange = trueRangeSum / params.atrPeriod;
      atr[index] = averageTrueRange;
      trailingBase[index] =
        (Number(current.high) + Number(current.low)) / 2 -
        averageTrueRange * params.atrFactor;
    }
  }

  return { redCounts, atr, trailingBase };
}

function evaluateStrategy1(bars, state = {}, options = {}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { action: null, reason: "insufficient_data", indicators: null };
  }

  const latestBar = bars[bars.length - 1];
  const latestBarKey = getBarKey(latestBar);
  const params = getStrategy1Params(
    options.ticker || state.symbol || "UNKNOWN",
    options.fixedMax,
    options.maxRed,
  );
  const indicators = computeIndicators(bars, params);
  const latestIndex = bars.length - 1;

  if (!state.inPosition) {
    const qualifiesEntry = indicators.redCounts[latestIndex] >= params.maxRed;
    if (!qualifiesEntry) {
      return { action: null, reason: "no_entry", indicators };
    }

    if (state.lastEvaluatedDate === latestBarKey) {
      return { action: null, reason: "entry_already_evaluated", indicators };
    }

    return {
      action: "BUY",
      reason: "consecutive_red_entry",
      referencePrice: round2(latestBar.close),
      indicators,
      entryDate: latestBarKey,
    };
  }

  const entryIndex = bars.findIndex(
    (bar) => getBarKey(bar) === state.entryDate,
  );
  if (entryIndex < 0 || indicators.trailingBase[entryIndex] === null) {
    return { action: null, reason: "entry_context_missing", indicators };
  }

  let trailingStop = indicators.trailingBase[entryIndex];
  for (let index = entryIndex + 1; index < bars.length; index += 1) {
    const currentBase = indicators.trailingBase[index];
    if (currentBase === null) {
      continue;
    }

    if (Number(bars[index].close) < trailingStop) {
      if (index === latestIndex && state.lastEvaluatedDate !== latestBarKey) {
        return {
          action: "SELL",
          reason: "atr_trailing_exit",
          referencePrice: round2(latestBar.close),
          indicators,
          exitDate: latestBarKey,
          trailingStop: round2(trailingStop),
        };
      }

      return { action: null, reason: "exit_already_crossed", indicators };
    }

    trailingStop = Math.max(trailingStop, currentBase);
  }

  return {
    action: null,
    reason: "hold_position",
    indicators,
    trailingStop: round2(trailingStop),
  };
}

module.exports = {
  evaluateStrategy1,
  getStrategy1Params,
  computeIndicators,
  getBarKey,
  round2,
};
