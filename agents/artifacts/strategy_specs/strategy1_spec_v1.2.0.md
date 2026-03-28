---
artifact_type: strategy_spec
strategy_id: strategy1
strategy_version: 1.2.0
timeframe: 1day_default_with_optional_1min_5min_15min_with_vwap_gate
instrument_type: options
requires_platform_gaps:
- manual_position_correction_audit_flow
ambiguities_resolved: true
founder_approval_ref: '2026-03-27 founder instruction: keep Strategy1 live daily in-progress bar baseline, move daily decision earlier to 15:00-15:15 IST using real VWAP from 1-minute data, apply VWAP as BUY filter in all supported timeframes, and add dashboard mismatch alert plus audited manual position correction with manual trade record'
qa_author: QA artifact refresh backfilled from founder instruction and existing Strategy1 artifacts
date_created: '2026-03-27'
status: APPROVED
---

# Strategy Specification

## Strategy
Strategy1 trades the ATM CE option for the configured underlying in paper mode using a configurable bar timeframe. The default timeframe remains `1day`, with optional `1min`, `5min`, and `15min` modes per strategy instance. The base entry and exit rules remain the same: enter after consecutive red bars and exit on an ATR-based trailing stop with square-off fallback. This version adds a real VWAP BUY filter and an audited manual position-correction workflow.

## Instrument
- Underlying: `NIFTY 50` by default
- Traded instrument: ATM Call option (`CE`) resolved at signal time
- Quantity: configured lot size, default `25`
- Execution mode today: paper only

## Timeframe
- Canonical instance parameter: `parameters.timeframe`
- Allowed values: `1day`, `1min`, `5min`, `15min`
- Default value for Strategy1: `1day`
- Canonical live source for all modes remains retained and live `market_ohlc_1m` minute history
- `1min`, `5min`, and `15min` evaluate on completed timeframe bars and apply the session VWAP BUY gate at the decision bar close
- `1day` builds the in-progress daily bar from 1-minute history and evaluates the day signal during `15:00-15:15 IST`
- Daily mode uses minute-level VWAP in the `15:00-15:15 IST` window to predict the current day close context and decide that same day's daily-bar entry
- Timeframe changes are saved immediately but take effect only after the operator stops and starts the strategy instance
- Signal dedup namespace remains tied to the logical bar anchor, not wall-clock time

## Entry Conditions
1. Use the configured timeframe to build the decision bar series from canonical 1-minute market history.
2. Treat a bar as red when `open > close`.
3. Maintain a stable count of consecutive red bars using the configured timeframe bars only.
4. When `redCount >= 3` and ATR trailing base is available, the base Strategy1 rule becomes entry-eligible.
5. A BUY is emitted only if the VWAP gate also passes.
6. VWAP gate rule: the decision price must be above the real session VWAP derived from 1-minute candles.
7. For `1day`, evaluate entry during `15:00-15:15 IST` using the in-progress daily bar plus the minute-level VWAP gate in that same window.
8. Enter only when the strategy is not already in `PENDING_ENTRY`, `IN_POSITION`, or `PENDING_EXIT`.

## Exit Conditions
1. While in position, compute trailing base from the configured timeframe bars only using ATR period `5` and factor `2.0`.
2. Initialize trailing stop from the entry bar trailing base and ratchet upward only.
3. Emit `SELL` with reason `atr_trailing_exit` when the latest eligible timeframe bar close falls below the active trailing stop.
4. Emit `SELL` on square-off if still in position near market close.
5. Do not emit another exit while `PENDING_EXIT` already exists.
6. After an operator/manual exit or correction within a timeframe bar, do not re-enter on that same logical bar; the next eligible entry can happen only on the next timeframe bar.
7. VWAP is not an exit rule in this version.

## State Machine
- `IDLE`: no pending or open position context
- `PENDING_ENTRY`: BUY signal emitted, waiting for order lifecycle to confirm fill
- `IN_POSITION`: BUY fill confirmed and trailing stop active
- `PENDING_EXIT`: SELL signal emitted, waiting for exit order lifecycle completion
- Manual position correction may repair persisted/runtime state but must preserve explicit audit metadata and must not silently bypass state tracking

## Manual Position Mismatch Handling
- A mismatch alert must surface when strategy runtime state, positions state, and recorded execution state diverge.
- The operator may perform a manual position correction from the dashboard.
- Manual correction updates platform/runtime position state to the operator-declared truth and creates a manual correction record plus a manual trade/history record.
- Manual correction does not place a broker or OMS order automatically.
- Manual correction must require operator intent, a reason, and audit logging.

## Constraints
- One position at a time, no pyramiding.
- Critical events must use durable delivery (`stream:strategy_signals`, `stream:order_updates`).
- Strategy state must restore correctly from persisted runtime state after restart.
- Unresolved option resolution is acceptable in paper mode for parity observation, but not for live trading.
- Paper/live separation must remain explicit; this artifact does not approve live broker execution.
- New operator correction controls are audit-bound and must not silently change state.

## Ambiguities Resolved
- Founder kept the live daily in-progress bar baseline rather than switching to a previous-closed-bar daily contract.
- Founder moved the daily decision window from `15:20-15:30 IST` to `15:00-15:15 IST`.
- Founder selected real VWAP, not bar-close proxy, as the BUY filter.
- Founder selected BUY-only VWAP gating in this version; exit logic remains ATR/manual-based.
- Founder selected audited manual position correction with a manual trade record and dashboard alerting.
- Founder selected combined implementation of strategy logic, validation, and UI changes in one Strategy1 batch.

## Platform Requirements
- Strategy worker must compute session VWAP from 1-minute history for all timeframes.
- Daily validation replay can no longer rely on daily candles alone; it must replay per-day 1-minute history to reproduce the VWAP-gated daily signal.
- Dashboard and API must expose VWAP gate outcome, mismatch status, and manual correction history.
- Manual correction requires an audited API flow and persisted correction record.
- Signal fingerprints for `1day` must still use a deterministic trading-day anchor, not wall-clock time.

## Notes
This spec supersedes Strategy1 v1.1.0. It adds VWAP-gated entry logic and an audited manual position-correction workflow before paper-parity work can continue.
