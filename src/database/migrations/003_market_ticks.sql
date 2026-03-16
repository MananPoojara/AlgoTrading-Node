-- Database Migration: Market Tick Persistence
-- Version: 1.2
-- Description: Adds market_ticks storage for live market data API and strategy validation

CREATE TABLE IF NOT EXISTS market_ticks (
  id BIGSERIAL PRIMARY KEY,
  instrument_token VARCHAR(50) NOT NULL,
  symbol VARCHAR(100) NOT NULL,
  exchange VARCHAR(20) DEFAULT 'NSE',
  ltp NUMERIC(16, 4) NOT NULL,
  open NUMERIC(16, 4) DEFAULT 0,
  high NUMERIC(16, 4) DEFAULT 0,
  low NUMERIC(16, 4) DEFAULT 0,
  close NUMERIC(16, 4) DEFAULT 0,
  volume BIGINT DEFAULT 0,
  bid NUMERIC(16, 4) DEFAULT 0,
  ask NUMERIC(16, 4) DEFAULT 0,
  bid_quantity BIGINT DEFAULT 0,
  ask_quantity BIGINT DEFAULT 0,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_ticks_token_timestamp
  ON market_ticks(instrument_token, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_market_ticks_symbol_timestamp
  ON market_ticks(symbol, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_market_ticks_timestamp
  ON market_ticks(timestamp DESC);

SELECT 'Market ticks migration completed successfully' AS status;
