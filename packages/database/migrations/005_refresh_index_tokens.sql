UPDATE instruments
SET
  is_active = FALSE,
  updated_at = NOW()
WHERE symbol = 'BANKNIFTY'
  AND instrument_token = '260001';

UPDATE instruments
SET
  instrument_token = '99926000',
  symbol = 'NIFTY 50',
  underlying_symbol = 'NIFTY',
  instrument_type = 'INDEX',
  exchange = 'NSE',
  is_active = TRUE,
  updated_at = NOW()
WHERE UPPER(symbol) IN ('NIFTY 50', 'NIFTY')
   OR UPPER(COALESCE(underlying_symbol, '')) = 'NIFTY';

UPDATE instruments
SET
  instrument_token = '99926009',
  symbol = 'BANKNIFTY',
  underlying_symbol = 'BANKNIFTY',
  instrument_type = 'INDEX',
  exchange = 'NSE',
  is_active = TRUE,
  updated_at = NOW()
WHERE (
    UPPER(symbol) IN ('BANKNIFTY', 'NIFTY BANK')
    AND instrument_token <> '260001'
  )
  OR (
    UPPER(COALESCE(underlying_symbol, '')) = 'BANKNIFTY'
    AND instrument_token <> '260001'
  );

DELETE FROM instruments
WHERE symbol = 'NIFTY BANK'
  AND instrument_token <> '99926009';

INSERT INTO instruments (
  exchange,
  symbol,
  instrument_token,
  instrument_type,
  underlying_symbol,
  lot_size,
  metadata
)
VALUES
  ('NSE', 'NIFTY 50', '99926000', 'INDEX', 'NIFTY', 1, '{"seeded": true, "source": "smartapi-index-token-refresh"}'),
  ('NSE', 'BANKNIFTY', '99926009', 'INDEX', 'BANKNIFTY', 1, '{"seeded": true, "source": "smartapi-index-token-refresh"}')
ON CONFLICT (instrument_token) DO UPDATE
SET
  exchange = EXCLUDED.exchange,
  symbol = EXCLUDED.symbol,
  instrument_type = EXCLUDED.instrument_type,
  underlying_symbol = EXCLUDED.underlying_symbol,
  lot_size = EXCLUDED.lot_size,
  metadata = EXCLUDED.metadata,
  is_active = TRUE,
  updated_at = NOW();

SELECT 'Index tokens refreshed to SmartAPI current values' AS status;
