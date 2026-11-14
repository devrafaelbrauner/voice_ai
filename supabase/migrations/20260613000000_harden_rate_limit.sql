-- Harden the rate-limit helper functions introduced in
-- 20240524000001_create_rate_limits_table.sql.
--
-- Why:
--   * increment_rate_limit is SECURITY DEFINER. Without a pinned search_path a
--     caller can shadow referenced objects via their own schema and run code as
--     the function owner. We pin search_path = '' and schema-qualify everything.
--   * Functions are EXECUTE-able by PUBLIC by default, so any client (anon /
--     authenticated) could call the RPC and inflate or probe other users'
--     counters. Only the edge functions (service_role) may call them.
--   * cleanup_old_rate_limit_windows was never scheduled, so the table grew
--     unbounded. Schedule it hourly when pg_cron is available.
--
-- Idempotent: safe to re-run and to apply on top of 20240524000001.

CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_user_id      TEXT,
  p_operation    TEXT,
  p_window_start TIMESTAMP WITH TIME ZONE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.api_rate_limits AS rl (user_id, operation, window_start, count)
  VALUES (p_user_id, p_operation, p_window_start, 1)
  ON CONFLICT (user_id, operation, window_start)
  DO UPDATE SET count = rl.count + 1
  RETURNING rl.count INTO v_count;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_old_rate_limit_windows()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.api_rate_limits
  WHERE window_start < pg_catalog.now() - INTERVAL '2 hours';
END;
$$;

REVOKE ALL ON FUNCTION public.increment_rate_limit(TEXT, TEXT, TIMESTAMP WITH TIME ZONE)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_old_rate_limit_windows()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.increment_rate_limit(TEXT, TEXT, TIMESTAMP WITH TIME ZONE)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_rate_limit_windows()
  TO service_role;

-- Hourly cleanup via pg_cron, only if the extension is installed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule any existing job with this name so the migration is re-runnable.
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'cleanup_old_rate_limit_windows';

    PERFORM cron.schedule(
      'cleanup_old_rate_limit_windows',
      '0 * * * *',
      'SELECT public.cleanup_old_rate_limit_windows();'
    );
  END IF;
END;
$$;
