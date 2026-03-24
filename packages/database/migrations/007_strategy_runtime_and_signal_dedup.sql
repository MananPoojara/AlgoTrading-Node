-- Database Migration: Strategy Runtime State and Signal Dedup
-- Version: 1.7
-- Description: Adds signal fingerprinting and persisted runtime state for restart-safe strategy recovery

ALTER TABLE strategy_instances
  ADD COLUMN IF NOT EXISTS runtime_state JSONB DEFAULT '{}'::jsonb;

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS trigger_bar_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS signal_fingerprint VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_signals_trigger_bar_time
  ON signals(trigger_bar_time DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_signal_fingerprint_unique
  ON signals(signal_fingerprint)
  WHERE signal_fingerprint IS NOT NULL;

SELECT 'Strategy runtime state and signal dedup migration completed successfully' AS status;
