# System Requirements Document (SRD)
## Algorithmic Trading Platform — Technical Architecture & System Design

**Version:** 1.0  
**Status:** Draft  
**Classification:** Internal — Confidential  
**Last Updated:** March 2026

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Technology Stack](#2-technology-stack)
3. [Project Folder Structure](#3-project-folder-structure)
4. [Database Schema](#4-database-schema)
5. [Event Bus Architecture (Redis)](#5-event-bus-architecture-redis)
6. [Market Data Service](#6-market-data-service)
7. [Strategy Worker Lifecycle](#7-strategy-worker-lifecycle)
8. [Order Management State Machine](#8-order-management-state-machine)
9. [Risk Engine Specification](#9-risk-engine-specification)
10. [Broker Gateway Specification](#10-broker-gateway-specification)
11. [API Specification](#11-api-specification)
12. [Event Flow Diagrams](#12-event-flow-diagrams)
13. [Race Condition & Duplicate Trade Prevention](#13-race-condition--duplicate-trade-prevention)
14. [Worker Scaling & CPU Model](#14-worker-scaling--cpu-model)
15. [Docker Compose Architecture](#15-docker-compose-architecture)
16. [Security Architecture](#16-security-architecture)
17. [Failure Recovery Specifications](#17-failure-recovery-specifications)
18. [Monitoring & Observability Spec](#18-monitoring--observability-spec)
19. [Known Technical Risks & Mitigations](#19-known-technical-risks--mitigations)

---

## 1. System Architecture Overview

### 1.1 Layered Architecture

The system is divided into five layers:

```
┌─────────────────────────────────────────────────────────┐
│                  Layer 5: Platform Layer                │
│         Web Dashboard (Next.js) + REST API (Node.js)    │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│               Layer 4: Execution Layer                  │
│          OMS  │  Risk Engine  │  Broker Gateway         │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│               Layer 3: Strategy Layer                   │
│     Strategy Workers (Node.js) + Signal Publisher       │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                Layer 2: Event Bus Layer                 │
│              Redis Pub/Sub + Streams                    │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│              Layer 1: Market Data Layer                 │
│       Angel One WebSocket → Normalizer → Redis          │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Full System Component Diagram

```
AngelOne WebSocket
        │
        ▼
Market Data Service
        │  (publishes market_ticks to Redis)
        ▼
Redis Event Bus
        │
        ├──────────────────────────────────────────┐
        ▼                                          ▼
Strategy Workers                          (future: other consumers)
(Node.js Worker Pool)
        │  (publishes strategy_signals to Redis)
        ▼
Order Manager
        │  (publishes order_requests to Redis)
        ▼
Risk Engine
        │  (publishes validated_orders to Redis)
        ▼
Broker Gateway
   ├── AngelOne Adapter
   ├── XTS Adapter
   └── Symphony Adapter
        │  (publishes broker_responses to Redis)
        ▼
Position & Portfolio Engine
        │  (updates DB + publishes position_updates)
        ▼
Dashboard API (WebSocket push)
        │
        ▼
Web Dashboard (Next.js)
```

---

## 2. Technology Stack

| Layer | Technology | Reason |
|---|---|---|
| Strategy Engine | Node.js | Event-driven, fast I/O, handles high tick rates |
| Backend API | Node.js (Express or Fastify) | Same language as strategies, low latency |
| Frontend Dashboard | Next.js | React-based, SSR support, WebSocket ready |
| Event Bus | Redis Pub/Sub + Streams | Low latency, lightweight, reliable for this scale |
| Database | PostgreSQL (local) | Reliable, transactional, strong financial use history |
| Containerization | Docker + Docker Compose | Isolation, portability, easy restarts |
| Process Manager | PM2 or Docker restart policies | Worker auto-restart on crash |
| Logging | Winston (Node.js) + structured JSON | Queryable logs, consistent format |
| Secrets | Environment variables via `.env` + encrypted DB fields | API key security |

---

## 3. Project Folder Structure

```
algo-trading-platform/
│
├── docker/
│   ├── docker-compose.yml
│   ├── docker-compose.prod.yml
│   └── Dockerfiles/
│       ├── Dockerfile.strategy
│       ├── Dockerfile.api
│       └── Dockerfile.dashboard
│
├── config/
│   ├── default.js              # Base configuration
│   ├── production.js           # Overrides for prod
│   └── riskLimits.js           # Default risk parameters
│
├── src/
│
│   ├── core/
│   │   ├── eventBus/
│   │   │   ├── redisClient.js
│   │   │   ├── publisher.js
│   │   │   └── subscriber.js
│   │   ├── logger/
│   │   │   └── logger.js
│   │   └── utils/
│   │       ├── time.js
│   │       ├── idGenerator.js     # Unique event_id generation
│   │       └── helpers.js
│
│   ├── marketData/
│   │   ├── marketDataService.js   # Entry point, WebSocket manager
│   │   ├── angelWebsocket.js      # AngelOne WS connection
│   │   ├── dataNormalizer.js      # Normalize broker tick formats
│   │   └── instrumentManager.js  # Track subscribed instruments
│
│   ├── brokers/
│   │   ├── brokerInterface.js     # Abstract interface all adapters implement
│   │   ├── angelOne/
│   │   │   ├── angelClient.js
│   │   │   └── angelOrders.js
│   │   ├── xts/
│   │   │   ├── xtsClient.js
│   │   │   └── xtsOrders.js
│   │   └── symphony/
│   │       └── symphonyClient.js
│
│   ├── strategies/
│   │   ├── baseStrategy.js        # Abstract base class all strategies extend
│   │   ├── optionSelling/
│   │   │   ├── bankniftyStraddle.js
│   │   │   ├── niftyIronCondor.js
│   │   │   └── weeklyStrangle.js
│   │   ├── optionBuying/
│   │   │   ├── breakoutStrategy.js
│   │   │   └── momentumStrategy.js
│   │   ├── spreads/
│   │   │   └── bullSpread.js
│   │   └── intraday/
│   │       └── intradayMomentum.js
│
│   ├── strategyEngine/
│   │   ├── workerManager.js       # Start, stop, monitor all workers
│   │   ├── strategyLoader.js      # Dynamically load strategy classes
│   │   ├── workerPool.js          # Worker grouping and distribution
│   │   ├── clientStrategyMapper.js  # Which strategies run for which clients
│   │   └── heartbeatMonitor.js    # Watch worker heartbeats
│
│   ├── execution/
│   │   ├── orderManager/
│   │   │   ├── orderManager.js    # Main OMS logic
│   │   │   ├── orderStateMachine.js  # Order state transitions
│   │   │   ├── orderValidator.js  # Format and dedup validation
│   │   │   └── orderQueue.js      # In-memory order queue
│   │   ├── riskEngine/
│   │   │   ├── riskManager.js     # Main risk orchestrator
│   │   │   ├── dailyLossLimit.js  # Per-client daily loss tracking
│   │   │   ├── positionLimits.js  # Max open positions
│   │   │   ├── orderFrequency.js  # Rate limiter for orders
│   │   │   └── killSwitch.js      # Emergency stop logic
│   │   └── brokerGateway/
│   │       ├── brokerRouter.js    # Route to correct adapter
│   │       └── retryHandler.js    # Retry logic for failed submissions
│
│   ├── portfolio/
│   │   ├── positionTracker.js     # Maintain live positions per client
│   │   ├── pnlCalculator.js       # Real-time PnL calculation
│   │   └── marginTracker.js       # Margin usage tracking
│
│   ├── api/
│   │   ├── server.js              # Express/Fastify entry point
│   │   ├── websocketServer.js     # Real-time push to dashboard
│   │   ├── middleware/
│   │   │   ├── auth.js            # JWT authentication
│   │   │   └── rbac.js            # Role-based access control
│   │   ├── controllers/
│   │   │   ├── clientController.js
│   │   │   ├── strategyController.js
│   │   │   ├── orderController.js
│   │   │   ├── positionController.js
│   │   │   └── systemController.js
│   │   └── routes/
│   │       ├── clients.js
│   │       ├── strategies.js
│   │       ├── orders.js
│   │       ├── positions.js
│   │       └── system.js
│
│   ├── database/
│   │   ├── postgresClient.js
│   │   ├── migrations/            # Schema migration files
│   │   └── models/
│   │       ├── Client.js
│   │       ├── Account.js
│   │       ├── Strategy.js
│   │       ├── StrategyInstance.js
│   │       ├── Signal.js
│   │       ├── Order.js
│   │       ├── OrderEvent.js
│   │       ├── Trade.js
│   │       ├── Position.js
│   │       └── SystemLog.js
│
│   └── dashboard/
│       └── (Next.js app — separate directory or monorepo package)
│
├── scripts/
│   ├── startStrategies.js
│   ├── stopAllStrategies.js
│   ├── restartWorkers.js
│   └── verifyAFLOutputs.js       # AFL vs code comparison tool
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── paperTradingValidation/
│
├── .env.example
├── .gitignore
└── README.md
```

---

## 4. Database Schema

### 4.1 `clients`

```sql
CREATE TABLE clients (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  status      VARCHAR(20) DEFAULT 'active',  -- active, suspended, inactive
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.2 `accounts`

```sql
CREATE TABLE accounts (
  id             SERIAL PRIMARY KEY,
  client_id      INTEGER REFERENCES clients(id),
  broker_name    VARCHAR(50) NOT NULL,  -- ANGEL_ONE, XTS, SYMPHONY
  api_key        TEXT NOT NULL,         -- encrypted at application layer
  api_secret     TEXT NOT NULL,         -- encrypted at application layer
  access_token   TEXT,                  -- refreshed on login
  token_expiry   TIMESTAMPTZ,
  status         VARCHAR(20) DEFAULT 'active',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.3 `strategies`

```sql
CREATE TABLE strategies (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL UNIQUE,
  type         VARCHAR(50),   -- option_selling, option_buying, spread, intraday
  version      VARCHAR(20) DEFAULT '1.0',
  description  TEXT,
  file_path    VARCHAR(255),  -- path to strategy file in codebase
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.4 `strategy_instances`

```sql
CREATE TABLE strategy_instances (
  id             SERIAL PRIMARY KEY,
  client_id      INTEGER REFERENCES clients(id),
  strategy_id    INTEGER REFERENCES strategies(id),
  status         VARCHAR(20) DEFAULT 'stopped',  -- running, stopped, paused, failed
  parameters     JSONB,       -- strategy-specific config overrides per client
  worker_id      VARCHAR(50), -- which worker process is running this
  started_at     TIMESTAMPTZ,
  stopped_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, strategy_id)
);
```

### 4.5 `signals`

```sql
CREATE TABLE signals (
  id                    SERIAL PRIMARY KEY,
  event_id              VARCHAR(100) UNIQUE NOT NULL,  -- for idempotency
  strategy_instance_id  INTEGER REFERENCES strategy_instances(id),
  symbol                VARCHAR(50),
  instrument            VARCHAR(100),
  action                VARCHAR(10),   -- BUY, SELL
  quantity              INTEGER,
  price_type            VARCHAR(20),   -- MARKET, LIMIT
  price                 NUMERIC(12, 2),
  status                VARCHAR(20) DEFAULT 'pending',  -- pending, processed, rejected
  timestamp             TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.6 `orders`

```sql
CREATE TABLE orders (
  id                    SERIAL PRIMARY KEY,
  client_id             INTEGER REFERENCES clients(id),
  strategy_instance_id  INTEGER REFERENCES strategy_instances(id),
  signal_id             INTEGER REFERENCES signals(id),
  symbol                VARCHAR(50),
  instrument            VARCHAR(100),
  side                  VARCHAR(10),   -- BUY, SELL
  quantity              INTEGER,
  price                 NUMERIC(12, 2),
  price_type            VARCHAR(20),
  status                VARCHAR(30) DEFAULT 'created',
  broker_order_id       VARCHAR(100),
  broker_name           VARCHAR(50),
  filled_quantity       INTEGER DEFAULT 0,
  average_fill_price    NUMERIC(12, 2),
  rejection_reason      TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.7 `order_events`

```sql
CREATE TABLE order_events (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER REFERENCES orders(id),
  event_type  VARCHAR(50),   -- ORDER_CREATED, ORDER_SENT, ORDER_ACKNOWLEDGED, etc.
  event_data  JSONB,
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.8 `trades`

```sql
CREATE TABLE trades (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER REFERENCES orders(id),
  client_id   INTEGER REFERENCES clients(id),
  symbol      VARCHAR(50),
  instrument  VARCHAR(100),
  side        VARCHAR(10),
  quantity    INTEGER,
  price       NUMERIC(12, 2),
  broker_trade_id  VARCHAR(100),
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.9 `positions`

```sql
CREATE TABLE positions (
  id                    SERIAL PRIMARY KEY,
  client_id             INTEGER REFERENCES clients(id),
  strategy_instance_id  INTEGER REFERENCES strategy_instances(id),
  symbol                VARCHAR(50),
  instrument            VARCHAR(100),
  quantity              INTEGER,        -- negative for short
  avg_entry_price       NUMERIC(12, 2),
  current_price         NUMERIC(12, 2),
  unrealized_pnl        NUMERIC(12, 2),
  realized_pnl          NUMERIC(12, 2),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.10 `portfolio_snapshots`

```sql
CREATE TABLE portfolio_snapshots (
  id              SERIAL PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id),
  total_pnl       NUMERIC(12, 2),
  realized_pnl    NUMERIC(12, 2),
  unrealized_pnl  NUMERIC(12, 2),
  margin_used     NUMERIC(12, 2),
  margin_available NUMERIC(12, 2),
  snapshot_time   TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.11 `system_logs`

```sql
CREATE TABLE system_logs (
  id          SERIAL PRIMARY KEY,
  level       VARCHAR(10),   -- INFO, WARN, ERROR, CRITICAL
  service     VARCHAR(50),
  client_id   INTEGER,       -- nullable
  strategy_id INTEGER,       -- nullable
  message     TEXT,
  metadata    JSONB,
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_system_logs_timestamp ON system_logs(timestamp DESC);
CREATE INDEX idx_system_logs_level ON system_logs(level);
CREATE INDEX idx_system_logs_client ON system_logs(client_id);
```

### 4.12 `operator_audit_log`

```sql
CREATE TABLE operator_audit_log (
  id            SERIAL PRIMARY KEY,
  operator_id   INTEGER,
  action        VARCHAR(100),  -- LOGIN, KILL_SWITCH, START_STRATEGY, STOP_STRATEGY
  target_type   VARCHAR(50),   -- client, strategy, system
  target_id     INTEGER,
  metadata      JSONB,
  ip_address    INET,
  timestamp     TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 5. Event Bus Architecture (Redis)

### 5.1 Redis Channels

| Channel | Publisher | Subscriber | Purpose |
|---|---|---|---|
| `market_ticks` | Market Data Service | Strategy Workers | Live tick broadcast |
| `strategy_signals` | Strategy Workers | Order Manager | Generated trading signals |
| `order_requests` | Order Manager | Risk Engine | Orders pending risk check |
| `validated_orders` | Risk Engine | Broker Gateway | Risk-approved orders |
| `rejected_orders` | Risk Engine | Order Manager | Risk-rejected orders |
| `broker_responses` | Broker Gateway | Order Manager | Order status from broker |
| `trade_events` | Broker Gateway | Position Engine | Fill confirmations |
| `position_updates` | Position Engine | Dashboard API | Portfolio changes |
| `system_alerts` | Any service | Dashboard API, Alert Service | Errors, warnings |
| `worker_heartbeats` | Strategy Workers | Worker Manager | Health monitoring |

### 5.2 Idempotency Keys

Every event published to Redis must include a unique `event_id`:

```
Format: {SERVICE}_{CLIENT_ID}_{STRATEGY_ID}_{YYYYMMDD}_{HHMMSS}_{SEQ}
Example: STRAT_3_21_20260310_093111_001
```

Any service receiving a duplicate `event_id` must discard it silently and log the duplicate.

---

## 6. Market Data Service

### 6.1 Connection Management

```
AngelOne WebSocket
   │
   ├── On connect: subscribe to all instruments for active strategies
   ├── On tick: normalize → publish to Redis market_ticks
   ├── On disconnect: log, alert, attempt reconnect (backoff: 1s, 2s, 5s, 10s, 30s)
   └── On error: log error, attempt reconnect
```

### 6.2 Instrument Subscription Management

- At startup, query all active `strategy_instances` and collect required instruments
- Subscribe to all collected instruments in a single WebSocket subscription batch
- When a strategy is started/stopped, dynamically add/remove instrument subscriptions
- Deduplicate: if multiple strategies use BANKNIFTY, subscribe only once

### 6.3 Normalized Tick Format

All broker tick formats are normalized before publishing:

```javascript
{
  symbol: "BANKNIFTY",
  instrument_token: 260105,
  ltp: 45120.50,
  open: 44800.00,
  high: 45300.00,
  low: 44750.00,
  close: 44900.00,
  volume: 128430,
  bid: 45119.00,
  ask: 45122.00,
  timestamp: "2026-03-10T09:31:10.200Z"
}
```

---

## 7. Strategy Worker Lifecycle

### 7.1 Full Lifecycle State Machine

```
CREATED
   │
   ▼
INITIALIZING ──────────────────────► FAILED
   │                                    │
   ▼                                    ▼
RUNNING ◄─── (resume) ─── PAUSED    RESTARTING
   │                         ▲          │
   │────── (pause) ──────────┘          ▼
   │                                 INITIALIZING
   ▼
STOPPING
   │
   ▼
STOPPED
```

### 7.2 Worker Startup Sequence

```
1. Worker receives start command (client_id, strategy_id)
2. Load strategy class from file
3. Load client parameters from DB
4. Load client risk limits from DB
5. Query current open positions for this client/strategy
6. Subscribe to relevant Redis market_ticks channels
7. Initialize indicators (EMA, ATR, etc.) with recent candle data
8. Set status = RUNNING
9. Begin emitting heartbeats every 30 seconds
10. Process incoming ticks via onMarketTick(tick) handler
```

### 7.3 Worker Shutdown Sequence (Graceful)

```
1. Stop accepting new ticks (unsubscribe from Redis)
2. Finish processing any tick currently in progress
3. Cancel any pending (unsubmitted) signals
4. Set status = STOPPED in DB
5. Emit final heartbeat with status = STOPPED
6. Exit process
```

### 7.4 Worker Crash Handling

```
1. Worker process exits unexpectedly
2. Worker Manager detects missed heartbeat (after 60s timeout)
3. Worker Manager sets strategy_instance status = FAILED in DB
4. Alert sent to operators
5. Worker Manager attempts restart (up to 3 times)
6. If 3 restarts fail → set status = FAILED_PERMANENT, require manual intervention
```

### 7.5 Worker Grouping Strategy

Workers should be grouped by instrument family for efficiency:

```javascript
// workerPool.js
const groups = {
  "banknifty_group_1": {
    instruments: ["BANKNIFTY"],
    clients: [1, 2, 3],
    strategies: ["BANKNIFTY_STRADDLE", "BANKNIFTY_STRANGLE"]
  },
  "nifty_group_1": {
    instruments: ["NIFTY50"],
    clients: [1, 2, 3, 4],
    strategies: ["NIFTY_IRONCONDOR"]
  }
}
```

Each group runs in one Node.js worker thread. Ticks for NIFTY are never sent to BANKNIFTY workers.

---

## 8. Order Management State Machine

### 8.1 Complete State Transitions

```
Signal Received
       │
       ▼
   CREATED ──── Duplicate check fails ──► DISCARDED
       │
       ▼
   VALIDATED ── Risk check fails ────────► REJECTED (risk)
       │
       ▼
   QUEUED
       │
       ▼
SENT_TO_BROKER ── Network error ──► (retry up to 3x) ──► FAILED
       │
       ▼
ACKNOWLEDGED
       │
       ├──► PARTIALLY_FILLED
       │          │
       │          ▼
       └──────► FILLED
       │
       └──► REJECTED (broker)
       │
       └──► CANCELLED
```

### 8.2 State Transition Rules

| From | To | Trigger | Side Effect |
|---|---|---|---|
| CREATED | VALIDATED | Risk check passes | Log event |
| CREATED | REJECTED | Risk check fails | Log reason, alert |
| CREATED | DISCARDED | Duplicate detected | Log event_id |
| VALIDATED | QUEUED | Added to order queue | — |
| QUEUED | SENT_TO_BROKER | Broker API call made | Log submission |
| SENT_TO_BROKER | ACKNOWLEDGED | Broker confirms receipt | Store broker_order_id |
| ACKNOWLEDGED | PARTIALLY_FILLED | Broker partial fill | Update filled_quantity |
| ACKNOWLEDGED | FILLED | Broker full fill | Create trade record |
| PARTIALLY_FILLED | FILLED | Remaining quantity filled | Create trade record |
| ANY | CANCELLED | Operator action or system | Log who triggered it |
| SENT_TO_BROKER | FAILED | Max retries exceeded | Alert operators |

### 8.3 Order Event Logging

Every state transition must create an entry in `order_events`:

```javascript
{
  order_id: 1042,
  event_type: "ORDER_FILLED",
  event_data: {
    filled_quantity: 50,
    average_price: 218.50,
    broker_trade_id: "T992031"
  },
  timestamp: "2026-03-10T09:32:45Z"
}
```

---

## 9. Risk Engine Specification

### 9.1 Validation Pipeline

Every order passes through these checks in sequence. Any failure stops the chain:

```
1. Daily Loss Limit Check
2. Position Limit Check
3. Lot Size / Quantity Check
4. Order Frequency Check (rate limiter)
5. Duplicate Signal Check
6. Margin Adequacy Check (if available from broker)
7. Market Hours Check
```

### 9.2 Daily Loss Limit Algorithm

```javascript
async function checkDailyLoss(clientId, orderValue) {
  const todayPnl = await getTodayRealizedPnl(clientId);
  const unrealizedPnl = await getUnrealizedPnl(clientId);
  const totalLoss = Math.min(0, todayPnl + unrealizedPnl);

  if (Math.abs(totalLoss) >= client.riskLimits.maxDailyLoss) {
    await triggerClientStop(clientId, "DAILY_LOSS_LIMIT_BREACHED");
    return { approved: false, reason: "Daily loss limit reached" };
  }
  return { approved: true };
}
```

### 9.3 Kill Switch Specification

The kill switch must execute the following atomically:

```
1. Set global kill_switch_active = true in Redis (immediate effect)
2. All strategy workers check this flag before every signal emit
3. OMS rejects all new order requests while flag is active
4. Broker Gateway sends cancel requests for all QUEUED / SENT / ACKNOWLEDGED orders
5. Optionally: send market orders to close all open positions (operator configurable)
6. Persist kill switch activation to DB with timestamp and operator ID
7. Send alert to all operators
```

### 9.4 Per-Client Risk Limits Schema

```javascript
{
  client_id: 3,
  max_daily_loss: 50000,          // INR
  max_open_positions: 10,
  max_lots_per_trade: 5,
  max_orders_per_minute: 10,
  signal_cooldown_seconds: 5,
  auto_square_off_time: "15:15",  // force close all positions
  paper_mode: true                // override to never send real orders
}
```

---

## 10. Broker Gateway Specification

### 10.1 Unified Interface

All broker adapters must implement this interface:

```javascript
class BrokerInterface {
  async connect()                          {}
  async disconnect()                       {}
  async placeOrder(orderParams)            {}
  async cancelOrder(brokerOrderId)         {}
  async modifyOrder(brokerOrderId, params) {}
  async getOrderStatus(brokerOrderId)      {}
  async getPositions(clientId)             {}
  async getAllOrders(clientId)             {}
  async getMargin(clientId)               {}
  async getInstrumentDetails(symbol)       {}
}
```

### 10.2 Broker Routing Logic

```javascript
// brokerRouter.js
function getAdapter(clientId) {
  const account = await getClientAccount(clientId);
  switch (account.broker_name) {
    case "ANGEL_ONE":  return new AngelOneAdapter(account.credentials);
    case "XTS":        return new XtsAdapter(account.credentials);
    case "SYMPHONY":   return new SymphonyAdapter(account.credentials);
    default:           throw new Error("Unknown broker");
  }
}
```

### 10.3 Paper Trading Mode Override

In paper mode, the broker gateway does not call real broker APIs. Instead it simulates fills:

```javascript
async placeOrder(orderParams) {
  if (globalConfig.paperMode || client.riskLimits.paper_mode) {
    return this.simulateFill(orderParams);
  }
  return this.realBrokerApi.placeOrder(orderParams);
}
```

---

## 11. API Specification

### 11.1 Authentication

All API endpoints require JWT token in header:
```
Authorization: Bearer <token>
```

### 11.2 Core Endpoints

#### Clients

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/clients` | List all clients |
| GET | `/api/clients/:id` | Get client details |
| GET | `/api/clients/:id/positions` | Get client open positions |
| GET | `/api/clients/:id/orders` | Get client order history |
| GET | `/api/clients/:id/pnl` | Get client PnL summary |
| GET | `/api/clients/:id/strategies` | Get running strategies for client |

#### Strategies

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/strategies` | List all strategies |
| GET | `/api/strategies/:id` | Strategy details and status |
| POST | `/api/strategies/start` | Start a strategy for a client |
| POST | `/api/strategies/stop` | Stop a strategy for a client |
| GET | `/api/strategies/:id/signals` | Recent signals from strategy |

#### System

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/system/health` | Service health statuses |
| POST | `/api/system/killswitch` | Trigger emergency kill switch |
| GET | `/api/system/logs` | Fetch recent system logs |

### 11.3 WebSocket Events (Dashboard Push)

| Event | Payload | Trigger |
|---|---|---|
| `signal` | Signal object | New strategy signal generated |
| `order_update` | Order with new status | Order state change |
| `position_update` | Updated position | Fill confirmed |
| `pnl_update` | Client PnL | Position price change |
| `alert` | Alert message | Risk breach or system error |
| `worker_status` | Worker ID + status | Worker starts, stops, fails |

---

## 12. Event Flow Diagrams

### 12.1 Happy Path: Signal → Trade

```
09:31:10.200  AngelOne WS tick received
09:31:10.201  Market Data normalizes tick
09:31:10.202  Tick published to Redis: market_ticks
09:31:10.203  Strategy Worker receives tick
09:31:10.210  Strategy logic runs (BANKNIFTY_STRADDLE)
09:31:10.215  Signal condition met
09:31:10.216  Signal event published to Redis: strategy_signals
              { event_id: "STRAT_3_21_20260310_093110_001", action: "SELL", ... }
09:31:10.217  Order Manager receives signal
09:31:10.218  Duplicate check: event_id not seen before → proceed
09:31:10.218  Order CREATED in DB
09:31:10.219  Order event logged: ORDER_CREATED
09:31:10.220  Risk Engine receives order_request
09:31:10.221  Daily loss check: OK
09:31:10.221  Position limit check: OK
09:31:10.222  Order status → VALIDATED
09:31:10.222  Order event logged: ORDER_VALIDATED
09:31:10.223  Broker Gateway receives validated_order
09:31:10.224  Angel One API call: placeOrder()
09:31:10.350  Angel One response: order_id = "A182993"
09:31:10.351  Order status → ACKNOWLEDGED
09:31:10.351  Order event logged: ORDER_ACKNOWLEDGED
09:31:10.900  Angel One WebSocket fill event received
09:31:10.901  Order status → FILLED
09:31:10.902  Trade record created
09:31:10.903  Position Engine updates position for Client 3
09:31:10.904  portfolio_snapshots updated
09:31:10.905  Dashboard notified via WebSocket: position_update
```

### 12.2 Risk Rejection Flow

```
Signal received by OMS
       │
       ▼
Order CREATED
       │
       ▼
Risk check: Daily loss limit BREACHED
       │
       ▼
Order status → REJECTED (risk)
Order event logged: ORDER_REJECTED_RISK
Client strategies → STOPPED
Alert sent to operators
Dashboard updated
```

---

## 13. Race Condition & Duplicate Trade Prevention

### 13.1 Problem Scenarios

**Scenario A — Rapid market move:**  
Strategy emits signal at 09:31:10.000 and again at 09:31:10.050 before the first is processed.

**Scenario B — Worker restart:**  
Worker crashes mid-signal, restarts, re-processes the same tick.

**Scenario C — Two workers with same client/strategy:**  
Misconfiguration causes two workers to run the same strategy for the same client.

### 13.2 Prevention Mechanisms

| Mechanism | Prevents |
|---|---|
| Unique `event_id` per signal (stored in DB) | Scenario A and B |
| OMS checks `event_id` against signals table before processing | Scenario A and B |
| Signal cooldown per strategy instance (default 5s) | Scenario A |
| OMS checks for active open order before creating new one | Scenario A |
| Worker Manager enforces one worker per strategy_instance_id | Scenario C |
| Redis `SET NX` (set if not exists) lock per strategy_instance before signal emit | Scenario C |

### 13.3 Redis Lock Pattern for Signal Emission

```javascript
// In strategy worker, before emitting signal:
const lockKey = `signal_lock:${strategyInstanceId}`;
const lockAcquired = await redis.set(lockKey, '1', 'NX', 'EX', 5); // 5s TTL

if (!lockAcquired) {
  logger.info("Signal skipped — cooldown active");
  return;
}

await publishSignal(signal);
```

---

## 14. Worker Scaling & CPU Model

### 14.1 Capacity Estimate

| Resource | Count |
|---|---|
| Available CPU cores | 20 |
| System services (non-strategy) | ~8 cores |
| Strategy worker CPUs | ~12 cores |
| Strategy instances per worker | ~25–30 |
| Total supportable instances | ~300–360 |

### 14.2 Worker Configuration (CLI args)

```bash
node worker.js \
  --group=banknifty \
  --clients=1,2,3 \
  --strategies=BANKNIFTY_STRADDLE,BANKNIFTY_STRANGLE \
  --max-instances=30
```

### 14.3 Memory Budget Per Instance

| Data | Max Size |
|---|---|
| Recent candles (last 100) | ~50 KB |
| Indicator state | ~10 KB |
| Strategy parameters | ~2 KB |
| Position state | ~5 KB |
| **Total per instance** | **~70 KB** |

360 instances × 70 KB ≈ **25 MB** — completely negligible.

### 14.4 Tick Processing Optimization

```javascript
// Tick filtering — avoid unnecessary work
onMarketTick(tick) {
  // Only process ticks for instruments this worker cares about
  if (!this.subscribedInstruments.has(tick.symbol)) return;

  // Run only strategies that use this instrument
  const relevant = this.instances.filter(i => i.usesInstrument(tick.symbol));
  for (const instance of relevant) {
    instance.processTick(tick);
  }
}
```

---

## 15. Docker Compose Architecture

### 15.1 Service Definitions (Summary)

```yaml
# docker/docker-compose.yml

version: "3.8"

services:

  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: algo_trading
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: always

  redis:
    image: redis:7-alpine
    restart: always

  market-data-service:
    build: ./Dockerfiles/Dockerfile.strategy
    command: node src/marketData/marketDataService.js
    depends_on: [redis, postgres]
    restart: always
    environment:
      - ANGEL_ONE_API_KEY=${ANGEL_ONE_API_KEY}

  strategy-engine:
    build: ./Dockerfiles/Dockerfile.strategy
    command: node src/strategyEngine/workerManager.js
    depends_on: [redis, postgres, market-data-service]
    restart: always
    deploy:
      resources:
        limits:
          cpus: "12"

  order-manager:
    build: ./Dockerfiles/Dockerfile.strategy
    command: node src/execution/orderManager/orderManager.js
    depends_on: [redis, postgres]
    restart: always

  risk-engine:
    build: ./Dockerfiles/Dockerfile.strategy
    command: node src/execution/riskEngine/riskManager.js
    depends_on: [redis, postgres]
    restart: always

  broker-gateway:
    build: ./Dockerfiles/Dockerfile.strategy
    command: node src/execution/brokerGateway/brokerRouter.js
    depends_on: [redis, postgres]
    restart: always

  api-server:
    build: ./Dockerfiles/Dockerfile.api
    command: node src/api/server.js
    ports:
      - "3001:3001"
    depends_on: [redis, postgres]
    restart: always

  dashboard:
    build: ./Dockerfiles/Dockerfile.dashboard
    ports:
      - "3000:3000"
    depends_on: [api-server]
    restart: always

volumes:
  postgres_data:
```

### 15.2 Container Restart Policies

All containers must use `restart: always` so the system recovers automatically from crashes or server reboots.

---

## 16. Security Architecture

### 16.1 Credential Encryption

Broker API keys and secrets are encrypted before storage in the database using AES-256:

```javascript
// Encrypt before storing
const encrypted = aes256.encrypt(process.env.ENCRYPTION_KEY, rawApiKey);
await db.accounts.update({ api_key: encrypted });

// Decrypt only in broker-gateway service
const raw = aes256.decrypt(process.env.ENCRYPTION_KEY, stored.api_key);
```

The `ENCRYPTION_KEY` must be stored only in the server's environment, never in code or version control.

### 16.2 Authentication Flow

```
Operator submits username + password
       │
       ▼
API Server validates against hashed credentials in DB
       │
       ▼
JWT token issued (expiry: 8 hours)
       │
       ▼
Token included in all subsequent requests
       │
       ▼
RBAC middleware checks role before each route
```

### 16.3 Role Permissions Matrix

| Action | Viewer | Operator | Admin |
|---|---|---|---|
| View dashboard | ✓ | ✓ | ✓ |
| View client portfolios | ✓ | ✓ | ✓ |
| Start/stop strategies | ✗ | ✓ | ✓ |
| Activate kill switch | ✗ | ✓ | ✓ |
| Modify risk limits | ✗ | ✗ | ✓ |
| View/manage API credentials | ✗ | ✗ | ✓ |
| View audit logs | ✗ | ✓ | ✓ |
| Create/delete operators | ✗ | ✗ | ✓ |

### 16.4 Secrets That Must Never Be In Code

- Broker API keys and secrets
- Database credentials
- Redis password
- JWT signing secret
- Encryption key

All must be loaded from environment variables at runtime.

### 16.5 Kill Switch Authorization

The kill switch endpoint must require:
1. Valid JWT token
2. Role: Operator or Admin
3. Confirmation parameter `confirm=true` in request body
4. All activations logged to `operator_audit_log` with user identity

### 16.6 Network Exposure

- Dashboard and API must only be accessible on the local network
- No ports exposed to public internet by default
- If remote access is needed, use VPN — not port forwarding

---

## 17. Failure Recovery Specifications

### 17.1 WebSocket Reconnection

```javascript
// Exponential backoff reconnect
const backoffSequence = [1000, 2000, 5000, 10000, 30000]; // ms

let attempt = 0;
function reconnect() {
  if (attempt >= backoffSequence.length) {
    sendCriticalAlert("WebSocket reconnect failed after max attempts");
    return;
  }
  setTimeout(() => {
    connectWebSocket();
    attempt++;
  }, backoffSequence[attempt]);
}
```

### 17.2 PostgreSQL Connection Loss

- All DB operations wrapped in try/catch
- Failed operations queued in Redis for retry
- Maximum queue size: 1000 operations
- Alert sent if DB is unreachable for > 30 seconds

### 17.3 Redis Connection Loss

- All services detect Redis failure within 5 seconds via heartbeat
- Market data ticks are buffered in memory (last 1000 ticks, rolling)
- Strategies pause signal emission until Redis reconnects
- Operator alert sent immediately

### 17.4 Strategy Worker Crash Loop Protection

If a worker crashes and restarts 3 times within 10 minutes:
1. Worker is marked `FAILED_PERMANENT`
2. No further auto-restart
3. Critical alert sent to operators
4. Manual intervention required via dashboard

### 17.5 Order Reconciliation

At startup (and every 15 minutes during trading hours), the OMS must:
1. Query broker for all orders placed today
2. Compare against internal order records
3. Flag any discrepancies (e.g., order filled at broker but not in DB)
4. Alert operators on mismatch

### 17.6 Server Reboot Recovery

- Docker Compose restart policies bring all containers back automatically
- Strategy Engine re-queries DB for active `strategy_instances` and restarts appropriate workers
- Market Data Service resubscribes to instruments
- OMS reconciles open orders with broker API

---

## 18. Monitoring & Observability Spec

### 18.1 Health Check Endpoints

Each service exposes:
```
GET /health
Response: { "status": "ok", "uptime": 3600, "timestamp": "..." }
```

### 18.2 Dashboard System Health Indicators

| Indicator | Status Values | Alert Threshold |
|---|---|---|
| Market Data WebSocket | Connected / Reconnecting / Down | Down > 30s |
| Redis | Online / Offline | Offline > 5s |
| PostgreSQL | Online / Offline | Offline > 10s |
| Strategy workers | Running count / Total count | Any worker FAILED |
| Broker API latency | ms | > 500ms average |
| Order rejection rate | % | > 10% in 5 min |
| Daily PnL per client | INR value | Loss > 80% of limit |

### 18.3 Log Levels

| Level | Usage |
|---|---|
| DEBUG | Development only — tick-level events |
| INFO | Normal operations — signal generated, order placed |
| WARN | Recoverable issues — reconnect attempt, slow response |
| ERROR | Failures — order rejected, worker crashed |
| CRITICAL | Requires immediate action — DB down, kill switch activated |

---

## 19. Known Technical Risks & Mitigations

| Risk | Description | Mitigation |
|---|---|---|
| Memory leak in long-running workers | Workers accumulate data over time | Worker memory limit + scheduled daily restart outside market hours |
| Clock drift between server and broker | Timestamps mismatch causes timing bugs | Enforce NTP sync; all timestamps in UTC; use broker timestamp not local time |
| Redis eviction under memory pressure | Events lost if Redis runs out of memory | Set `maxmemory-policy noeviction` for order channels; monitor Redis memory |
| Broker API rate limiting | Angel One / XTS throttle API calls | Order queue with rate limiter; track requests per minute per client |
| Incorrect strategy parameters in DB | Wrong config causes wrong trades | Parameter validation on load; staging environment before prod |
| Token expiry during trading hours | Broker access token expires mid-session | Token refresh scheduler that runs 30 min before expiry; fallback to re-login |
| Multiple strategy_instances for same client/strategy | Duplicate trades | DB unique constraint on (client_id, strategy_id) + Worker Manager lock |
| Open positions at market close (auto square-off missed) | Overnight risk | Auto square-off job at configurable time (default 15:15); alert if positions remain at 15:25 |
| Server power failure during trading | Incomplete orders, untracked positions | UPS recommended; order reconciliation on startup; broker provides end-of-day position report |
| Operator accidentally triggers kill switch | All trading stopped unintentionally | Two-step confirmation; audit log; easy re-activation flow |
| Strategy bug causes continuous signal spam | Thousands of orders per second | Signal cooldown (5s default) + order frequency rate limiter (10/min default) |
| Database grows too large over time | Slow queries, disk full | Archival job to move old data to archive tables; disk usage monitoring |
| Timezone confusion (IST vs UTC) | Trades at wrong time | All internal timestamps UTC; display in IST; market hours check uses IST explicitly |
| Concurrent writes to positions table | Stale PnL, incorrect quantities | PostgreSQL transactions + row-level locking on position updates |

---

*End of SRD v1.0*