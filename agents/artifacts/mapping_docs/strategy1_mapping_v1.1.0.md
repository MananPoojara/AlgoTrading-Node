---
artifact_type: strategy_mapping
strategy_id: strategy1
strategy_version: 1.1.0
spec_ref: agents/artifacts/strategy_specs/strategy1_spec_v1.1.0.md
candle_channels:
- candles:1m:NIFTY
critical_streams:
- stream:strategy_signals
- stream:order_updates
new_platform_dependencies: []
differences_from_strategy1live:
- default timeframe changes from fixed 1m to configurable 1day/1min/5min/15min
- 1day uses a live in-progress daily bar and evaluates only in the 15:20-15:30 IST
  window
- all non-1m modes aggregate from canonical market_ohlc_1m minute history rather than
  requiring new retained OHLC tables
- timeframe changes are persisted immediately but apply only after operator stop/start
- validation replay must aggregate minute history using the same timeframe rules as
  live Strategy1
senior_backend_acknowledged: true
date_created: '2026-03-25'
status: SUPERSEDED
---

# Strategy Mapping Document

## Strategy Name
`STRATEGY1_LIVE`

## Timeframe
- Canonical configuration field: `strategy_instances.parameters.timeframe`
- Allowed values: `1day`, `1min`, `5min`, `15min`
- Default: `1day`
- Canonical retained market-history source remains `market_ohlc_1m`
- Live runtime aggregates upward from minute history instead of requiring separate retained 5m/15m/daily tables

## Entry Condition Mapping
- `packages/strategies/intraday/strategy1Core.js` continues to compute consecutive-red and ATR context from an input bar series.
- `packages/strategies/intraday/strategy1Live.js` becomes responsible for normalizing `parameters.timeframe`, building the correct timeframe bar series from minute history, and passing that series into `strategy1Core`.
- For `1day`, Strategy1 builds the current live trading-day bar from minute history and evaluates entry only in the `15:20-15:30 IST` window.
- `apps/order-manager/src/orderManager.js` remains the paper OMS consumer for the emitted durable signals.

## Exit Condition Mapping
- `strategy1Core` still owns the ATR trailing-stop rule.
- `strategy1Live` must feed exit evaluation with the configured timeframe bar series and block same-bar re-entry after an operator/manual exit.
- Existing exit transport remains unchanged: Strategy1 emits a durable `SELL`, OMS processes the paper order lifecycle, and execution updates flow back to the worker.

## Persisted State
- `timeframe`
- `lastEvaluatedBarTime`
- `lastSignalFingerprint`
- `pendingEntryContext`
- `entryContext`
- `pendingExitContext`
- aggregated-bar diagnostics required to recover the active timeframe view safely after restart

## Instruments
- Underlying feed: canonical `NIFTY 50` 1-minute candles retained in `market_ohlc_1m`
- Traded instrument: resolved ATM CE option contract
- Paper mode may allow unresolved option metadata for parity observation; live mode must not

## Multi-Ticker
- Still single-underlying per Strategy1 instance.
- No simultaneous multi-ticker position handling is introduced by this version.

## Platform Dependencies
- Durable stream delivery for strategy signals and order updates
- Runtime state persistence and restore on worker restart
- Minute-history aggregation inside Strategy1 runtime and validation replay
- Existing API/dashboard surfaces extended to show configured timeframe and replay source
- No new retained OHLC table or new Redis candle channel is required for v1.1.0

## Differences from Strategy1Live
- The previously approved Strategy1 contract was fixed at `1m`; v1.1.0 replaces it with default `1day` plus optional `1min`/`5min`/`15min`.
- `1day` semantics are a live in-progress day bar with end-of-day evaluation, not a fully closed prior-day candle.
- Operator settings must persist timeframe but only apply after stop/start.
- Validation replay must become timeframe-aware while still preferring Angel historical 1-minute candles after `16:15 IST`.

## Test Plan
- Verify timeframe normalization defaults invalid/missing values to `1day`.
- Verify `1min`, `5min`, and `15min` evaluate only on closed bars.
- Verify `1day` evaluates only in the `15:20-15:30 IST` window using the current in-progress daily bar.
- Verify same-day/manual exit does not cause same-bar re-entry.
- Verify restart recovery rebuilds the correct aggregated bars from retained minute history.
- Verify validation replay uses the same timeframe rules as the live strategy and still prefers Angel historical 1-minute candles after hours.
