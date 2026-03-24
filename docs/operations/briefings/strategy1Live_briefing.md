---
artifact_type: strategy_briefing_sheet
strategy_id: strategy1
strategy_name: STRATEGY1_LIVE
version: "1.0"
status: paper_trading
created: 2026-03-20
author: Claude Code (QA Engineer role)
---

# Strategy Briefing Sheet — STRATEGY1_LIVE

## 1. Identity

| Field | Value |
|---|---|
| Strategy Name | STRATEGY1_LIVE |
| Class File | `packages/strategies/intraday/strategy1Live.js` |
| Core Logic File | `packages/strategies/intraday/strategy1Core.js` |
| Evaluation Mode | `1m_close` (evaluates on every 1-minute candle close) |
| Status | Paper trading (live broker execution NOT yet implemented) |
| Default Symbol | NIFTY 50 |
| Default Quantity | 25 (lot size) |

---

## 2. Strategy Logic Summary

### Entry Condition
Buys an ATM Call option (CE) when `N` consecutive red 1-minute candles are observed.
- A candle is "red" when `open > close`.
- `N = maxRed` — configurable. Default: `fixedMax=true, maxRed=3`.
- Without `fixedMax`: NIFTY 50 = 7, NIFTYBANK = 5, others = 6 (data-driven).
- Entry evaluates once per bar (guarded by `lastEvaluatedDate` dedup).

### Exit Condition
Sells when the candle close drops below the **ATR trailing stop**.
- ATR period: 5 bars.
- ATR factor: 2x (NIFTY 50, BANKNIFTY) or 4x (NIFTYMIDCAP100).
- Trailing stop base at entry: `(entry_bar.high + entry_bar.low) / 2 - ATR * factor`.
- Stop ratchets upward (never down) as subsequent bars produce higher trailing bases.
- Also exits on scheduled square-off (`onSquareOff()`) at market close.

### Instrument Resolution
ATM CE strike is resolved at signal time via `resolveAtmOptionInstrument()`.
- Prefers DB lookup (`database` source).
- Falls back to estimated strike if DB lookup fails (`fallback` source).
- Resolution status tracked: `resolved` | `unresolved`.

---

## 3. State Machine

Strategy1Live uses context objects rather than explicit state strings.

| Logical State | Condition |
|---|---|
| IDLE | `entryContext == null && pendingEntryContext == null` |
| PENDING_ENTRY | `pendingEntryContext != null` — BUY signal emitted, awaiting fill |
| IN_POSITION | `entryContext != null` — BUY confirmed filled |
| PENDING_EXIT | `entryContext != null && pendingExitContext != null` — SELL emitted, awaiting fill |

**Transitions:**
- `IDLE → PENDING_ENTRY`: N consecutive red candles detected → BUY signal emitted
- `PENDING_ENTRY → IN_POSITION`: `handleExecutionUpdate()` receives `filled` on BUY order
- `PENDING_ENTRY → IDLE`: order rejected/cancelled/failed
- `IN_POSITION → PENDING_EXIT`: ATR trailing stop triggers / `onSquareOff()` called → SELL signal emitted
- `PENDING_EXIT → IDLE`: `handleExecutionUpdate()` receives `filled` or `rejected/cancelled/failed` on SELL order

---

## 4. Key Parameters

| Parameter | Default | Notes |
|---|---|---|
| `symbol` | `NIFTY 50` | Underlying index |
| `quantity` | `25` | Option lot size |
| `maxRed` | `3` | Consecutive red candles needed for entry |
| `fixedMax` | `true` | If false, symbol-specific maxRed applies |
| `evaluationMode` | `1m_close` | Evaluates on each 1m candle close |
| `candlePeriod` | `1min` | Candle timeframe |
| `useHistoricalApi` | `false` | Bootstrap from Angel One API vs CSV file |
| `historyPath` | `Data/idx_data.csv` | CSV fallback for bar history |
| ATR period | `5` | Bars for ATR calculation (in strategy1Core) |
| ATR factor | `2` | Multiplier for trailing stop band (in strategy1Core) |
| `signalCooldown` | `60,000 ms` | Minimum 60s between signals |

---

## 5. Bootstrap / Warm-Up

On `onInit()`, the strategy loads historical 1-minute bars to warm up ATR calculations:

1. **Primary**: Query `market_ohlc_1m` table for the latest trading day bars for the symbol.
2. **Fallback**: Load from `Data/idx_data.csv` CSV file.
3. **None**: Strategy starts with empty bar history (insufficient data scenario).

Source tracked in `historyBootstrapSource`: `market_ohlc_1m` | `csv_fallback` | `none`.

---

## 6. State Persistence

Runtime state is persisted to `strategy_instances.runtime_state` (JSONB) after every evaluation
and after every position state transition. Persisted fields:

- `lastEvaluatedBarTime` — prevents double-evaluation on restart
- `lastSignalFingerprint`
- `entryContext` — instrument, entry price, entry date, instrument token
- `pendingEntryContext` — event ID, entry date, instrument, entry price
- `pendingExitContext` — event ID, instrument, exit reason

On restart, `restoreRuntimeState()` reloads all of the above from DB.

---

## 7. Signal Fingerprint

Fingerprint is built deterministically from:
- `strategyInstanceId` + `symbol` + `action` + `triggerBarTime` (candle bar close time in IST)
- SHA-256 hash, hex-encoded.
- Does NOT use `Date.now()` — safe against restart-based duplication.
- Stored in `signals.signal_fingerprint`.
- Protected by DB UNIQUE constraint `idx_signals_signal_fingerprint_unique`.

---

## 8. Logging

Every evaluation emits a pino INFO log:
```
Strategy1 evaluation action=<BUY|SELL|NONE> reason=<...> symbol=<...>
tradeDate=<barTime> redCount=<N> atr=<N> trailingStop=<N>
```

Fields logged: `instanceId`, `strategyId`, `action`, `reason`, `inPosition`, `tradeDate`,
`redCount`, `atr`, `trailingStop`, `referencePrice`, `historyBars`, `historyBootstrapSource`.

---

## 9. Ops Monitoring Checklist (15-min rhythm)

| Check | What to look for | Alert threshold |
|---|---|---|
| `historyBootstrapSource` | Should be `market_ohlc_1m` during live session | `none` = CRITICAL |
| `redCount` in logs | Should move 0→N and reset on entry | Stuck at maxRed+ = investigate |
| `entryContext` in diagnostics | Non-null when in position | Should transition PENDING_ENTRY → IN_POSITION within 2 mins |
| `pendingEntryContext` stuck | If pendingEntry never clears, broker may have failed | >5 min stuck = WARNING |
| `pendingExitContext` stuck | Pending exit for >5 min at square-off = CRITICAL | >5 min at 3:10+ IST = CRITICAL |
| ATR value | Should be non-null once 5+ bars available | `null` after 9:25 AM = WARNING |
| Signal fingerprint logged | Should appear on every BUY/SELL | Missing = dedup may have blocked valid signal |

---

## 10. Square-Off Behaviour

`onSquareOff(reason)` is called by WorkerManager when the market scheduler fires
`square_off_all_strategies`. Sends a SELL signal for current position.

- If `entryContext == null`: no-op (not in position).
- If `pendingExitContext != null`: no-op (exit already pending).
- Uses `this.lastTick.ltp` or `entryContext.entryPrice` as reference price.
- Sets `pendingExitContext` and persists state.

Expected square-off time: driven by `config.scheduler.strategyPause` (config-driven ✓).

---

## 11. Known Risks and Limitations

1. **ATM option resolution**: If the DB lookup fails and the fallback is used, the instrument token may be incorrect. `instrumentResolutionStatus = "unresolved"` in signal metadata when this occurs. The order manager should reject such signals in live mode.
2. **Bar history cap in BaseStrategy**: `candles` array is capped at 100. Strategy1 uses `barHistory` array separately (no hard cap). But `this.candles` in BaseStrategy (used by `processCandle`) has a 100-bar cap — not used by Strategy1Live directly (it manages its own `barHistory`).
3. **Restart during PENDING_ENTRY**: If restart occurs after BUY signal is emitted but before fill confirmation, `pendingEntryContext` is restored. The order may have already filled. Without startup reconciliation against broker, this creates a risk of position divergence.
4. **No live broker execution**: Strategy1Live currently operates in paper mode only. All fills are simulated by the OrderManager's `simulatePaperFill()`.
5. **Signal dedup — Pub/Sub gap**: Signal arrives at OrderManager via Redis Pub/Sub (at-most-once). If the message is lost (node restart between publish and consume), the signal is not replayed. DB UNIQUE constraint blocks duplicate signals if re-sent, but doesn't handle lost signals.

---

## 12. Missing Documentation Flags

- [ ] **Signal Parity Report**: Does NOT exist. Required before Strategy1 is considered fully documented.
  Create as: `specs/strategy1_signal_parity_v1.0.0.md`
- [ ] **Strategy Specification Document (SSD)**: Does NOT exist. Required before live deployment.
  Create as: `specs/strategy1_spec_v1.0.0.md`

Both must be created and reviewed before Strategy1 proceeds to Stage 7 (live deployment) in the
one-at-a-time pipeline.
