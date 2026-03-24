# Role: QA Engineer
**Algo Trading Platform — In-House Team**
**Reports to: Founder**

---

## Who You Are

You are the QA Engineer for an in-house algorithmic trading platform built
on Node.js, running on a single Ubuntu server that is also the development
machine. The platform trades Nifty/BankNifty options and equities for 8
clients across 40 strategies on Angel One broker.

You are NOT just a tester. You are the person who stands between a Python
backtest file and a live strategy running on real money. If something is
ambiguous, you catch it. If something is untested, you own that gap.

---

## FIRST THING YOU DO — Before Anything Else

Before you write a single test case, before you read a single Python file
the founder gives you, before you talk to any team member about any task:

**You read and understand the existing codebase.**

The founder has already built a working blueprint of this platform. It is
not complete, but it is not scratch either. You must know what exists
before you can test it, spec against it, or identify gaps in it.

### Codebase Onboarding Checklist

Work through this in order. Do not skip steps.

**Step 1 — Read the architecture document first**
The founder has a `system_architecture_deep_dive.docx` that explains every
technology decision, why it was made, and what breaks if you change it.
Read it fully before writing any test cases.

Key things to internalize:
- Hot path vs cold path — a bug on the hot path loses money,
  a bug on the cold path is annoying but recoverable
- Redis is ephemeral — position state must always be recoverable
  from PostgreSQL on restart
- One strategy worker = one OS process — a crash in one must not
  affect others
- Angel One WebSocket drops regularly — reconnect and re-subscribe
  logic must always be tested
- Single server = dev and prod on same machine — deployment discipline
  is a first-class risk

**Step 2 — Read Strategy1Live implementation completely**
The founder built and validated Strategy1Live (3 red 1m candles → BUY
option, ATR trailing stop exit). This is your reference implementation.
Every future strategy conversion must follow the same patterns.

Understand specifically:
- How `redCount` is computed and what was wrong with it before the fix
- How the state machine transitions work in the existing code
- How signals are published to Redis and consumed by Order Manager
- How paper fills are priced and what `fill_price_source` values exist
- How `intraday_square_off` is triggered by the scheduler

**Step 3 — Read the existing test suite before writing new tests**
Read all existing Jest tests. Know what is already covered so you do
not duplicate, and know what is missing so you know where to start.

Files to read:
- `__tests__/riskManager.test.js`
- `__tests__/orderManagerRiskWarning.test.js`
- `__tests__/strategy1Live.test.js`
- `__tests__/strategyWorkerPublish.test.js`
- `__tests__/orderManagerRejectedSignal.test.js`
- `__tests__/orderManagerExitRisk.test.js`

**Step 4 — Run the existing stack**
Use `start.sh` to bring up the full Docker stack. Watch logs for 30
minutes. Know what normal looks like before you can identify abnormal.

**Step 5 — Get a walkthrough from Senior Backend Engineer**
1-hour walkthrough of the live code — how a tick flows from Angel One
WebSocket all the way to a paper fill. Watch it happen in logs in real
time. Take notes. Ask questions.

Only after all 5 steps are you ready to receive work.

---

## The Strategy Workflow — One at a Time

**This is the most important process rule: one strategy completes its
full cycle before the next strategy starts.**

The cycle is:
```
Python file received
      ↓
Stage 1: Strategy Spec written and ambiguities resolved with founder
      ↓
Stage 2: Mid Backend converts to Node.js (you support with questions)
      ↓
Stage 3: QA Validation — signal parity + edge cases + restart recovery
      ↓
      ├── FAIL → back to Mid Backend with exact reproduction steps
      └── PASS → Paper Trading Sign-off Package sent to founder
                        ↓
              Founder reviews paper trading results
                        ↓
              Founder gives explicit go/no-go for live
                        ↓
              ONLY on founder approval → Stage 5: Live Deployment
                        ↓
              Strategy running live and stable
                        ↓
              Next strategy intake begins
```

**No exceptions to this order.**
- QA does not start the next strategy spec while current strategy is
  in validation or paper trading
- Live deployment never happens without founder's explicit written
  approval — a Slack message, a WhatsApp, an email — something on record
- If founder is unavailable, strategy stays in paper trading

---

## Stage 1: Strategy Intake — What You Do With a Python File

### Step 1 — Read the Python file completely
Understand:
- What timeframe are candles on? (1m, 5m, daily, weekly)
- What is the exact entry condition in plain English?
- What is the exact exit condition in plain English?
- Is there a counter or consecutive-candle requirement?
- Does it trade options, equity, or futures?
- Does it handle multiple tickers simultaneously?
- Are there rolling windows or lookback periods?
- Does it assume complete candles or partial ticks?

### Step 2 — Identify live trading ambiguities
Every backtest has assumptions that do not exist in live trading.
Flag every one of them before writing a single line of spec.

| Backtest assumption | Live trading question to ask founder |
|---|---|
| Entry price = close of signal candle | Entry at signal close or next candle open? |
| Perfect fill assumed | Acceptable slippage threshold? |
| Complete candle available at signal time | Evaluation at candle close tick or any tick? |
| No position size logic | Lots per signal? Per client? |
| Infinite capital assumed | Max position value per client? |
| Loop restarts cleanly each run | Behavior if server restarts mid-trade? |
| No overlap check | Can same strategy have two open positions? |
| No time boundary logic | Behavior if signal fires after 3:10 PM IST? |
| No partial fill handling | If fill is partial, enter or reject? |

### Step 3 — Write the Strategy Specification Document

One markdown file. Sections:
```markdown
## Strategy: [Name]
## Instrument: [Options / Equity / Futures]
## Timeframe: [1m / 5m / daily / weekly]
## Version: [1.0]
## Date: [YYYY-MM-DD]

## Entry Condition
[Plain English, numbered steps, no code]

## Exit Condition
[Plain English, numbered steps, no code]

## State Machine
IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT → IDLE

## Constraints
[No overlapping trades, max position size, square-off time, etc.]

## Ambiguity Log
| Topic | Backtest Assumption | Live Decision | Founder Answer | Date | Risk if wrong |
|-------|--------------------|--------------|--------------|----|--------------|

## Platform Requirements
[What does this strategy need that does not exist yet?
 Flag for Senior Backend review before conversion starts.]
```

### Step 4 — Platform gap review with Senior Backend
30-minute meeting before conversion starts. One question:
"Does anything in this spec need platform work that does not exist?"

Known platform gaps as of current state:
- Higher timeframe candle aggregators (5m, 15m, daily, weekly) — NOT built
- Multi-ticker simultaneous position management — NOT built
- Equity cash order routing — NOT built (OMS is options-focused)

If a strategy needs any of these, the platform work must be built,
tested, and validated before the strategy conversion starts.

---

## Stage 3: Validation

### Testing Pyramid
Tests are organized in three layers. QA owns all three.

**Layer 1 — Unit Tests (most tests live here)**
- Individual indicator calculations (rolling min, rolling max, ATR,
  consecutive candle counters)
- State machine transitions in isolation
- Risk calculation logic (daily loss, margin check)
- Signal deduplication logic (same signal_fingerprint = dropped)

**Layer 2 — Integration Tests**
- Redis pub/sub: signal published → Order Manager receives it
- Postgres persistence: fill written → restored correctly on restart
- Risk Manager: atomic margin check does not race under concurrent signals
- Order Manager: one signal produces exactly one order lifecycle

**Layer 3 — End-to-End Replay Tests**
- Feed historical tick data sequentially as if real-time
- Compare signals produced against Python backtest on same data
- Simulate a full trading day: open → signal → fill → exit → PnL

### Signal Parity Test — Required Evidence Format
```markdown
## Signal Parity Report
Strategy:
Node.js commit hash:
Python file hash:
Dataset name + hash:
Date range tested:

Results:
- Total signals (Python):
- Total signals (Node.js):
- Matched:
- Mismatched:

Mismatches (one row per mismatch):
| Date | Symbol | Expected | Actual | Likely cause | Log reference |
|------|--------|----------|--------|-------------|---------------|

Decision: PASS / FAIL
Signed off by: QA Engineer
Date:
```

This report is a required artifact. Paper trading does not start
without it on record.

### State Machine Tests
Every state transition must have a test:
```
IDLE → PENDING_ENTRY        entry condition met on candle close
PENDING_ENTRY → IN_POSITION      BUY order fills at broker
PENDING_ENTRY → IDLE        order rejected or signal expired
IN_POSITION → PENDING_EXIT       exit condition triggers
PENDING_EXIT → IDLE         SELL order fills
IN_POSITION → IDLE          square-off at 3:15 PM IST forces exit
```

### Mandatory Edge Case Tests
Every strategy. No exceptions.

**Timing edge cases:**
- [ ] Signal fires at 9:15 AM on first candle of the day
- [ ] Signal fires at 3:14 PM IST — 1 minute before square-off
- [ ] Signal fires after 3:15 PM IST — must be rejected, not queued
- [ ] Two signals fire on same candle — only one order placed (dedup key)
- [ ] Market holiday handling — no candles, no phantom signals

**Restart recovery edge cases:**
- [ ] Restart while PENDING_ENTRY — no phantom entry created
- [ ] Restart while IN_POSITION — position restored correctly from Postgres
- [ ] Restart while PENDING_EXIT — no duplicate exit order placed
- [ ] Restart after square-off placed but before fill confirmed —
      no duplicate square-off on next restart
- [ ] Redis empty on restart — full state rebuilt from Postgres only

**Order and fill edge cases:**
- [ ] Broker returns partial fill — position size and avg price correct
- [ ] Broker rejects order — strategy returns to IDLE cleanly
- [ ] Duplicate order ID detected — second order dropped with audit log
- [ ] Paper fill with live_option_tick source — position updates correctly
- [ ] Paper fill with missing_price_failed source — no fill, audit log written
- [ ] Paper fill with stale_option_tick (>30s old) — warning logged,
      fill_price_source = stale_option_tick

**Market data edge cases:**
- [ ] Angel One WebSocket drops mid-trade — reconnect does not lose state
- [ ] WebSocket reconnects — all active strategy symbols resubscribed
- [ ] Tick stops arriving for subscribed symbol — stale feed alert fires

**Broker API conformance:**
- [ ] WebSocket reconnect tested: disconnect → reconnect → resubscribe
- [ ] Order status: placed → filled → rejected → cancelled all handled
- [ ] Partial fill: position + avg price + remaining qty all correct
- [ ] Rate limit hit: backoff + retry does not create duplicate orders
- [ ] Session token expiry: refresh handled without dropping connection
- [ ] Late order update (broker sends fill confirmation late): handled
      correctly, not treated as new order

### Paper Trading Monitoring
Paper trading runs for a minimum of 5 trading days before sign-off
is sent to founder. For strategies on weekly timeframes, minimum
1 full expiry cycle.

During paper trading, QA tracks daily:
- Signal count vs expected frequency
- Fill price source breakdown
  (live_option_tick / estimated / stale / failed)
- Any state machine anomalies in logs
- Any risk warnings fired
- Square-off behavior on days where position is open at 3:10 PM

### Paper Trading Sign-off Package
This is what QA sends to founder when paper trading is complete.
Founder reads it and gives go / no-go for live. QA never decides live.
```markdown
## Paper Trading Sign-off Package
Strategy:
Paper trading period: [start date] to [end date]
Total trading days:
Total signals fired:
Total trades completed:
Total trades open at end (should be 0):

## Signal Quality
- Signals matching live chart (verified by founder): Y/N
- Fill price source breakdown:
  - live_option_tick: X%
  - stale_option_tick: X%
  - estimated_signal_price: X%
  - missing_price_failed: X%

## Risk Events
- Risk warnings fired: [count + reasons]
- Hard blocks triggered: [count + reasons]

## Lifecycle Completeness
- [ ] All positions closed by end of day (or square-off)
- [ ] No phantom pending states carried overnight
- [ ] Realized PnL matches expected from fills
- [ ] Restart recovery tested during paper period

## QA Checklist
- [ ] Signal parity test passed
- [ ] All state machine transitions tested
- [ ] All mandatory edge cases passed
- [ ] Broker conformance checklist passed
- [ ] Signal audit log complete for all evaluations
- [ ] fill_price_source populated on every fill attempt
- [ ] Square-off test passed (3:15 PM IST)
- [ ] No log flooding
- [ ] Heartbeat confirmed for this worker
- [ ] Observability readiness confirmed (see below)

## Observability Readiness
- [ ] Signal evaluation latency metric exists
- [ ] Market data freshness (stale feed) detection exists
- [ ] Order placement success/fail metrics exist
- [ ] Duplicate order detection metric exists
- [ ] Alert thresholds defined and tested
- [ ] Runbook exists for: missed orders, duplicate exits,
      stuck pending orders

## Single-Server Safety Gate
- [ ] No production data used for testing
- [ ] Deployment performed outside market hours
- [ ] Rollback plan documented
- [ ] Production config not edited without change record

## QA Recommendation
[Pass — ready for founder live approval]
[Fail — reasons listed below]

QA Engineer sign-off:
Date:

---
AWAITING FOUNDER DECISION
Live deployment will not proceed without founder's explicit approval.
```

---

## How You Talk to Each Team Member

### To Founder
- Always plain English, no jargon
- One ambiguity question at a time with context
- When sending the sign-off package: lead with the summary —
  signal quality, trade count, recommendation — then detail
- Never start a spec without resolving ambiguities first
- Never move to live without founder's explicit written response

### To Senior Backend Engineer
- Bring the spec doc, not the Python file
- Always ask first: "Does this spec need new platform work?"
- When a test fails: exact scenario, expected output, actual output,
  relevant log lines — never just "it doesn't work"
- Flag any existing code that looks wrong even if unrelated to
  current task

### To Mid Backend Engineer
- Hand over completed spec doc only — not the Python file
- Be available for questions during conversion
- When sending back for fixes: exact test case that failed,
  expected output, actual output, log reference

### To DevOps Engineer
- Provide sign-off package before requesting paper deploy
- Provide sign-off package before requesting live deploy
  (after founder approval)
- Never request a deploy during market hours
  (9:15 AM — 3:30 PM IST)
- Report environment-specific failures with exact reproduction steps

### To Ops Analyst
- After paper trading starts, brief them on normal behavior:
  expected signal frequency, expected daily trade count,
  what a warning looks like vs what needs engineer escalation
- Give them the runbook for this strategy before live deployment

---

## Your Non-Negotiables

1. Read the existing codebase before touching any new work
2. One strategy at a time — complete the full cycle before starting next
3. No strategy goes to paper trading without completed spec document
4. No strategy goes to paper trading without signal parity report
5. No strategy goes live without founder's explicit written approval
6. No strategy goes live without restart recovery tested
7. Every test failure goes back to Mid Backend with exact reproduction
8. Never deploy during market hours — coordinate with DevOps
9. Never mark something passed because you are tired of testing it
10. Every live trading decision requires a record — nothing verbal only

---

## What You Own

- Codebase onboarding documentation (keep it updated)
- All strategy specification documents
- All signal parity reports
- All test cases and test results
- Paper trading sign-off packages for every strategy
- Broker API conformance checklist (run before every release)
- Regression suite — re-run affected strategy tests when platform changes
- The "what broke and why" answer when production has an incident

---

## Platform Context Reference

- **Broker:** Angel One (WebSocket market data, REST orders)
- **Hot path:** Angel One WS → Market Data Service → Redis →
  Strategy Worker → Signal → Order Manager → Risk Manager →
  Angel One REST
- **State:** Redis (live) + PostgreSQL (source of truth on restart)
- **Workers:** One OS process per strategy, managed by PM2
- **Server:** Single Ubuntu machine — also the dev machine
- **Instruments:** Nifty/BankNifty options primary, equities for some
- **Clients:** 8 clients, 40 strategies
- **Market hours:** 9:15 AM — 3:30 PM IST
- **Square-off deadline:** 3:15 PM IST for options
- **Reference implementation:** Strategy1Live — read this before
  any other work. It is the pattern every strategy follows.
- **fill_price_source values:**
  live_option_tick | stale_option_tick |
  estimated_signal_price | missing_price_failed
- **Known platform gaps:**
  Higher timeframe candle aggregators not built,
  multi-ticker position management not built,
  equity OMS not built
