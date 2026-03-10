# Algo Trading Platform - Development Roadmap

## Overview

This document outlines the implementation roadmap for the Algorithmic Trading Platform based on PRD.md and SRD.md specifications.

**System:** Algorithmic Trading Platform  
**Technology Stack:** Node.js, Next.js, PostgreSQL, Redis, Docker  
**Initial Capacity:** 9 clients, ~40 strategies

---

## Phase 1: Foundation & Infrastructure

### Objective
Set up core infrastructure, database schema, event bus, and base framework components.

### Duration
**Estimated:** 2-3 weeks

### Tasks

#### 1.1 Project Structure & Docker Setup
- [ ] Create project directory structure per SRD Section 3
- [ ] Set up Docker Compose with all services (postgres, redis, etc.)
- [ ] Create Dockerfiles for each microservice
- [ ] Configure environment variables (.env.example)
- [ ] Set up logging infrastructure (Winston)

#### 1.2 Database Setup
- [ ] Create PostgreSQL migrations for all tables (SRD Section 4):
  - `clients`
  - `accounts`
  - `strategies`
  - `strategy_instances`
  - `signals`
  - `orders`
  - `order_events`
  - `trades`
  - `positions`
  - `portfolio_snapshots`
  - `system_logs`
  - `operator_audit_log`
- [ ] Set up database connection pooling
- [ ] Create database seed data for testing

#### 1.3 Event Bus (Redis) Setup
- [ ] Configure Redis client connection
- [ ] Set up Redis channels per SRD Section 5.1:
  - `market_ticks`
  - `strategy_signals`
  - `order_requests`
  - `validated_orders`
  - `rejected_orders`
  - `broker_responses`
  - `trade_events`
  - `position_updates`
  - `system_alerts`
  - `worker_heartbeats`
- [ ] Implement Redis publisher/subscriber utilities

#### 1.4 Core Utilities
- [ ] Implement logger (SRD Section 17.3)
- [ ] Create unique event_id generator (SRD Section 5.2)
- [ ] Build time utilities (UTC handling)
- [ ] Create validation helpers

#### 1.5 Health Check Infrastructure
- [ ] Implement /health endpoints for all services
- [ ] Set up health monitoring for Redis, PostgreSQL

### Deliverables
- [ ] Docker Compose environment running locally
- [ ] Database schema migrations applied
- [ ] Redis event bus operational
- [ ] All services responding to health checks

### Estimated Files to/
├── docker-compose.yml
└ Create
```
docker── Dockerfile.*

src/
├── core/
│   ├── eventBus/
│   │   ├── redisClient.js
│   │   ├── publisher.js
│   │   └── subscriber.js
│   ├── logger/
│   │   └── logger.js
│   └── utils/
│       ├── time.js
│       ├── idGenerator.js
│       └── helpers.js
├── database/
│   ├── postgresClient.js
│   ├── migrations/
│   │   └── 001_initial_schema.sql
│   └── models/
│       └── ( Sequelize or Prisma models )
config/
├── default.js
└── .env.example
```

---

## Phase 2: Market Data Service

### Objective
Build the market data ingestion pipeline from Angel One WebSocket to Redis.

### Duration
**Estimated:** 1-2 weeks

### Tasks

#### 2.1 Angel One WebSocket Connection
- [ ] Implement Angel One WebSocket client (SRD Section 6.1)
- [ ] Handle connection, reconnection with exponential backoff
- [ ] Implement instrument subscription management
- [ ] Add connection state tracking

#### 2.2 Data Normalization
- [ ] Create data normalizer to convert Angel One format to internal format (SRD Section 6.3)
- [ ] Handle all tick data types: LTP, OHLC, Bid/Ask, Volume
- [ ] Add timestamp normalization (UTC)

#### 2.3 Redis Publishing
- [ ] Publish normalized ticks to `market_ticks` channel
- [ ] Implement tick buffering (last 1000 ticks in memory)

#### 2.4 Instrument Management
- [ ] Track subscribed instruments
- [ ] Dynamic subscription add/remove when strategies start/stop

### Deliverables
- [ ] Angel One WebSocket connected and receiving data
- [ ] Ticks normalized and published to Redis
- [ ] Auto-reconnect on disconnect
- [ ] Instrument subscription management working

### Estimated Files to Create
```
src/marketData/
├── marketDataService.js
├── angelWebsocket.js
├── dataNormalizer.js
└── instrumentManager.js
```

---

## Phase 3: Strategy Engine (Worker Framework)

### Objective
Build the strategy worker framework with lifecycle management and per-client strategy instances.

### Duration
**Estimated:** 2-3 weeks

### Tasks

#### 3.1 Base Strategy Class
- [ ] Create abstract baseStrategy.js (SRD Section 8)
- [ ] Define strategy interface (onMarketTick, getSignal)
- [ ] Implement signal generation methods

#### 3.2 Worker Manager
- [ ] Implement workerManager.js for lifecycle states (SRD Section 7.1):
  - CREATED → INITIALIZING → RUNNING → PAUSED → STOPPED
  - FAILED → RESTART
- [ ] Implement heartbeat monitoring (every 30 seconds)
- [ ] Add crash detection and auto-restart (max 3 retries)

#### 3.3 Worker Pool & Grouping
- [ ] Implement workerPool.js for grouping by instrument (SRD Section 7.5)
- [ ] Create clientStrategyMapper.js
- [ ] Implement tick filtering (only process relevant instruments)

#### 3.4 Strategy Loader
- [ ] Dynamic strategy class loading (strategyLoader.js)
- [ ] Parameter loading from DB

### Deliverables
- [ ] Worker lifecycle management operational
- [ ] Heartbeat monitoring active
- [ ] Workers grouped by instrument
- [ ] Crash recovery working

### Estimated Files to Create
```
src/strategyEngine/
├── workerManager.js
├── strategyLoader.js
├── workerPool.js
├── clientStrategyMapper.js
└── heartbeatMonitor.js
```

---

## Phase 4: Sample Strategy Implementation

### Objective
Implement sample trading strategies to validate the framework.

### Duration
**Estimated:** 1-2 weeks

### Tasks

#### 4.1 Option Selling Strategies
- [ ] Implement BANKNIFTY Straddle (bankniftyStraddle.js)
- [ ] Implement NIFTY Iron Condor (niftyIronCondor.js)
- [ ] Implement Weekly Strangle (weeklyStrangle.js)

#### 4.2 Option Buying Strategies
- [ ] Implement Breakout Strategy (breakoutStrategy.js)
- [ ] Implement Momentum Strategy (momentumStrategy.js)

#### 4.3 Spread & Intraday
- [ ] Implement Bull/Bear Spread (bullSpread.js)
- [ ] Implement Intraday Momentum (intradayMomentum.js)

#### 4.4 Strategy Testing
- [ ] Test strategy signal generation
- [ ] Verify tick processing
- [ ] Validate signal format

### Deliverables
- [ ] 5+ sample strategies implemented
- [ ] Strategies generating signals in test environment

### Estimated Files to Create
```
src/strategies/
├── baseStrategy.js
├── optionSelling/
│   ├── bankniftyStraddle.js
│   ├── niftyIronCondor.js
│   └── weeklyStrangle.js
├── optionBuying/
│   ├── breakoutStrategy.js
│   └── momentumStrategy.js
├── spreads/
│   └── bullSpread.js
└── intraday/
    └── intradayMomentum.js
```

---

## Phase 5: Paper Trading & OMS

### Objective
Build the Order Management System with paper trading simulation.

### Duration
**Estimated:** 2-3 weeks

### Tasks

#### 5.1 Order Manager (OMS)
- [ ] Implement orderManager.js main service
- [ ] Build order state machine (SRD Section 8.1)
- [ ] Implement order validation (format check, deduplication)
- [ ] Add order queue management
- [ ] Create order event logging

#### 5.2 Duplicate Prevention
- [ ] Implement event_id check against signals table (SRD Section 13.1)
- [ ] Add active order check per strategy instance
- [ ] Implement Redis lock for signal emission

#### 5.3 Paper Trading Simulation
- [ ] Implement simulated order fills
- [ ] Add paper mode order handling
- [ ] Create position tracking for paper trades

#### 5.4 Signal to Order Flow
- [ ] Subscribe to `strategy_signals` channel
- [ ] Convert signals to orders
- [ ] Publish to `order_requests` channel

### Deliverables
- [ ] Order state machine fully operational
- [ ] Signal processing working
- [ ] Paper trading simulation functional
- [ ] Deduplication working

### Estimated Files to Create
```
src/execution/
├── orderManager/
│   ├── orderManager.js
│   ├── orderStateMachine.js
│   ├── orderValidator.js
│   └── orderQueue.js
└── brokerGateway/
    ├── brokerRouter.js
    └── retryHandler.js
```

---

## Phase 6: Risk Engine

### Objective
Build comprehensive risk management controls.

### Duration
**Estimated:** 1-2 weeks

### Tasks

#### 6.1 Risk Validation Pipeline
- [ ] Implement riskManager.js orchestrator
- [ ] Add daily loss limit check (SRD Section 9.2)
- [ ] Implement position limits check
- [ ] Add lot size / quantity validation
- [ ] Implement order frequency rate limiter

#### 6.2 Risk Rejection Handling
- [ ] Publish rejected orders to `rejected_orders` channel
- [ ] Add risk breach logging and alerts

#### 6.3 Signal Cooldown
- [ ] Implement signal cooldown per strategy (default 5s)
- [ ] Add duplicate signal blocking

#### 6.4 Kill Switch
- [ ] Implement killSwitch.js (SRD Section 9.3)
- [ ] Add global kill switch flag in Redis
- [ ] Implement order cancellation on kill switch
- [ ] Add audit logging

### Deliverables
- [ ] All risk checks operational
- [ ] Kill switch functional
- [ ] Signal cooldown working
- [ ] Risk alerts generated

### Estimated Files to Create
```
src/execution/riskEngine/
├── riskManager.js
├── dailyLossLimit.js
├── positionLimits.js
├── orderFrequency.js
└── killSwitch.js
```

---

## Phase 7: Broker Integration

### Objective
Build broker adapters with paper trading support.

### Duration
**Estimated:** 1-2 weeks

### Tasks

#### 7.1 Broker Interface
- [ ] Define brokerInterface.js abstract class (SRD Section 10.1)
- [ ] Implement unified interface methods

#### 7.2 Angel One Adapter
- [ ] Implement angelClient.js for API communication
- [ ] Implement order placement (placeOrder.js)
- [ ] Implement order cancellation
- [ ] Implement position/order queries

#### 7.3 Paper Trading Mode
- [ ] Add paper mode override in broker gateway
- [ ] Implement simulateFill() for paper orders

#### 7.4 XTS & Symphony Adapters (Phase 2)
- [ ] Stub implementations for future live trading

### Deliverables
- [ ] Angel One adapter functional
- [ ] Paper trading mode working
- [ ] Broker routing operational

### Estimated Files to Create
```
src/brokers/
├── brokerInterface.js
├── angelOne/
│   ├── angelClient.js
│   └── angelOrders.js
├── xts/
│   ├── xtsClient.js
│   └── xtsOrders.js
└── symphony/
    └── symphonyClient.js
```

---

## Phase 8: Portfolio & Position Tracking

### Objective
Build position tracking and PnL calculation.

### Duration
**Estimated:** 1 week

### Tasks

#### 8.1 Position Tracker
- [ ] Implement positionTracker.js
- [ ] Handle trade events from broker
- [ ] Update positions on fill

#### 8.2 PnL Calculator
- [ ] Implement pnlCalculator.js
- [ ] Calculate unrealized PnL
- [ ] Calculate realized PnL

#### 8.3 Margin Tracker
- [ ] Implement marginTracker.js
- [ ] Track margin usage

#### 8.4 Portfolio Snapshots
- [ ] Implement periodic snapshots
- [ ] Store in portfolio_snapshots table

### Deliverables
- [ ] Live position tracking
- [ ] Real-time PnL calculation
- [ ] Margin tracking working

### Estimated Files to Create
```
src/portfolio/
├── positionTracker.js
├── pnlCalculator.js
└── marginTracker.js
```

---

## Phase 9: API Server

### Objective
Build the REST API server for dashboard integration.

### Duration
**Estimated:** 2 weeks

### Tasks

#### 9.1 Server Setup
- [ ] Create Express/Fastify server.js
- [ ] Set up middleware (auth, logging)
- [ ] Configure routes

#### 9.2 Authentication & RBAC
- [ ] Implement JWT authentication
- [ ] Create auth middleware
- [ ] Implement RBAC middleware
- [ ] Add operator login/logout

#### 9.3 API Endpoints
- [ ] Implement client endpoints (SRD Section 11.2)
- [ ] Implement strategy endpoints
- [ ] Implement order endpoints
- [ ] Implement position endpoints
- [ ] Implement system endpoints (health, kill switch)

#### 9.4 WebSocket Server
- [ ] Create websocketServer.js
- [ ] Implement real-time push events (SRD Section 11.3)

### Deliverables
- [ ] API server running on port 3001
- [ ] JWT authentication working
- [ ] All CRUD endpoints functional
- [ ] WebSocket pushing real-time updates

### Estimated Files to Create
```
src/api/
├── server.js
├── websocketServer.js
├── middleware/
│   ├── auth.js
│   └── rbac.js
├── controllers/
│   ├── clientController.js
│   ├── strategyController.js
│   ├── orderController.js
│   ├── positionController.js
│   └── systemController.js
└── routes/
    ├── clients.js
    ├── strategies.js
    ├── orders.js
    ├── positions.js
    └── system.js
```

---

## Phase 10: Web Dashboard

### Objective
Build the Next.js monitoring dashboard.

### Duration
**Estimated:** 2-3 weeks

### Tasks

#### 10.1 Dashboard Setup
- [ ] Set up Next.js project
- [ ] Configure styling and layout
- [ ] Set up WebSocket client

#### 10.2 System Overview Dashboard
- [ ] Display active strategies count
- [ ] Display client count
- [ ] Show orders placed today
- [ ] Display total PnL
- [ ] Show system health indicators

#### 10.3 Client Dashboard
- [ ] Portfolio summary (PnL, margin)
- [ ] Open positions view
- [ ] Order history
- [ ] Running strategies per client
- [ ] Risk status display

#### 10.4 Strategy Dashboard
- [ ] Strategy details and status
- [ ] Signals generated today
- [ ] Per-client PnL
- [ ] Error logs

#### 10.5 Kill Switch Panel
- [ ] Protected kill switch button
- [ ] Two-step confirmation
- [ ] Audit logging display

### Deliverables
- [ ] Dashboard running on port 3000
- [ ] All views implemented
- [ ] Real-time updates via WebSocket
- [ ] Kill switch functional

### Estimated Files to Create
```
src/dashboard/
├── pages/
│   ├── index.js
│   ├── clients/
│   ├── strategies/
│   └── system/
├── components/
│   ├── Dashboard/
│   ├── ClientView/
│   ├── StrategyView/
│   └── KillSwitch/
└── hooks/
    └── useWebSocket.js
```

---

## Phase 11: Integration & Testing

### Objective
Full system integration testing and validation.

### Duration
**Estimated:** 1-2 weeks

### Tasks

#### 11.1 End-to-End Testing
- [ ] Test full signal-to-order flow
- [ ] Verify risk controls
- [ ] Test kill switch activation
- [ ] Test crash recovery

#### 11.2 Paper Trading Validation
- [ ] Run strategies in paper mode
- [ ] Compare outputs with AFL (SRD Section 14)
- [ ] Document discrepancies
- [ ] Fix any logic issues

#### 11.3 Performance Testing
- [ ] Load test with 40+ strategies
- [ ] Verify latency under load
- [ ] Test memory usage

#### 11.4 Stability Testing
- [ ] Run 8+ hour stress test
- [ ] Verify no memory leaks
- [ ] Test reconnection handling

### Deliverables
- [ ] All integration tests passing
- [ ] Paper trading validated
- [ ] System stable under load

---

## Phase 12: Live Trading Preparation

### Objective
Prepare for live trading with XTS/Symphony integration.

### Duration
**Estimated:** 1-2 weeks

### Tasks

#### 12.1 XTS/Symphony Adapters
- [ ] Complete XTS adapter implementation
- [ ] Complete Symphony adapter implementation
- [ ] Implement token refresh logic

#### 12.2 Live Mode Controls
- [ ] Add live trading toggle
- [ ] Implement trade confirmation steps
- [ ] Add additional risk checks for live mode

#### 12.3 Documentation
- [ ] Document deployment procedures
- [ ] Create operator manual
- [ ] Document emergency procedures

### Deliverables
- [ ] XTS/Symphony adapters complete
- [ ] Live trading toggle functional
- [ ] Documentation complete

---

## Summary: Phase Timeline

| Phase | Duration | Key Deliverables |
|-------|----------|------------------|
| Phase 1: Foundation | 2-3 weeks | Docker, DB, Redis, Core Utils |
| Phase 2: Market Data | 1-2 weeks | Angel One WS, Tick publishing |
| Phase 3: Strategy Engine | 2-3 weeks | Worker framework, lifecycle |
| Phase 4: Sample Strategies | 1-2 weeks | 5+ trading strategies |
| Phase 5: OMS | 2-3 weeks | Order management, paper trading |
| Phase 6: Risk Engine | 1-2 weeks | Risk controls, kill switch |
| Phase 7: Broker Integration | 1-2 weeks | Angel One adapter |
| Phase 8: Portfolio | 1 week | Position tracking, PnL |
| Phase 9: API Server | 2 weeks | REST API, WebSocket |
| Phase 10: Dashboard | 2-3 weeks | Next.js dashboard |
| Phase 11: Integration | 1-2 weeks | E2E testing, validation |
| Phase 12: Live Trading | 1-2 weeks | XTS/Symphony, go-live |

**Total Estimated Timeline:** 16-22 weeks

---

## Critical Path

The critical path for implementation:

```
Phase 1 (Foundation) 
    → Phase 2 (Market Data)
    → Phase 3 (Strategy Engine)
    → Phase 5 (OMS)
    → Phase 6 (Risk Engine)
    → Phase 9-10 (API + Dashboard)
    → Phase 11 (Integration)
```

---

## Dependencies Between Phases

| Phase | Depends On |
|-------|-----------|
| Phase 2 | Phase 1 |
| Phase 3 | Phase 1, Phase 2 |
| Phase 4 | Phase 3 |
| Phase 5 | Phase 1, Phase 3 |
| Phase 6 | Phase 1, Phase 5 |
| Phase 7 | Phase 1, Phase 5 |
| Phase 8 | Phase 7 |
| Phase 9 | Phase 1, Phase 5, Phase 6 |
| Phase 10 | Phase 9 |
| Phase 11 | All previous |
| Phase 12 | Phase 7, Phase 11 |

---

## Next Steps

1. **Confirm Phase 1 scope** - Infrastructure and foundation
2. **Begin Phase 1 implementation** - Start with Docker, database, Redis setup
3. **Validate after each phase** - Test deliverables before proceeding

---

*Document generated from PRD.md and SRD.md specifications*
