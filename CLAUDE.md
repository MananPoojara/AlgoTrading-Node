# CLAUDE.md
# AlgoTrading Platform — Claude Code Configuration
# Version: 1.0
# Last updated: 20-03-2026

---

## What This Project Is

In-house algorithmic trading platform. Node.js. Single Ubuntu
server. Angel One broker. 8 clients. 40 strategies.
Market hours: 9:15 AM — 3:30 PM IST.
Do not touch anything during market hours without explicit
founder approval.

---

## How to Operate

Before any task, read these two files in order:
1. .claude/roles/ROLE_07_TEAM_WORKFLOW_ORCHESTRATION.md
2. The role file for the task you are performing

Never start work without reading both.
Never assume context from a previous session — always
re-read the relevant artifacts and role files.

---

## Active Role Files

All roles are in .claude/roles/
- ROLE_01_QA_ENGINEER.md
- ROLE_02_SENIOR_BACKEND_ENGINEER.md
- ROLE_03_MID_BACKEND_ENGINEER.md
- ROLE_04_DEVOPS_ENGINEER.md
- ROLE_05_DATA_ENGINEER.md
- ROLE_06_OPS_ANALYST.md
- ROLE_07_TEAM_WORKFLOW_ORCHESTRATION.md

---

## Non-Negotiables for This Codebase

- Never deploy anything
- Never place any order (paper or live)
- Never modify .env.prod
- Never use Redis KEYS in any script — use SCAN
- Never use plain Pub/Sub for critical events
- Never hardcode square-off time, expiry day, session times
- Never use Date.now() in signal fingerprints
- Never use GET then SET for dedup — always atomic SET NX
- Always read existing code before writing new code
- Always follow platform standards in ROLE_02
- Always use pino structured logging — never console.log
- Always use timestamptz — never naive timestamp columns
- One strategy at a time through the pipeline
- Founder approves live deployment — always in writing

---

## Key Files to Read Before Any Code Task
```
src/strategies/intraday/strategy1Live.js  ← reference implementation
src/strategies/strategyWorker.js          ← worker process wrapper
src/execution/orderManager/orderManager.js
src/risk/riskManager.js
src/marketData/marketDataService.js
config/default.js
```

---

## Skills — Tools the Agent Must Install Before Using

This section defines every tool the agent may need,
why it needs it, and exactly how to install it.

Before using any tool from a category below, check if
it is already installed. If not, install it first.
Never assume a tool exists — always verify.

---

### Category 1 — Node.js Runtime and Package Management

**Required for:** All backend work, strategy conversion,
running tests, executing scripts.
```bash
# Verify Node.js version (must be 18+)
node --version
# If missing or wrong version:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify npm
npm --version

# Install project dependencies (always run before any code task)
npm ci

# If package.json has changed:
npm install
```

---

### Category 2 — Testing (Jest)

**Required for:** QA role, Mid Backend role, Senior Backend
role when validating strategy worker implementations.
```bash
# Check if Jest is available
npx jest --version 2>/dev/null || echo "Jest not found"

# Jest is in package.json devDependencies — install via:
npm ci

# Run all tests
npx jest

# Run a specific test file
npx jest __tests__/strategy1Live.test.js

# Run tests with coverage
npx jest --coverage

# Run tests matching a pattern
npx jest --testNamePattern "state machine"

# Run tests and watch for changes (dev only — never in prod)
npx jest --watch
```

---

### Category 3 — Code Quality (ESLint + Prettier)

**Required for:** Mid Backend role (before opening PR),
Senior Backend role (PR review).
```bash
# Check if ESLint is configured
ls .eslintrc* .eslintrc.js .eslintrc.json 2>/dev/null \
  || echo "ESLint config not found"

# Install ESLint if not in package.json
npm install --save-dev eslint

# Install Prettier if not present
npm install --save-dev prettier

# Run ESLint on changed files
npx eslint src/strategies/intraday/strategyNLive.js

# Run ESLint on entire src directory
npx eslint src/

# Auto-fix ESLint issues where possible
npx eslint src/ --fix

# Run Prettier check (does not modify)
npx prettier --check src/

# Run Prettier format
npx prettier --write src/strategies/intraday/strategyNLive.js
```

---

### Category 4 — Database Tools (PostgreSQL)

**Required for:** Data Engineer role, Senior Backend role
(migrations), QA role (data quality checks).
```bash
# Verify psql is available
psql --version 2>/dev/null || echo "psql not found"

# Install psql client if missing
sudo apt-get install -y postgresql-client

# Connect to development database
# (use .env.dev credentials — never .env.prod directly)
source .env.dev
psql $DATABASE_URL

# Run a migration file
psql $DATABASE_URL -f scripts/migrations/001_add_fill_source.sql

# Run a SQL script and capture output
psql $DATABASE_URL -f scripts/data/daily_contract_tests.sql \
  -o reports/contract_test_results.txt

# Dump schema only (for documentation)
pg_dump $DATABASE_URL --schema-only \
  -f docs/schema_current.sql

# Check table sizes (Data Engineer DB health audit)
psql $DATABASE_URL -c "
  SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
  FROM pg_catalog.pg_statio_user_tables
  ORDER BY pg_total_relation_size(relid) DESC;"
```

---

### Category 5 — Redis Tools

**Required for:** Senior Backend role (testing Redis
patterns), Mid Backend role (verifying stream behavior),
DevOps role (backup verification).
```bash
# Verify redis-cli is available
redis-cli --version 2>/dev/null || echo "redis-cli not found"

# Install redis-cli if missing
sudo apt-get install -y redis-tools

# Ping Redis (verify connection)
redis-cli ping
# Expected: PONG

# Check Redis info
redis-cli info server | grep redis_version
redis-cli info persistence

# Test atomic SET NX pattern (dedup verification)
redis-cli SET "signal:dedup:test123" 1 NX EX 86400
# Expected: OK on first call, nil on second call

# Check stream exists and has messages
redis-cli XLEN stream:strategy_signals

# Read from stream (verify durable delivery)
redis-cli XRANGE stream:strategy_signals - + COUNT 5

# Check consumer groups
redis-cli XINFO GROUPS stream:strategy_signals

# LASTSAVE (for backup verification — not BGSAVE poll)
redis-cli LASTSAVE

# SCAN example (never KEYS)
redis-cli SCAN 0 MATCH "heartbeat:*" COUNT 100
```

---

### Category 6 — Process Management (PM2)

**Required for:** DevOps role, infrastructure audit,
heartbeat verification.
```bash
# Verify PM2 is available
pm2 --version 2>/dev/null || echo "PM2 not found"

# Install PM2 globally if missing
npm install -g pm2

# List all processes
pm2 list

# Show details of one process (including watch status)
pm2 show market-data-service

# Check logs
pm2 logs market-data-service --lines 50

# Verify heartbeats (uses SCAN-based script)
node scripts/verify-heartbeats.js

# Check ecosystem file exists and watch is false
cat ecosystem.prod.js | grep -i watch
# Expected: watch: false for all prod processes

# NEVER run these without founder + Senior Backend approval:
# pm2 restart <name>
# pm2 stop <name>
# pm2 delete <name>
```

---

### Category 7 — Docker

**Required for:** DevOps role, infrastructure audit,
checking Redis and PostgreSQL container state.
```bash
# Verify Docker is available
docker --version 2>/dev/null || echo "Docker not found"
docker-compose --version 2>/dev/null || \
docker compose version 2>/dev/null || \
echo "docker-compose not found"

# Check running containers
docker ps

# Check all containers including stopped
docker ps -a

# Check container logs
docker logs algotrading_redis_1 --tail 50
docker logs algotrading_postgres_1 --tail 50

# Check volume mounts
docker volume ls
docker inspect algotrading_postgres_data

# Disk usage by Docker
docker system df

# NEVER run without DevOps + Senior Backend approval:
# docker-compose down
# docker-compose up
# docker system prune
```

---

### Category 8 — Log Analysis (jq + LogQL)

**Required for:** Ops Analyst role, Senior Backend role
(incident investigation), Data Engineer role (anomaly
detection in logs).
```bash
# Verify jq is available
jq --version 2>/dev/null || echo "jq not found"

# Install jq if missing
sudo apt-get install -y jq

# Parse pino JSON logs — filter by strategy_id
cat logs/market-data.log | jq 'select(.strategy_id == "strategy1_clientA")'

# Filter by event type
cat logs/order-manager.log | jq 'select(.event == "risk_decision")'

# Filter by level (errors only)
cat logs/market-data.log | jq 'select(.level == 50)'
# pino level 50 = error, 40 = warn, 30 = info

# Filter by time range (last hour)
cat logs/market-data.log | jq --arg since "$(date -u -d '1 hour ago' +%s)000" \
  'select(.time > ($since | tonumber))'

# Count events by type
cat logs/order-manager.log | jq -r '.event' | sort | uniq -c | sort -rn

# Extract all BLOCKED risk decisions
cat logs/order-manager.log | \
  jq 'select(.event == "risk_decision" and .decision == "BLOCKED")'

# Find duplicate signal drops
cat logs/market-data.log | \
  jq 'select(.event == "Duplicate_signal_dropped")'
```

---

### Category 9 — Python (for Strategy File Analysis)

**Required for:** QA role (reading and understanding
Python backtest files during Stage 1 intake).
```bash
# Verify Python is available
python3 --version 2>/dev/null || echo "Python3 not found"

# Install Python3 if missing
sudo apt-get install -y python3 python3-pip

# Install pandas for reading backtest files
pip3 install pandas --break-system-packages

# Install openpyxl for reading Excel files (some backtests)
pip3 install openpyxl --break-system-packages

# Read a Python backtest file and summarize structure
python3 -c "
import ast
import sys

with open(sys.argv[1], 'r') as f:
    content = f.read()

tree = ast.parse(content)
functions = [n.name for n in ast.walk(tree)
             if isinstance(n, ast.FunctionDef)]
print('Functions found:', functions)
" path/to/strategy.py

# Run a backtest file to understand its output
# (only in dev environment, never with prod data)
python3 path/to/strategy_backtest.py
```

---

### Category 10 — File and Code Analysis

**Required for:** All roles during codebase audit,
Senior Backend for platform gap detection.
```bash
# Verify ripgrep (fast code search)
rg --version 2>/dev/null || echo "ripgrep not found"

# Install ripgrep if missing
sudo apt-get install -y ripgrep

# Find all console.log calls (should be zero in prod code)
rg "console\.log" src/

# Find all hardcoded times (should use config)
rg "15:15|15:30|09:15|3:15" src/

# Find all uses of Redis KEYS (banned in prod)
rg "\.keys\(" src/

# Find all Date.now() in signal/strategy files (banned for fingerprints)
rg "Date\.now\(\)" src/strategies/

# Find all plain Pub/Sub publish calls (should use streams for critical)
rg "\.publish\(" src/

# Find all unhandled promise rejections pattern
rg "\.catch\|try\|async" src/ --stats

# Count lines of code per directory
find src -name "*.js" | xargs wc -l | sort -rn | head -20

# Find all TODO and FIXME comments
rg "TODO|FIXME|HACK|XXX" src/

# Check for hardcoded credentials (security check)
rg "password|secret|token|key" src/ -i \
  --glob "!node_modules" \
  --glob "!*.test.js"
```

---

### Category 11 — Git (for PR and Change Management)

**Required for:** Senior Backend role (PR review),
Mid Backend role (committing strategy work),
DevOps role (recording current commit before deploy).
```bash
# Verify git is available
git --version

# Check current branch
git branch --show-current

# Check what changed since last commit
git diff --name-only

# Check git log (recent commits)
git log --oneline -10

# Check staged changes
git diff --cached --name-only

# Record current commit before deploy (DevOps)
git log --oneline -1 > /tmp/pre-deploy-commit.txt

# Check if working directory is clean
git status

# NEVER run without explicit founder instruction:
# git push
# git merge
# git rebase
```

---

### Category 12 — Security and Secrets Check

**Required for:** DevOps role (security audit),
Senior Backend role (PR review security check).
```bash
# Verify no secrets in source code
# Install git-secrets if not present
git secrets --version 2>/dev/null || {
  git clone https://github.com/awslabs/git-secrets.git /tmp/git-secrets
  cd /tmp/git-secrets && sudo make install
  cd -
}

# Scan for AWS-style secrets (catches many patterns)
git secrets --scan

# Manual check for common secret patterns
rg "ANGEL_ONE|api_key|API_KEY|password|PASSWORD|secret|SECRET" \
  src/ config/ scripts/ \
  --glob "!*.test.js" \
  --glob "!node_modules"

# Verify .env files are in .gitignore
cat .gitignore | grep -E "\.env"
# Expected: .env* or .env.prod .env.dev should be listed

# Check file permissions on .env files
ls -la .env* 2>/dev/null
# Expected: -rw------- (600) for both

# Check if any .env file was accidentally committed
git log --all --full-history -- ".env.prod" ".env.dev" ".env"
# Expected: no output (they should never have been committed)
```

---

### Category 13 — Documentation (Pandoc)

**Required for:** Data Engineer role (generating reports),
QA role (producing spec documents in multiple formats).
```bash
# Verify pandoc is available
pandoc --version 2>/dev/null || echo "pandoc not found"

# Install pandoc if missing
sudo apt-get install -y pandoc

# Convert markdown report to PDF
pandoc reports/eod_report_20260318.md \
  -o reports/eod_report_20260318.pdf

# Convert strategy spec to HTML for review
pandoc specs/strategy3_clientA_v1.0.0.md \
  -o specs/strategy3_clientA_v1.0.0.html

# Convert multiple markdown files to one document
pandoc .claude/roles/ROLE_01_QA_ENGINEER.md \
       .claude/roles/ROLE_02_SENIOR_BACKEND_ENGINEER.md \
  -o docs/team_roles_combined.pdf
```

---

### Category 14 — Scheduling and Time (for Cron Verification)

**Required for:** DevOps role (verifying backup and
report cron jobs), Data Engineer role (confirming
EOD report schedule).
```bash
# List all cron jobs for current user
crontab -l

# List system-wide cron jobs
ls /etc/cron.d/
cat /etc/cron.d/algotrading 2>/dev/null || \
  echo "algotrading cron not configured"

# Verify cron service is running
systemctl status cron

# Check cron logs
grep CRON /var/log/syslog | tail -20

# Verify current IST time (for market hours checks)
TZ='Asia/Kolkata' date

# Verify UTC time
date -u

# Check timezone configuration
timedatectl
```

---

### Category 15 — HTTP Testing (for API and Health Checks)

**Required for:** Senior Backend role (testing API endpoints),
DevOps role (health check verification after deployment).
```bash
# Verify curl is available (usually pre-installed)
curl --version

# Test health endpoint after deployment
curl -f http://localhost:3000/health 2>/dev/null \
  && echo "Health check: OK" \
  || echo "Health check: FAILED"

# Test risk warnings endpoint
curl -s http://localhost:3000/api/risk/warnings | jq .

# Test with authentication if required
curl -s -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3000/api/positions | jq .

# Install httpie for more readable API testing
pip3 install httpie --break-system-packages

# httpie equivalent (more readable)
http GET localhost:3000/api/risk/warnings
```

---

## Skill Auto-Install Script

If you want to pre-install all tools in one go before
the first Claude Code session, run this:
```bash
#!/bin/bash
# scripts/install-agent-skills.sh
# Run once on fresh setup or after OS reinstall
# Safe to re-run — all installs are idempotent

set -e
echo "[$(date -u)] Installing agent skill dependencies..."

# System packages
sudo apt-get update -qq
sudo apt-get install -y \
  postgresql-client \
  redis-tools \
  python3 \
  python3-pip \
  jq \
  ripgrep \
  pandoc \
  curl \
  git \
  auditd

# Node.js global packages
npm install -g pm2 2>/dev/null || true

# Python packages
pip3 install pandas openpyxl httpie --break-system-packages

# Verify key installs
echo ""
echo "=== Skill verification ==="
node --version       && echo "Node.js: OK"
npm --version        && echo "npm: OK"
psql --version       && echo "psql: OK"
redis-cli --version  && echo "redis-cli: OK"
python3 --version    && echo "Python3: OK"
jq --version         && echo "jq: OK"
rg --version         && echo "ripgrep: OK"
pandoc --version     && echo "pandoc: OK"
pm2 --version        && echo "PM2: OK"

echo ""
echo "[$(date -u)] All agent skills installed."
```

---

## How Claude Code Uses These Skills

When the agent needs a tool for a task, it follows this
sequence automatically:
```
1. Check if tool is installed
   → [tool] --version 2>/dev/null

2. If not installed:
   → Run the install command from this file
   → Verify install succeeded

3. Use the tool for the task

4. Never install to production paths without DevOps approval
   → All installs default to user-space or project-local
```

The agent will always tell you what it is installing
and why before installing it. It will not install
anything silently.

---

## Current Platform State
```
Strategy1Live:          LIVE (paper trading)
Live broker execution:  NOT YET IMPLEMENTED
Angel One:              WebSocket connected (paper mode)
Redis Streams:          Check audit — may still be Pub/Sub
Startup reconciliation: Check audit — may not exist yet
Weekly candle agg:      Does not exist yet
Equity OMS:             Does not exist yet
```

Update this section after each audit session.
