# Platform Bootstrap — Active Mode

You are Claude Code operating as a full engineering team
on an in-house algorithmic trading platform.

Read these files completely before doing anything:
1. AGENTS.md
2. agents/roles/ROLE_07_TEAM_WORKFLOW_ORCHESTRATION.md
3. agents/roles/ROLE_02_SENIOR_BACKEND_ENGINEER.md
4. packages/strategies/intraday/strategy1Live.js
5. apps/order-manager/src/orderManager.js
6. apps/risk-manager/src/riskManager.js
7. apps/market-data-service/src/marketDataService.js

Then read every file in apps/, packages/, and tests/unit/

After reading, do not produce a report.
Instead, immediately begin the work below.

---

## What to Do — In This Exact Order

### Phase 1 — Fix What is Broken (Senior Backend role)

Find and fix issues in this priority order.
Fix one thing completely before moving to the next.
For each fix:
- Read the relevant existing code first
- Write the fix
- Write or update the test for it
- Confirm the test passes
- Then move to the next fix

Priority order:

**1. console.log → pino structured logging**
Find every console.log in apps/ and packages/
Replace with pino structured logging
Use the mandatory fields from ROLE_02:
  event, strategy_id, execution_id, timestamp_utc

**2. Signal deduplication — make it atomic**
Find the signal publishing code
If it uses GET then SET: replace with atomic SET NX
If it uses Date.now() in fingerprint: replace with
  candle close timestamp UTC
If it does not exist at all: implement it

**3. Redis Pub/Sub → Redis Streams for critical events**
Find all redis.publish() calls in:
  - strategy worker signal publishing
  - order manager order events
  - any other critical event path
Replace with redis.xadd() to named streams
Add consumer group reading with redis.xreadgroup()
Add acknowledgement after successful processing
Add idempotent consumer check before processing

**4. State persistence — ATR stop and state to PostgreSQL**
Find the strategy worker state management
If ATR trailing stop is only in memory: persist it to DB
  on every update so restart recovery works
If state is not restored from PostgreSQL on startup:
  add restoreState() method following Strategy1Live pattern

**5. Risk Manager daily loss calculation**
Find the daily loss tracking code in riskManager.js
Verify it only counts REALIZED losses (on SELL fills)
If it counts BUY order value as loss: fix it
Add a test that proves:
  - BUY placed → daily loss unchanged
  - SELL filled at loss → daily loss increases correctly

**6. Idempotent migrations**
Find all migration files in scripts/ or migrations/
Add IF NOT EXISTS to every CREATE TABLE
Add IF NOT EXISTS to every ADD COLUMN
Add ON CONFLICT DO NOTHING to every INSERT

---

### Phase 2 — Add What is Missing (Senior Backend + Mid Backend)

After Phase 1 is complete, add these in order:

**1. Angel One WebSocket reconnect**
Check if reconnect logic exists in marketDataService.js
If missing or incomplete: implement it
Requirements:
- Exponential backoff (start 1s, max 30s)
- On reconnect: resubscribe all active instruments
- Set circuit breaker to halt orders during disconnect
- Clear circuit breaker after successful reconnect + resubscribe
- Structured log on every reconnect attempt and success

**2. Startup reconciliation**
Check if reconcile.js or equivalent exists in scripts/
If missing: create scripts/reconcile.js
Requirements (from ROLE_02):
- Fetch open positions from Angel One REST API
- Fetch open positions from PostgreSQL
- Log any orphaned positions (at broker, not in DB)
- Load verified positions into Redis
- Restore ATR stop values into Redis
- Must complete before any strategy worker starts

**3. Square-off scheduler**
Check if a square-off scheduler exists
If missing: create it
Requirements:
- Time sourced from config (not hardcoded)
- Default: 3:15 PM IST for options
- On trigger: call onSquareOff() for every IN_POSITION worker
- Log every square-off trigger with UTC timestamp
- Test: verify it fires at correct time and closes position

---

### Phase 3 — Tests (QA role)

After Phase 2 is complete, write missing tests.
Read existing tests/unit/ first to avoid duplicates.

Write tests for:

**State machine transitions** (if not already covered)
- IDLE → PENDING_ENTRY on signal
- PENDING_ENTRY → IN_POSITION on fill
- PENDING_ENTRY → IDLE on rejection
- IN_POSITION → PENDING_EXIT on exit condition
- PENDING_EXIT → IDLE on sell fill
- IN_POSITION → IDLE on square-off

**Restart recovery** (if not already covered)
- Restart in PENDING_ENTRY → no phantom entry
- Restart in IN_POSITION → position restored with ATR stop
- Restart in PENDING_EXIT → no duplicate exit order

**Signal deduplication** (if not already covered)
- Same fingerprint → second signal dropped
- Different candle timestamp → different fingerprint

**Risk Manager** (if not already covered)
- BUY placed → daily loss unchanged
- SELL at loss → daily loss increases
- Concurrent signals → atomic margin check prevents double-spend

---

### Phase 4 — Tell Me What Needs a Human Decision

After completing Phases 1, 2, and 3, THEN produce a short
summary. Only include things that genuinely require a
founder decision — not things the team can resolve internally.

Format:
```
## What was fixed
[list of changes made, one line each]

## What was added
[list of new components added]

## Tests added or updated
[list]

## Decisions needed from you (founder)
[Only real decisions — not engineering questions]

For each decision:
Question: [one sentence]
Context: [why you need this answer]
Options: [2-3 concrete choices]
```

---

## Rules During This Session

- Fix one thing completely before starting the next
- Run tests after every fix — confirm they pass
- Never modify .env.prod
- Never restart any running service
- Never deploy anything
- If you find something that needs a founder decision
  to proceed: stop that specific task, note it in
  Phase 4, move to the next task
- Do not ask for permission to read files
- Do not ask for permission to run tests
- Do not ask for permission to write new files
- Do ask before: deleting existing files, changing
  config values, modifying database schema
