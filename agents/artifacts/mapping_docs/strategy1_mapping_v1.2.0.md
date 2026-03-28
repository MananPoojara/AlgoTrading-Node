---
artifact_type: strategy_mapping
strategy_id: strategy1
strategy_version: 1.2.0
spec_ref: agents/artifacts/strategy_specs/strategy1_spec_v1.2.0.md
candle_channels:
- candles:1m:NIFTY
critical_streams:
- stream:strategy_signals
- stream:order_updates
- stream:position_corrections
new_platform_dependencies:
- manual_position_correction_audit_flow
differences_from_strategy1live:
- daily mode decision window moves to 15:00-15:15 IST
- all timeframes require a real VWAP BUY gate derived from canonical 1-minute history
- daily_30d validation must replay 1-minute history per day rather than completed daily candles only
- dashboard gains mismatch alerts and audited manual position correction controls
- manual correction creates a manual trade/history record but does not place a broker or OMS order
senior_backend_acknowledged: true
date_created: '2026-03-27'
status: APPROVED
---

# Strategy Mapping Document

## Strategy Name
`STRATEGY1_LIVE`

## Timeframe and VWAP
- Canonical configuration field remains `strategy_instances.parameters.timeframe`.
- Allowed values remain `1day`, `1min`, `5min`, `15min`.
- Canonical retained/live source remains `market_ohlc_1m` minute history.
- VWAP is computed from the canonical 1-minute session candles and sampled at the decision point for all timeframes.
- `1day` uses the in-progress daily bar plus VWAP in the `15:00-15:15 IST` window.

## Entry Condition Mapping
- `packages/strategies/intraday/strategy1Core.js` continues to own consecutive-red and ATR context from an input bar series.
- `packages/strategies/intraday/strategy1Live.js` must add the VWAP gate and move daily decision timing earlier.
- `packages/strategies/intraday/strategy1Timeframe.js` must expose the minute-derived VWAP snapshot needed for each timeframe decision.
- For daily mode, the strategy must evaluate between `15:00-15:15 IST` and emit a BUY only if both the base daily rule and VWAP gate pass.

## Exit Condition Mapping
- `strategy1Core` still owns the ATR trailing-stop rule.
- VWAP is not added to exit logic in v1.2.0.
- Manual correction and manual_stop handling must preserve no-same-bar re-entry behavior.

## Validation and Replay Mapping
- `packages/strategies/intraday/strategy1Validation.js` must replay daily mode from per-day 1-minute history to reproduce VWAP-gated daily decisions.
- `apps/api/src/routes/strategies.js` must return VWAP series, VWAP gate outcomes, mismatch status, and manual correction history.
- Validation daily summary remains daily, but its source of truth becomes minute replay for each replayed trading day.

## Manual Position Correction Mapping
- Add a persisted manual correction record with operator identity, instrument, quantity, average price, reason, note, and timestamps.
- Add a manual trade/history record so correction appears in platform history distinctly from strategy-generated execution.
- Correction must update platform/runtime position state but must not place a broker or OMS order.
- Dashboard and API must surface mismatch alerts before correction is allowed.

## Persisted State
- Existing Strategy1 runtime state remains required.
- Add mismatch diagnostics sufficient to explain runtime-vs-position divergence.
- Add persisted VWAP gate diagnostics for the active decision bar/day.
- Add manual correction audit/history storage.

## Platform Dependencies
- Durable stream delivery for strategy signals and order updates.
- Durable handling for position correction events.
- Runtime state persistence and restore on worker restart.
- Dashboard/API surfaces extended to show VWAP gate, mismatch status, and correction history.
- Schema change required for manual position correction audit/history.

## Test Plan
- Verify daily mode evaluates in `15:00-15:15 IST` and requires VWAP gate pass.
- Verify intraday timeframes gate BUY entries on VWAP.
- Verify daily_30d validation replays per-day minute history rather than completed daily candles only.
- Verify mismatch detection and manual correction create audited records and do not place OMS/broker orders.
- Verify same-bar or same-day re-entry remains blocked after manual correction.
