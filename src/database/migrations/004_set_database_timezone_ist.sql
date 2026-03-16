ALTER DATABASE algo_trading SET timezone TO 'Asia/Kolkata';
ALTER ROLE algo SET timezone TO 'Asia/Kolkata';

DO $$
BEGIN
  RAISE NOTICE 'Database and role timezone set to Asia/Kolkata';
END $$;
