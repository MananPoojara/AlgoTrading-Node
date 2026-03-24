-- Database Migration: Phase 1 Paper OMS Foundation
-- Version: 1.1
-- Description: Aligns schema with paper OMS, auth, portfolio snapshots, and instrument metadata

-- ============================================
-- clients compatibility
-- ============================================
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'operator' CHECK (role IN ('admin', 'operator', 'viewer'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email_unique
  ON clients(email)
  WHERE email IS NOT NULL;

-- ============================================
-- auth tables expected by API
-- ============================================
CREATE TABLE IF NOT EXISTS oauth_states (
  state VARCHAR(128) PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_client_id ON api_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_status ON api_tokens(status);
CREATE INDEX IF NOT EXISTS idx_api_tokens_expires_at ON api_tokens(expires_at);

-- ============================================
-- instruments metadata for signal/OMS lookup
-- ============================================
CREATE TABLE IF NOT EXISTS instruments (
  id SERIAL PRIMARY KEY,
  exchange VARCHAR(20) NOT NULL,
  symbol VARCHAR(100) NOT NULL,
  instrument_token VARCHAR(50) NOT NULL UNIQUE,
  instrument_type VARCHAR(50),
  underlying_symbol VARCHAR(100),
  expiry_date DATE,
  strike NUMERIC(12, 2),
  option_type VARCHAR(10),
  tick_size NUMERIC(12, 4),
  lot_size INTEGER,
  is_active BOOLEAN DEFAULT TRUE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instruments_symbol ON instruments(symbol);
CREATE INDEX IF NOT EXISTS idx_instruments_underlying_symbol ON instruments(underlying_symbol);
CREATE INDEX IF NOT EXISTS idx_instruments_is_active ON instruments(is_active);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_instruments_updated_at'
  ) THEN
    CREATE TRIGGER update_instruments_updated_at
    BEFORE UPDATE ON instruments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================
-- signal contract alignment
-- ============================================
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS strategy_id INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_signals_client_id ON signals(client_id);
CREATE INDEX IF NOT EXISTS idx_signals_strategy_id ON signals(strategy_id);

-- ============================================
-- order contract alignment
-- ============================================
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) DEFAULT 'paper' CHECK (execution_mode IN ('paper', 'live')),
  ADD COLUMN IF NOT EXISTS average_price NUMERIC(12, 2);

UPDATE orders
SET average_price = COALESCE(average_price, average_fill_price)
WHERE average_price IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_execution_mode ON orders(execution_mode);

-- ============================================
-- trades contract alignment
-- ============================================
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS strategy_instance_id INTEGER REFERENCES strategy_instances(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS signal_id INTEGER REFERENCES signals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) DEFAULT 'paper' CHECK (execution_mode IN ('paper', 'live'));

CREATE INDEX IF NOT EXISTS idx_trades_strategy_instance_id ON trades(strategy_instance_id);
CREATE INDEX IF NOT EXISTS idx_trades_signal_id ON trades(signal_id);

-- ============================================
-- positions compatibility for current runtime
-- ============================================
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS position INTEGER,
  ADD COLUMN IF NOT EXISTS average_price NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE positions
SET position = COALESCE(position, quantity, 0)
WHERE position IS NULL;

UPDATE positions
SET average_price = COALESCE(average_price, avg_entry_price, 0)
WHERE average_price IS NULL;

ALTER TABLE positions
  ALTER COLUMN position SET DEFAULT 0,
  ALTER COLUMN average_price SET DEFAULT 0;

-- ============================================
-- portfolio snapshot compatibility for current runtime
-- ============================================
ALTER TABLE portfolio_snapshots
  ADD COLUMN IF NOT EXISTS positions_snapshot JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE portfolio_snapshots
SET created_at = COALESCE(created_at, snapshot_time)
WHERE created_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_created_at ON portfolio_snapshots(created_at DESC);

-- ============================================
-- seed minimal instrument metadata if missing
-- ============================================
INSERT INTO instruments (exchange, symbol, instrument_token, instrument_type, underlying_symbol, lot_size, metadata)
VALUES
  ('NSE', 'NIFTY 50', '99926000', 'INDEX', 'NIFTY', 1, '{"seeded": true}'),
  ('NSE', 'BANKNIFTY', '99926009', 'INDEX', 'BANKNIFTY', 1, '{"seeded": true}')
ON CONFLICT (instrument_token) DO NOTHING;

SELECT 'Phase 1 paper OMS foundation migration completed successfully' AS status;
