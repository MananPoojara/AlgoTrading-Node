# Product Requirements Document (PRD)
## Algorithmic Trading Platform

**Version:** 1.0  
**Status:** Draft  
**Classification:** Internal — Confidential  
**Last Updated:** March 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Users & Stakeholders](#3-users--stakeholders)
4. [System Overview](#4-system-overview)
5. [Infrastructure & Deployment](#5-infrastructure--deployment)
6. [Multi-Client Architecture](#6-multi-client-architecture)
7. [Market Data System](#7-market-data-system)
8. [Strategy Engine](#8-strategy-engine)
9. [Signal System](#9-signal-system)
10. [Order Management System (OMS)](#10-order-management-system-oms)
11. [Risk Management Engine](#11-risk-management-engine)
12. [Broker Integration Layer](#12-broker-integration-layer)
13. [Paper Trading Phase](#13-paper-trading-phase)
14. [AFL vs Python Verification](#14-afl-vs-python-verification)
15. [Web Dashboard](#15-web-dashboard)
16. [Data Storage](#16-data-storage)
17. [Logging & Monitoring](#17-logging--monitoring)
18. [Security Requirements](#18-security-requirements)
19. [Scalability Model](#19-scalability-model)
20. [Failure Handling](#20-failure-handling)
21. [Development Phases](#21-development-phases)
22. [Future Roadmap](#22-future-roadmap)
23. [Success Criteria](#23-success-criteria)
24. [Known Risks & Mitigations](#24-known-risks--mitigations)

---

## 1. Executive Summary

We currently maintain approximately **40 trading strategies** that were originally developed in AFL (Amibroker Formula Language) and later converted into programmatic implementations so they can generate trading signals in a real-time environment.

The objective of this project is to build an **in-house algorithmic trading platform** capable of running these strategies, processing live market data, and automatically generating and executing buy/sell signals.

In the **initial phase**, the platform will integrate with **Angel One APIs** and operate entirely in a **paper trading environment**. This allows safe validation of strategies under live market conditions without risking capital. Some strategies currently implemented for the XTS trading API will be adapted to operate with Angel One for this phase.

Once strategies are validated, the system will be extended to support **live trade execution** through broker APIs including **XTS and Symphony**.

The platform includes a **web-based dashboard** for operators to monitor strategy status, signals, orders, positions, and PnL in real time.

In the longer term, the platform is intended to evolve into a **lightweight internal SaaS-style solution** where multiple operators can manage and deploy strategies for different client accounts — enabling centralized strategy management, automated signal generation, and controlled trade execution across multiple brokerage accounts.

---

## 2. Goals & Non-Goals

### 2.1 Primary Goals

- Execute approximately 40 Python/Node.js-based trading strategies automatically
- Process live market data with minimal latency
- Generate, track, and act on trading signals
- Validate Python/Node.js strategy outputs against original AFL implementations
- Execute broker orders through a safe, abstracted execution layer
- Support multiple client accounts (initial: 9 clients) with isolated portfolios
- Provide operators with real-time monitoring and control
- Enforce risk controls to prevent runaway losses

### 2.2 Non-Goals (Initial Phase)

The following are **explicitly out of scope** for the initial version:

- Public user registration or self-service client onboarding
- Retail-facing SaaS product launch
- Mobile application
- Machine learning or AI-based strategies
- Advanced backtesting (handled by a separate dedicated software)
- Multi-region or cloud deployment
- Fully automated client account setup

---

## 3. Users & Stakeholders

### 3.1 Operators (Primary Users)

Internal users who:
- Deploy and control strategies
- Monitor live signals and trades
- Verify AFL vs program logic outputs
- Manage client portfolios and risk limits
- Use the emergency kill switch if needed

### 3.2 Client Managers (Future Phase)

Users who manage trading strategies on behalf of specific client brokerage accounts.

### 3.3 System Administrators

Responsible for:
- Server health and uptime
- Docker container management
- Database maintenance and backups
- API credential rotation

---

## 4. System Overview

The platform is composed of the following core components:

| Component | Purpose |
|---|---|
| Market Data Engine | Ingest and broadcast live market data |
| Strategy Engine | Run strategy workers per client |
| Signal Engine | Capture and route strategy signals |
| Order Management System (OMS) | Convert signals to orders, manage lifecycle |
| Risk Management Engine | Enforce safety controls before order execution |
| Broker Integration Layer | Abstract communication with broker APIs |
| Web Dashboard | Operator monitoring and control interface |
| Event Bus (Redis) | Async inter-service communication |
| Data Storage (PostgreSQL) | Persistent storage for all entities |
| Logging & Monitoring System | Audit trail and system health |

### 4.1 High-Level Architecture

```
Web Dashboard (Next.js)
        │
        │ REST / WebSocket
        ▼
Platform API (Node.js)
        │
        ├──────────────────────────────────────┐
        ▼                                      ▼
Strategy Engine                         Portfolio Engine
(Node.js Workers)                       (Positions / PnL)
        │
        │ Signal Events (Redis)
        ▼
Order Management System
        │
        ▼
Risk Engine
        │
        ▼
Broker Gateway
   ├── Angel One Adapter
   ├── XTS Adapter
   └── Symphony Adapter

Market Data Service
   └── Angel One WebSocket → Redis Pub/Sub → Strategy Workers
```

---

## 5. Infrastructure & Deployment

### 5.1 Hardware

The platform will deploy on an **on-premise local server**:

- **CPU:** ~20 cores
- **RAM:** To be confirmed (32–64 GB recommended)
- **OS:** Ubuntu Server (LTS recommended)
- **Network:** Stable broadband connection with low latency to broker endpoints
- **Storage:** SSD recommended for PostgreSQL performance

### 5.2 Containerization

All services will run in **Docker containers** managed via **Docker Compose**.

Benefits:
- Service isolation — one crash does not cascade
- Easy restarts and updates
- Reproducible deployment
- Simple port and network management

### 5.3 Containerized Services

| Container | Role |
|---|---|
| `market-data-service` | WebSocket ingestion and broadcast |
| `strategy-engine` | Strategy worker pool manager |
| `order-manager` | OMS service |
| `risk-engine` | Risk validation service |
| `broker-gateway` | Broker API abstraction |
| `api-server` | REST API for dashboard |
| `dashboard-ui` | Next.js frontend |
| `postgres` | Local PostgreSQL database |
| `redis` | Event bus and pub/sub |
| `log-service` | Centralized log aggregation |

### 5.4 Suggested CPU Allocation

| Service | CPU Cores |
|---|---|
| Market Data Service | 1 |
| Redis | 1 |
| PostgreSQL | 2 |
| OMS | 1 |
| Risk Engine | 1 |
| API Server | 1 |
| Dashboard | 1 |
| **Strategy Workers** | **~12 (remaining)** |

---

## 6. Multi-Client Architecture

### 6.1 Client Model

The platform must support **9 clients** initially.

Each client record contains:

```
Client
  ├── client_id
  ├── client_name
  ├── status
  ├── broker_accounts[]
  │     ├── broker_name
  │     ├── api_key (encrypted)
  │     ├── api_secret (encrypted)
  │     └── access_token (encrypted)
  ├── active_strategies[]
  └── risk_limits
        ├── max_daily_loss
        ├── max_open_positions
        └── max_lots_per_trade
```

### 6.2 Strategy Deployment Per Client

Strategies are not global — they run as **per-client instances**.

Example:
```
Client A  →  BANKNIFTY_STRADDLE, NIFTY_IRONCONDOR
Client B  →  BANKNIFTY_STRADDLE
Client C  →  MOMENTUM_BREAKOUT
```

The same strategy can run simultaneously for multiple clients with completely isolated state, positions, and orders.

### 6.3 Strategy Worker Grouping

Workers should be grouped by instrument to minimize unnecessary tick processing:

```
Worker 1 → BANKNIFTY strategies, Clients 1–3
Worker 2 → BANKNIFTY strategies, Clients 4–6
Worker 3 → NIFTY strategies, Clients 1–4
Worker 4 → NIFTY strategies, Clients 5–9
...
```

---

## 7. Market Data System

### 7.1 Data Source

**Phase 1:** Angel One WebSocket API  
**Phase 2:** XTS / Symphony (as needed for live trading)

### 7.2 Responsibilities

- Establish and maintain a **single WebSocket connection** per broker
- Subscribe to all required instruments across all active strategies
- Normalize incoming data to a consistent internal format
- Publish normalized ticks to Redis channels

### 7.3 Data Types Consumed

- LTP (Last Traded Price)
- Bid / Ask prices
- OHLC (Open, High, Low, Close)
- Volume
- Instrument metadata (symbol, expiry, strike, option type)

### 7.4 Market Data Event Format

```json
{
  "type": "market_tick",
  "symbol": "BANKNIFTY",
  "ltp": 45120.50,
  "bid": 45119.00,
  "ask": 45122.00,
  "volume": 128430,
  "timestamp": "2026-03-10T09:31:10.200Z"
}
```

Published to Redis channel: `market_ticks`

---

## 8. Strategy Engine

### 8.1 Overview

Each strategy runs as an **independent worker instance** scoped to a single client.

**Technology:** Node.js workers  
**Communication:** Redis Pub/Sub (receives ticks, publishes signals)

### 8.2 Worker Lifecycle States

```
CREATED → INITIALIZING → RUNNING → PAUSED → STOPPED
                                       ↓
                                    FAILED → RESTART
```

| State | Description |
|---|---|
| CREATED | Instance registered but not yet started |
| INITIALIZING | Loading config, subscribing to data feed |
| RUNNING | Actively processing ticks |
| PAUSED | Temporarily halted by operator |
| STOPPED | Gracefully stopped |
| FAILED | Crashed — worker manager will auto-restart |

### 8.3 Worker Startup Sequence

1. Load strategy configuration from database
2. Load client-specific parameters and risk limits
3. Subscribe to relevant Redis market data channels
4. Initialize strategy indicators and internal state
5. Begin processing tick events

### 8.4 Strategy Execution Model

Strategies are **event-driven**, not polling loops:

```javascript
// BAD — polling, burns CPU
while (true) { checkMarketData(); }

// GOOD — event-driven
onMarketTick(tick) { runStrategyLogic(tick); }
```

### 8.5 Worker Health Monitoring

Every worker emits a heartbeat every 30 seconds:

```json
{ "worker_id": 12, "status": "alive", "timestamp": "09:31:10" }
```

If heartbeat stops → Worker Manager triggers auto-restart.

### 8.6 Strategy Types

| Category | Examples |
|---|---|
| Options Selling | BANKNIFTY Straddle, NIFTY Iron Condor, Weekly Strangle |
| Options Buying | Breakout Strategy, Momentum Strategy |
| Spread Strategies | Bull Spread, Bear Spread |
| Intraday | Intraday Momentum, Gap-Up/Down plays |

**Total strategies:** ~40

---

## 9. Signal System

### 9.1 Signal Generation

When a strategy detects a trading condition, it emits a signal event.

### 9.2 Signal Schema

```json
{
  "event": "strategy_signal",
  "event_id": "STRAT21_20260310_093111_001",
  "strategy_instance_id": 21,
  "client_id": 3,
  "symbol": "BANKNIFTY",
  "action": "SELL",
  "instrument": "BANKNIFTY 45000 CE",
  "quantity": 50,
  "price_type": "MARKET",
  "timestamp": "2026-03-10T09:31:11Z"
}
```

Note: `event_id` must be unique to enable **idempotent processing** and prevent duplicate orders.

### 9.3 Signal Routing

Signals are published to Redis channel: `strategy_signals`  
The Order Management System is the sole consumer of this channel.

---

## 10. Order Management System (OMS)

### 10.1 Responsibilities

- Receive signals from strategy workers
- Validate signals (deduplication, format check)
- Convert signals to broker order requests
- Manage the full order lifecycle
- Track order status and store all records
- Handle retries for transient failures

**Critical rule:** Strategies never communicate directly with broker APIs.

### 10.2 Order State Machine

```
CREATED
   ↓
VALIDATED
   ↓
QUEUED
   ↓
SENT_TO_BROKER
   ↓
ACKNOWLEDGED
   ↓
PARTIALLY_FILLED → FILLED
   or
REJECTED
   or
CANCELLED
```

| State | Description |
|---|---|
| CREATED | Signal received, order object created |
| VALIDATED | Risk check passed |
| QUEUED | Waiting for broker submission slot |
| SENT_TO_BROKER | Submitted to broker API |
| ACKNOWLEDGED | Broker confirmed receipt |
| PARTIALLY_FILLED | Part of the order executed |
| FILLED | Fully executed |
| REJECTED | Broker or risk engine rejected |
| CANCELLED | Operator or system cancelled |

### 10.3 Duplicate Order Protection

Before creating an order, the OMS checks:

1. Has this `event_id` been processed before? → If yes, discard
2. Does the strategy instance already have an active open order for this symbol? → If yes, block
3. Does the current position state match the strategy's expected state? → If not, block

### 10.4 Order Retry Policy

| Failure Type | Action |
|---|---|
| Network timeout | Retry up to 3 times with exponential backoff |
| Broker API error (5xx) | Retry up to 3 times |
| Broker rejection (4xx) | Do not retry, log and alert |
| Risk rejection | Do not retry, log and alert operator |

---

## 11. Risk Management Engine

### 11.1 Overview

The Risk Engine sits between the OMS and Broker Gateway. No order reaches the broker without passing risk validation.

### 11.2 Per-Client Risk Controls

| Control | Description |
|---|---|
| Max Daily Loss | If client loss exceeds threshold → stop all strategies, close positions |
| Max Open Positions | Limit simultaneous open trades per client |
| Max Lots Per Trade | Cap on quantity per single order |
| Max Orders Per Minute | Prevent runaway signal loops |
| Duplicate Order Guard | Block repeated identical signals within cooldown window |
| Margin Check | Verify sufficient margin before placing order |

### 11.3 Global System Controls

| Control | Description |
|---|---|
| Emergency Kill Switch | Operator action — stops ALL strategies for ALL clients immediately |
| Strategy-Level Stop | Stop a single strategy for a single client |
| Client-Level Stop | Stop all strategies for one client |
| Circuit Breaker | Auto-pause if order rate spikes abnormally |

### 11.4 Signal Cooldown

A strategy cannot emit the same signal within a configurable cooldown window (default: 5 seconds). This prevents runaway loops during volatile market conditions.

### 11.5 Kill Switch Behavior

When triggered, the kill switch must:

1. Immediately stop all strategy workers from generating new signals
2. Cancel all pending (unacknowledged) orders with the broker
3. Optionally close all open positions (operator configurable)
4. Send alert to operators via configured notification channel

---

## 12. Broker Integration Layer

### 12.1 Broker Abstraction

All broker interactions go through a unified adapter interface:

```javascript
brokerAdapter.placeOrder(order)
brokerAdapter.cancelOrder(orderId)
brokerAdapter.getPositions(clientId)
brokerAdapter.getOrders(clientId)
brokerAdapter.getMargin(clientId)
```

This means the rest of the system never directly calls broker-specific APIs — only adapters do.

### 12.2 Supported Brokers

| Broker | Phase | Purpose |
|---|---|---|
| Angel One | Phase 1 | Market data + paper trading |
| XTS | Phase 2 | Live order execution |
| Symphony | Phase 2 | Live order execution |

### 12.3 Adapter File Structure

```
src/brokers/
  ├── angelOne/
  │     ├── angelClient.js
  │     └── angelOrders.js
  ├── xts/
  │     ├── xtsClient.js
  │     └── xtsOrders.js
  └── symphony/
        └── symphonyClient.js
```

### 12.4 XTS Strategy Migration

Strategies currently written for XTS API will be adapted to work with Angel One for the paper trading phase. After paper trading validation is complete, these strategies can be pointed back to XTS for live execution without logic changes.

---

## 13. Paper Trading Phase

### 13.1 Objectives

- Validate that all 40 strategies generate correct signals under live market conditions
- Confirm that order flow, position tracking, and PnL calculation work correctly
- Verify system stability (no crashes, reconnections, memory leaks) during market hours
- Provide a safe environment for operator training

### 13.2 Behavior in Paper Mode

- Signals are generated through the full strategy pipeline (no shortcuts)
- Orders are either simulated internally or sent to Angel One paper trading endpoints
- Positions and PnL are tracked internally by the portfolio engine
- No real capital is at risk

### 13.3 Transition Criteria to Live Trading

The system may move to live trading only when:

- All active strategies have run in paper mode for a minimum agreed period (e.g., 2–4 weeks)
- Signal outputs have been manually verified against AFL outputs for each strategy
- No critical bugs or logic discrepancies have been found
- OMS, Risk Engine, and Kill Switch have been tested and confirmed working
- Operators are trained on the dashboard and emergency procedures

---

## 14. AFL vs Python/Node.js Verification

### 14.1 Process

During the paper trading phase, operators will manually compare:

| Item | AFL Output | Platform Output |
|---|---|---|
| Entry signal (time, strike, action) | ✓ | Must match |
| Exit signal (time, condition) | ✓ | Must match |
| Strike selection logic | ✓ | Must match |
| Stop-loss triggers | ✓ | Must match |

### 14.2 Discrepancy Handling

- Any mismatch must be logged, investigated, and resolved before that strategy is approved for live trading
- Discrepancies must be documented in the strategy's version record
- Strategy must re-pass verification after any code change

---

## 15. Web Dashboard

### 15.1 Technology

- **Frontend:** Next.js
- **Backend API:** Node.js (REST + WebSocket for live updates)

### 15.2 Dashboard Views

#### System Overview Dashboard
- Total active strategies
- Total clients
- Orders placed today
- Total system PnL
- System health indicators (WebSocket status, service uptime)
- Active alerts

#### Client Dashboard
Operator selects a client to view:

| Section | Fields |
|---|---|
| Portfolio Summary | Name, Total PnL, Today's PnL, Margin Used, Available Margin |
| Open Positions | Symbol, Strategy, Quantity, Entry Price, Current Price, PnL |
| Order History | Order ID, Strategy, Symbol, Status, Price, Time |
| Running Strategies | Strategy Name, Status, Last Signal Time, Per-strategy PnL |
| Risk Status | Daily loss consumed vs. limit, position count vs. limit |

#### Strategy Dashboard
- Strategy name and version
- Clients currently running this strategy
- Total signals generated today
- Per-client PnL for this strategy
- Error log for this strategy

#### Kill Switch Panel
- Prominent, protected button accessible to authorized operators only
- Confirms action before executing
- Logs operator identity and timestamp

### 15.3 Real-Time Updates

Dashboard must receive live updates via WebSocket for:
- New signals
- Order status changes
- Position updates
- Risk alerts

---

## 16. Data Storage

### 16.1 Database

**PostgreSQL** — local, self-hosted.

### 16.2 Core Tables

| Table | Purpose |
|---|---|
| `clients` | Client identity and status |
| `accounts` | Broker credentials per client |
| `strategies` | Strategy catalogue |
| `strategy_instances` | Per-client strategy deployments |
| `signals` | All generated signals |
| `orders` | All orders with full state |
| `order_events` | Audit trail of every order state change |
| `trades` | Executed fills |
| `positions` | Live open positions |
| `portfolio_snapshots` | Periodic PnL and margin snapshots |
| `system_logs` | Structured system event logs |

### 16.3 Data Retention Policy

| Data Type | Retention |
|---|---|
| Orders & Trades | Indefinite (financial records) |
| Signals | Minimum 1 year |
| System Logs | Minimum 90 days |
| Market Data Ticks | 7 days (rolling, if stored at all) |
| Portfolio Snapshots | Indefinite |

---

## 17. Logging & Monitoring

### 17.1 Logging Requirements

Every critical system event must be logged with structured fields:

```json
{
  "timestamp": "2026-03-10T09:31:11Z",
  "level": "INFO",
  "service": "strategy-engine",
  "client_id": 3,
  "strategy": "BANKNIFTY_STRADDLE",
  "event": "signal_generated",
  "detail": "SELL 45000CE qty:50"
}
```

### 17.2 Events to Log

- Strategy worker started / stopped / crashed
- Signal generated
- Order created, sent, acknowledged, filled, rejected, cancelled
- Risk check passed / failed
- Broker API errors
- WebSocket connected / disconnected
- Kill switch activated
- Operator login and actions

### 17.3 Alerting

Alerts should be sent via at least one channel when:

- Strategy worker crashes and fails to restart
- Daily loss limit is approaching or breached
- Broker WebSocket disconnects
- Order rejection rate exceeds threshold
- Kill switch is activated

**Recommended channels:** Telegram, Slack, or email.

### 17.4 System Health Monitoring

Dashboard must display:

| Metric | Status |
|---|---|
| Market data WebSocket | Connected / Disconnected |
| Redis | Online / Offline |
| PostgreSQL | Online / Offline |
| Each strategy worker | Running / Stopped / Failed |
| Broker API latency | ms |

---

## 18. Security Requirements

### 18.1 API Key Management

- Broker API keys and secrets must **never** be stored in plain text in code or config files
- All credentials must be stored encrypted in the database
- Access to credentials is restricted to the `broker-gateway` service only
- Credentials must be rotatable without system restart

### 18.2 Authentication & Authorization

- Dashboard must require login (username + password at minimum)
- Role-based access control (RBAC):
  - **Admin:** Full access including kill switch and credential management
  - **Operator:** Can start/stop strategies, view all data
  - **Viewer:** Read-only access to dashboard
- Session tokens must expire after inactivity

### 18.3 Transport Security

- All internal service communication must use encrypted channels where possible
- Dashboard must be served over HTTPS (even on local network)
- Broker API calls must use HTTPS/TLS

### 18.4 Audit Trail

- All operator actions (login, strategy start/stop, kill switch, parameter changes) must be logged with timestamp and user identity
- Audit logs must not be deletable by regular operators

### 18.5 Docker Security

- Containers must not run as root
- No sensitive environment variables in Docker Compose files — use secrets management
- Internal services should not expose ports to the host unnecessarily

### 18.6 Network Security

- Dashboard and API server should only be accessible on the local network or via VPN
- No public internet exposure unless explicitly required
- Firewall rules must restrict inbound ports

---

## 19. Scalability Model

### 19.1 Capacity Estimate

| Factor | Count |
|---|---|
| Total strategies | ~40 |
| Total clients | 9 (initial) |
| Worst-case instances | ~360 |

With event-driven workers (not one OS process per instance), a 20-core machine can comfortably run 360+ instances.

### 19.2 Worker Pool Design

Multiple strategy instances run inside each worker:

```
Worker 1: [BANKNIFTY_STRADDLE/Client1, BANKNIFTY_STRADDLE/Client2, NIFTY_IC/Client1]
Worker 2: [BANKNIFTY_STRADDLE/Client3, ...]
```

Grouping by instrument reduces unnecessary tick processing.

### 19.3 Memory Per Instance

Each strategy instance should only hold:
- Last 100 candles / ticks
- Current position state
- Strategy parameters
- Indicator values

No large historical datasets in memory.

### 19.4 Scaling Rules

- Add more workers if CPU consistently exceeds 70%
- Monitor per-worker strategy count and signal throughput
- Use PM2 or Docker restart policies for automatic worker recovery

---

## 20. Failure Handling

| Failure Scenario | Recovery Behavior |
|---|---|
| Broker WebSocket disconnects | Auto-reconnect with exponential backoff |
| Strategy worker crashes | Worker Manager restarts automatically |
| Broker API returns error | OMS retries up to 3 times with backoff |
| PostgreSQL connection lost | Services queue operations and retry on reconnect |
| Redis connection lost | Services pause, alert operators, retry on reconnect |
| Order stuck in SENT state | OMS polls broker for status after timeout |
| Runaway signal loop | Signal cooldown and circuit breaker trigger |
| Server reboot | Docker Compose restart policies bring all services back |

---

## 21. Development Phases

### Phase 1 — Foundation
- Infrastructure setup (Docker, PostgreSQL, Redis)
- Market data ingestion service (Angel One WebSocket)
- Strategy worker framework and base class
- Event bus implementation (Redis channels)

### Phase 2 — Strategy & Paper Trading
- Strategy migration and adaptation (XTS → Angel One)
- Strategy instance manager
- Paper trading mode (simulated OMS)
- AFL vs. Node.js signal verification tooling

### Phase 3 — OMS & Risk Engine
- Full Order Management System with state machine
- Risk Engine with all controls
- Kill switch implementation
- Order audit trail

### Phase 4 — Dashboard
- Next.js frontend
- Node.js API server
- Client portfolio views
- Real-time WebSocket updates
- Operator authentication and RBAC

### Phase 5 — Live Trading
- XTS and Symphony broker adapters
- Live trading mode activation (post paper trading sign-off)
- End-to-end live trade testing with small capital

### Phase 6 — Multi-Client Hardening
- Per-client risk limit configuration
- Client-specific dashboard views
- Operator tooling for strategy deployment per client
- Performance monitoring and alerting

---

## 22. Future Roadmap

| Feature | Priority |
|---|---|
| Multi-operator login system | High |
| Strategy parameter control via dashboard | High |
| Automated strategy deployment workflow | Medium |
| Performance analytics per strategy/client | Medium |
| Advanced risk analytics and drawdown reports | Medium |
| SaaS expansion for external operators | Low |
| Cloud deployment option | Low |
| Kubernetes orchestration | Low |

---

## 23. Success Criteria

The platform will be considered successful when:

- All ~40 strategies run concurrently without crashes
- Signal outputs match AFL logic across all strategies
- Paper trading phase completes with no critical logic discrepancies
- Orders execute correctly through broker APIs
- Risk controls successfully prevent simulated runaway trades
- Dashboard provides accurate real-time monitoring for all 9 clients
- Kill switch stops all activity within 5 seconds of activation
- System survives a full market session (9:15 AM – 3:30 PM) without manual intervention

---

## 24. Known Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Strategy logic mismatch (AFL vs code) | Medium | High | Manual verification in paper phase before live |
| Broker API instability / downtime | Medium | High | Retry logic, alerts, fallback paper mode |
| Strategy worker memory leak | Medium | Medium | Worker restarts, memory monitoring |
| Race condition causing duplicate orders | Medium | High | Idempotent event IDs, OMS deduplication |
| Incorrect risk limit configuration | Low | Critical | Config review checklist before live activation |
| Server hardware failure during market hours | Low | Critical | Daily database backups, documented restart procedure |
| API key compromise | Low | Critical | Encrypted storage, restricted access, rotation procedure |
| Runaway strategy loop | Medium | High | Signal cooldown, circuit breaker, kill switch |
| Redis failure during trading hours | Low | High | Health monitoring, operator alerts, service restart policy |
| Timezone / clock drift causing signal timing errors | Low | Medium | Server NTP sync, all timestamps in UTC |
| Order stuck at broker (no acknowledgement) | Medium | Medium | OMS timeout polling, operator alert |
| Developer accidentally pushes wrong strategy code | Medium | High | Git-based strategy versioning, staging environment before prod |

---

*End of PRD v1.0*