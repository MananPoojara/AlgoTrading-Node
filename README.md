# Algo Trading Platform

Algorithmic Trading Platform for automated strategy execution with multi-client support.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file and configure
cp .env.example .env

# Start all services with Docker
docker-compose up -d

# Run migrations
npm run migrate

# Start the platform
npm start
```

## Project Structure

```
algo-trading-platform/
├── docker/              # Docker configuration files
├── config/              # Configuration files
├── src/
│   ├── core/           # Core utilities
│   ├── marketData/      # Market data ingestion
│   ├── brokers/        # Broker adapters
│   ├── strategies/     # Trading strategies
│   ├── strategyEngine/ # Strategy worker management
│   ├── execution/      # OMS, Risk Engine, Broker Gateway
│   ├── portfolio/      # Position tracking & PnL
│   ├── api/            # REST API server
│   └── dashboard/      # Next.js dashboard
├── scripts/            # Utility scripts
├── tests/              # Test files
└── ...
```

## Documentation

- [PRD.md](./PRD.md) - Product Requirements
- [SRD.md](./SRD.md) - System Requirements
- [tasks.md](./tasks.md) - Development Roadmap

## Technology Stack

- **Runtime:** Node.js 18+
- **API:** Express/Fastify
- **Frontend:** Next.js
- **Database:** PostgreSQL
- **Event Bus:** Redis
- **Containerization:** Docker + Docker Compose
