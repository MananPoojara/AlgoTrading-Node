---
artifact_type: strategy_mapping
strategy_id: strategy1
strategy_version: 1.0.0
spec_ref: agents/artifacts/strategy_specs/strategy1_spec_v1.0.0.md
candle_channels:
- candles:1m:NIFTY
critical_streams:
- stream:strategy_signals
- stream:order_updates
new_platform_dependencies: []
differences_from_strategy1live: []
senior_backend_acknowledged: true
date_created: '2026-03-24'
status: SUPERSEDED
---

# Strategy Mapping Document

## Strategy Name
`STRATEGY1_LIVE`

## Timeframe
- Consumes completed `1m` candle data for the configured underlying.
- No higher-timeframe aggregation is required for the current version.

## Entry Condition Mapping
- `packages/strategies/intraday/strategy1Core.js` computes red-count and ATR context from completed bars.
- `packages/strategies/intraday/strategy1Live.js` converts a valid entry decision into a durable `BUY` signal for the ATM CE instrument.
- `apps/order-manager/src/orderManager.js` validates the signal in paper mode and creates the paper order lifecycle.

## Exit Condition Mapping
- `strategy1Core` evaluates the trailing-stop sell condition using completed candle closes.
- `strategy1Live` emits a durable `SELL` signal with `atr_trailing_exit` when the close breaches the active trailing stop.
- `apps/order-manager/src/orderManager.js` processes the exit order lifecycle and publishes execution updates back to the strategy worker.

## Persisted State
- `lastEvaluatedBarTime`
- `lastSignalFingerprint`
- `pendingEntryContext`
- `entryContext`
- `pendingExitContext`
- trailing-stop-relevant runtime derived from restored entry/bar history state

## Instruments
- Underlying feed: `NIFTY 50` 1-minute candles
- Traded instrument: resolved ATM CE option contract
- Paper mode may allow unresolved option metadata for parity observation; live mode must not

## Multi-Ticker
- Current mapping is single-underlying for Strategy1 per instance.
- No simultaneous multi-ticker position handling is part of this strategy version.

## Platform Dependencies
- Durable stream delivery for strategy signals and order updates
- Runtime state persistence and restore on worker restart
- Paper OMS lifecycle updates reaching the strategy worker in order
- Existing API/WebSocket surfaces for operator visibility

## Differences from Strategy1Live
- None. This mapping is a backfill for the currently implemented Strategy1.

## Test Plan
- Verify order lifecycle updates do not deduplicate away `filled` after `acknowledged` for the same logical order.
- Verify Strategy1 enters `IN_POSITION` only after paper fill confirmation.
- Verify trailing-stop exit emits `SELL` when PineScript-equivalent conditions are met.
- Verify frontend/backend surfaces expose the same Strategy1 runtime state used for parity observation.

## Senior Backend Acknowledgement
- Acknowledged on 2026-03-24 after platform-gap review.
- No missing platform component blocks Strategy1 paper-parity rework.
- Current issue is an implementation/runtime defect on an already supported hot path.
