---
artifact_type: strategy_spec
strategy_id: strategy1
strategy_version: 1.1.0
timeframe: 1day_default_with_optional_1min_5min_15min
instrument_type: options
requires_platform_gaps: []
ambiguities_resolved: true
founder_approval_ref: '2026-03-25 founder instruction: Strategy1 defaults to 1day
  with optional 1min/5min/15min, daily mode uses a live in-progress day bar and evaluates
  in the 15:20-15:30 IST window, timeframe changes apply after stop/start'
qa_author: QA artifact refresh backfilled from founder instruction and existing Strategy1
  briefing
date_created: '2026-03-25'
status: SUPERSEDED
---

# Strategy Specification

## Strategy
Strategy1 trades the ATM CE option for the configured underlying in paper mode using a configurable bar timeframe. The new default timeframe is `1day`, with optional `1min`, `5min`, and `15min` modes per strategy instance. The core entry and exit logic remains the same: enter after consecutive red bars and exit on an ATR-based trailing stop with a square-off fallback.

## Instrument
- Underlying: `NIFTY 50` by default
- Traded instrument: ATM Call option (`CE`) resolved at signal time
- Quantity: configured lot size, default `25`
- Execution mode today: paper only

## Timeframe
- Canonical instance parameter: `parameters.timeframe`
- Allowed values: `1day`, `1min`, `5min`, `15min`
- Default value for Strategy1: `1day`
- `1min`, `5min`, and `15min` evaluate only on completed timeframe bars
- `1day` evaluates against the live in-progress trading-day bar only during the end-of-day window from `15:20 IST` through `15:30 IST`
- Timeframe changes are saved immediately but take effect only after the operator stops and starts the strategy instance
- Signal dedup namespace remains tied to the logical bar anchor, not wall-clock time

## Entry Conditions
1. Use the configured timeframe to build the decision bar series from the canonical 1-minute market history.
2. Treat a bar as red when `open > close`.
3. Maintain a stable count of consecutive red bars using the configured timeframe bars only.
4. When `redCount >= 3` and ATR trailing base is available, emit a `BUY` for the resolved ATM CE instrument.
5. Enter only when the strategy is not already in `PENDING_ENTRY`, `IN_POSITION`, or `PENDING_EXIT`.
6. For `1day`, evaluate entry only during the `15:20-15:30 IST` window using the current in-progress daily bar.

## Exit Conditions
1. While in position, compute trailing base from the configured timeframe bars only using ATR period `5` and factor `2.0`.
2. Initialize trailing stop from the entry bar trailing base and ratchet upward only.
3. Emit `SELL` with reason `atr_trailing_exit` when the latest eligible timeframe bar close falls below the active trailing stop.
4. Emit `SELL` on square-off if still in position near market close.
5. Do not emit another exit while `PENDING_EXIT` already exists.
6. After an operator/manual exit within a timeframe bar, do not re-enter on that same logical bar; the next eligible entry can happen only on the next timeframe bar.

## State Machine
- `IDLE`: no pending or open position context
- `PENDING_ENTRY`: BUY signal emitted, waiting for order lifecycle to confirm fill
- `IN_POSITION`: BUY fill confirmed and trailing stop active
- `PENDING_EXIT`: SELL signal emitted, waiting for exit order lifecycle completion

## Constraints
- One position at a time, no pyramiding.
- Critical events must use durable delivery (`stream:strategy_signals`, `stream:order_updates`).
- Strategy state must restore correctly from persisted runtime state after restart.
- Unresolved option resolution is acceptable in paper mode for parity observation, but not for live trading.
- Paper/live separation must remain explicit; this artifact does not approve live broker execution.
- The operator dashboard remains read-only for validation; no new live-control surface is introduced by the timeframe change.

## Ambiguities Resolved
- Founder replaced the previous fixed `1m` contract with a timeframe-configurable contract for Strategy1.
- Founder selected `1day` as the default timeframe.
- Founder selected `1day` semantics as a live in-progress day bar that is eligible for evaluation in the `15:20-15:30 IST` window, with expected signal timing around `15:20-15:25 IST`.
- Founder selected restart-required application semantics for timeframe changes; the strategy does not hot-apply timeframe changes mid-run.
- The core Strategy1 rule shape remains unchanged: consecutive red bars for entry and ATR trailing-stop logic for exit.

## Platform Requirements
- Strategy worker must normalize `parameters.timeframe` into the internal evaluation mode and bar aggregation behavior.
- Strategy worker must rebuild aggregated timeframe bars from retained `market_ohlc_1m` history on startup/restart.
- Validation replay must use the same timeframe normalization and aggregation rules as the live strategy.
- Dashboard and API must expose the configured timeframe and whether validation replay used historical or retained 1-minute candles.
- Signal fingerprints for `1day` must use a deterministic trading-day anchor, not wall-clock time.

## Notes
This spec supersedes the prior fixed `1m` Strategy1 contract. It documents the founder-approved Strategy1 timeframe model that must be implemented before paper-parity work can continue.
