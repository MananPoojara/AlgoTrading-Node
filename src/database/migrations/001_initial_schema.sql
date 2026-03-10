-- Database Migration: Initial Schema
-- Version: 1.0
-- Description: Creates all core tables for the Algorithmic Trading Platform
-- Generated: Based on SRD.md Section 4

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Table: clients
-- ============================================
CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
    risk_limits JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_clients_status ON clients(status);
CREATE INDEX idx_clients_name ON clients(name);

-- ============================================
-- Table: accounts
-- ============================================
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    broker_name VARCHAR(50) NOT NULL CHECK (broker_name IN ('ANGEL_ONE', 'XTS', 'SYMPHONY')),
    api_key TEXT NOT NULL,
    api_secret TEXT NOT NULL,
    access_token TEXT,
    token_expiry TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, broker_name)
);

CREATE INDEX idx_accounts_client_id ON accounts(client_id);
CREATE INDEX idx_accounts_broker_name ON accounts(broker_name);

-- ============================================
-- Table: strategies
-- ============================================
CREATE TABLE IF NOT EXISTS strategies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    type VARCHAR(50) CHECK (type IN ('option_selling', 'option_buying', 'spread', 'intraday')),
    version VARCHAR(20) DEFAULT '1.0',
    description TEXT,
    file_path VARCHAR(255),
    parameters JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_strategies_type ON strategies(type);
CREATE INDEX idx_strategies_name ON strategies(name);

-- ============================================
-- Table: strategy_instances
-- ============================================
CREATE TABLE IF NOT EXISTS strategy_instances (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    strategy_id INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'stopped' CHECK (status IN ('created', 'initializing', 'running', 'paused', 'stopped', 'failed', 'failed_permanent')),
    parameters JSONB DEFAULT '{}',
    worker_id VARCHAR(50),
    heartbeat_last TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, strategy_id)
);

CREATE INDEX idx_strategy_instances_client_id ON strategy_instances(client_id);
CREATE INDEX idx_strategy_instances_strategy_id ON strategy_instances(strategy_id);
CREATE INDEX idx_strategy_instances_status ON strategy_instances(status);
CREATE INDEX idx_strategy_instances_worker_id ON strategy_instances(worker_id);

-- ============================================
-- Table: signals
-- ============================================
CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(100) UNIQUE NOT NULL,
    strategy_instance_id INTEGER REFERENCES strategy_instances(id) ON DELETE SET NULL,
    symbol VARCHAR(50),
    instrument VARCHAR(100),
    action VARCHAR(10) NOT NULL CHECK (action IN ('BUY', 'SELL')),
    quantity INTEGER NOT NULL,
    price_type VARCHAR(20) DEFAULT 'MARKET' CHECK (price_type IN ('MARKET', 'LIMIT')),
    price NUMERIC(12, 2),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'rejected', 'cancelled')),
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX idx_signals_event_id ON signals(event_id);
CREATE INDEX idx_signals_strategy_instance_id ON signals(strategy_instance_id);
CREATE INDEX idx_signals_status ON signals(status);
CREATE INDEX idx_signals_timestamp ON signals(timestamp DESC);

-- ============================================
-- Table: orders
-- ============================================
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    strategy_instance_id INTEGER REFERENCES strategy_instances(id) ON DELETE SET NULL,
    signal_id INTEGER REFERENCES signals(id) ON DELETE SET NULL,
    event_id VARCHAR(100) NOT NULL,
    symbol VARCHAR(50),
    instrument VARCHAR(100),
    side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity INTEGER NOT NULL,
    price NUMERIC(12, 2),
    price_type VARCHAR(20) DEFAULT 'MARKET' CHECK (price_type IN ('MARKET', 'LIMIT')),
    status VARCHAR(30) DEFAULT 'created' CHECK (status IN ('created', 'validated', 'queued', 'sent_to_broker', 'acknowledged', 'partially_filled', 'filled', 'rejected', 'cancelled', 'failed')),
    broker_order_id VARCHAR(100),
    broker_name VARCHAR(50),
    filled_quantity INTEGER DEFAULT 0,
    average_fill_price NUMERIC(12, 2),
    rejection_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_client_id ON orders(client_id);
CREATE INDEX idx_orders_strategy_instance_id ON orders(strategy_instance_id);
CREATE INDEX idx_orders_signal_id ON orders(signal_id);
CREATE INDEX idx_orders_event_id ON orders(event_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_broker_order_id ON orders(broker_order_id);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

-- ============================================
-- Table: order_events
-- ============================================
CREATE TABLE IF NOT EXISTS order_events (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB DEFAULT '{}',
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_order_events_order_id ON order_events(order_id);
CREATE INDEX idx_order_events_event_type ON order_events(event_type);
CREATE INDEX idx_order_events_timestamp ON order_events(timestamp DESC);

-- ============================================
-- Table: trades
-- ============================================
CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    symbol VARCHAR(50),
    instrument VARCHAR(100),
    side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity INTEGER NOT NULL,
    price NUMERIC(12, 2) NOT NULL,
    broker_trade_id VARCHAR(100),
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trades_order_id ON trades(order_id);
CREATE INDEX idx_trades_client_id ON trades(client_id);
CREATE INDEX idx_trades_timestamp ON trades(timestamp DESC);

-- ============================================
-- Table: positions
-- ============================================
CREATE TABLE IF NOT EXISTS positions (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    strategy_instance_id INTEGER REFERENCES strategy_instances(id) ON DELETE SET NULL,
    symbol VARCHAR(50) NOT NULL,
    instrument VARCHAR(100) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    avg_entry_price NUMERIC(12, 2) DEFAULT 0,
    current_price NUMERIC(12, 2) DEFAULT 0,
    unrealized_pnl NUMERIC(12, 2) DEFAULT 0,
    realized_pnl NUMERIC(12, 2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(client_id, symbol, instrument, strategy_instance_id)
);

CREATE INDEX idx_positions_client_id ON positions(client_id);
CREATE INDEX idx_positions_strategy_instance_id ON positions(strategy_instance_id);
CREATE INDEX idx_positions_symbol ON positions(symbol);

-- ============================================
-- Table: portfolio_snapshots
-- ============================================
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    total_pnl NUMERIC(12, 2) DEFAULT 0,
    realized_pnl NUMERIC(12, 2) DEFAULT 0,
    unrealized_pnl NUMERIC(12, 2) DEFAULT 0,
    margin_used NUMERIC(12, 2) DEFAULT 0,
    margin_available NUMERIC(12, 2) DEFAULT 0,
    snapshot_time TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_portfolio_snapshots_client_id ON portfolio_snapshots(client_id);
CREATE INDEX idx_portfolio_snapshots_snapshot_time ON portfolio_snapshots(snapshot_time DESC);

-- ============================================
-- Table: system_logs
-- ============================================
CREATE TABLE IF NOT EXISTS system_logs (
    id SERIAL PRIMARY KEY,
    level VARCHAR(10) NOT NULL CHECK (level IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL')),
    service VARCHAR(50) NOT NULL,
    client_id INTEGER,
    strategy_id INTEGER,
    message TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_system_logs_timestamp ON system_logs(timestamp DESC);
CREATE INDEX idx_system_logs_level ON system_logs(level);
CREATE INDEX idx_system_logs_service ON system_logs(service);
CREATE INDEX idx_system_logs_client_id ON system_logs(client_id);

-- ============================================
-- Table: operator_audit_log
-- ============================================
CREATE TABLE IF NOT EXISTS operator_audit_log (
    id SERIAL PRIMARY KEY,
    operator_id INTEGER,
    operator_username VARCHAR(100),
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50),
    target_id INTEGER,
    metadata JSONB DEFAULT '{}',
    ip_address INET,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_operator_audit_log_operator_id ON operator_audit_log(operator_id);
CREATE INDEX idx_operator_audit_log_action ON operator_audit_log(action);
CREATE INDEX idx_operator_audit_log_timestamp ON operator_audit_log(timestamp DESC);

-- ============================================
-- Table: operators
-- ============================================
CREATE TABLE IF NOT EXISTS operators (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator', 'viewer')),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_operators_username ON operators(username);
CREATE INDEX idx_operators_role ON operators(role);

-- ============================================
-- Trigger: updated_at timestamp
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_strategies_updated_at BEFORE UPDATE ON strategies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_strategy_instances_updated_at BEFORE UPDATE ON strategy_instances FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_operators_updated_at BEFORE UPDATE ON operators FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Comments
-- ============================================
COMMENT ON TABLE clients IS 'Client accounts using the trading platform';
COMMENT ON TABLE accounts IS 'Broker credentials for each client';
COMMENT ON TABLE strategies IS 'Available trading strategies';
COMMENT ON TABLE strategy_instances IS 'Per-client strategy deployments';
COMMENT ON TABLE signals IS 'Trading signals generated by strategies';
COMMENT ON TABLE orders IS 'Orders created from signals';
COMMENT ON TABLE order_events IS 'Audit trail for order state changes';
COMMENT ON TABLE trades IS 'Executed trades';
COMMENT ON TABLE positions IS 'Current open positions per client';
COMMENT ON TABLE portfolio_snapshots IS 'Periodic portfolio state snapshots';
COMMENT ON TABLE system_logs IS 'System-wide logging';
COMMENT ON TABLE operator_audit_log IS 'Audit trail for operator actions';

-- Migration completed
SELECT 'Migration completed successfully' AS status;
