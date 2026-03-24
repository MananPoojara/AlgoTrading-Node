-- Database Migration: Market Scheduler and Tick Retention
-- Version: 1.6
-- Description: Adds scheduler state, 1-minute OHLC retention, and archive metadata tables

ALTER TABLE strategy_instances
  ADD COLUMN IF NOT EXISTS auto_managed BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS scheduler_paused BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_strategy_instances_auto_managed
  ON strategy_instances(auto_managed);

CREATE INDEX IF NOT EXISTS idx_strategy_instances_scheduler_paused
  ON strategy_instances(scheduler_paused);

CREATE TABLE IF NOT EXISTS market_ohlc_1m (
  id BIGSERIAL PRIMARY KEY,
  instrument_token VARCHAR(50) NOT NULL,
  symbol VARCHAR(100) NOT NULL,
  exchange VARCHAR(20) DEFAULT 'NSE',
  trading_day DATE NOT NULL,
  candle_time TIMESTAMPTZ NOT NULL,
  open NUMERIC(16, 4) NOT NULL,
  high NUMERIC(16, 4) NOT NULL,
  low NUMERIC(16, 4) NOT NULL,
  close NUMERIC(16, 4) NOT NULL,
  volume BIGINT DEFAULT 0,
  ticks_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (instrument_token, candle_time)
);

CREATE INDEX IF NOT EXISTS idx_market_ohlc_1m_symbol_time
  ON market_ohlc_1m(symbol, candle_time DESC);

CREATE INDEX IF NOT EXISTS idx_market_ohlc_1m_day
  ON market_ohlc_1m(trading_day, symbol);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_market_ohlc_1m_updated_at'
  ) THEN
    CREATE TRIGGER update_market_ohlc_1m_updated_at
    BEFORE UPDATE ON market_ohlc_1m
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS market_tick_archives (
  id BIGSERIAL PRIMARY KEY,
  trading_day DATE NOT NULL,
  instrument_token VARCHAR(50) NOT NULL,
  symbol VARCHAR(100) NOT NULL,
  archive_path TEXT NOT NULL,
  row_count BIGINT DEFAULT 0,
  candle_count INTEGER DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (trading_day, instrument_token)
);

CREATE INDEX IF NOT EXISTS idx_market_tick_archives_day
  ON market_tick_archives(trading_day DESC, symbol);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_market_tick_archives_updated_at'
  ) THEN
    CREATE TRIGGER update_market_tick_archives_updated_at
    BEFORE UPDATE ON market_tick_archives
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS scheduler_state (
  state_key VARCHAR(100) PRIMARY KEY,
  state_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_scheduler_state_updated_at'
  ) THEN
    CREATE TRIGGER update_scheduler_state_updated_at
    BEFORE UPDATE ON scheduler_state
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

SELECT 'Market scheduler and retention migration completed successfully' AS status;
