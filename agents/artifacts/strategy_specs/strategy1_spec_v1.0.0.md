---
artifact_type: strategy_spec
strategy_id: strategy1
strategy_version: 1.0.0
timeframe: 1m
instrument_type: options
requires_platform_gaps: []
ambiguities_resolved: true
founder_approval_ref: '2026-03-24 founder instruction: use existing Strategy1 briefing
  and PineScript as source for workflow backfill'
qa_author: Backfilled from existing QA briefing under founder instruction
date_created: '2026-03-24'
status: SUPERSEDED
---

# Strategy Specification

## Strategy
Strategy1 trades the ATM CE option for the configured underlying in paper mode using completed 1-minute candles only. Entry requires three consecutive red candles. Exit uses an ATR-based trailing stop and a square-off fallback.

## Instrument
- Underlying: `NIFTY 50` by default
- Traded instrument: ATM Call option (`CE`) resolved at signal time
- Quantity: configured lot size, default `25`
- Execution mode today: paper only

## Timeframe
- Evaluation cadence: completed `1m` candle close
- No intrabar entry or exit decisions
- Dedup namespace is tied to the closed candle timestamp, not wall-clock time

## Entry Conditions
1. Evaluate only on a confirmed 1-minute candle close.
2. Treat a candle as red when `open > close`.
3. Maintain a stable count of consecutive red candles using completed candles only.
4. When `redCount >= 3` and ATR trailing base is available, emit a `BUY` for the resolved ATM CE instrument.
5. Enter only when the strategy is not already in `PENDING_ENTRY`, `IN_POSITION`, or `PENDING_EXIT`.

## Exit Conditions
1. While in position, compute trailing base from completed candles only using ATR period `5` and factor `2.0`.
2. Initialize trailing stop from the entry bar trailing base and ratchet upward only.
3. Emit `SELL` with reason `atr_trailing_exit` when the latest completed candle close falls below the active trailing stop.
4. Emit `SELL` on square-off if still in position near market close.
5. Do not emit another exit while `PENDING_EXIT` already exists.

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

## Ambiguities Resolved
- Founder approved using the existing Strategy1 briefing plus the PineScript reference as the authoritative source material for this backfilled spec.
- Entry threshold is fixed at three consecutive red 1-minute candles for this strategy mode.
- Exit logic is the ATR trailing-stop behavior reflected in the Strategy1 PineScript reference and current live briefing.

## Platform Requirements
- Strategy worker must persist and restore `pendingEntryContext`, `entryContext`, `pendingExitContext`, `lastEvaluatedBarTime`, and dedup fingerprint state.
- Order lifecycle updates must reach the strategy worker without collapsing distinct states like `acknowledged` and `filled` into one processed event.
- Backend must expose enough Strategy1 state for operator/frontend paper-parity observation.

## Notes
This spec is a documentation backfill for an already-implemented Strategy1 that has reached paper trading. It records the intended behavior for the current rework cycle and does not imply founder live approval.
