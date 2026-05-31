-- Rate limiting table for OpenAI API calls.
-- Each row = one time window for a (user, operation) pair.
-- Cleanup of old windows handled by background job or TTL policy.

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  user_id     TEXT        NOT NULL,
  operation   TEXT        NOT NULL CHECK (operation IN ('chat', 'transcribe')),
  window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  count       INTEGER     NOT NULL DEFAULT 1,

  PRIMARY KEY (user_id, operation, window_start)
);

-- Auto-purge windows older than 1 hour (kept short to save space)
CREATE INDEX idx_rate_limits_window ON public.api_rate_limits(window_start);

-- RLS: service role only (edge functions use service role to write)
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE for regular users — only service role can touch this
CREATE POLICY "service role only"
  ON public.api_rate_limits
  USING (false);  -- blocks all client access

-- Atomic increment function called by the rate limiter
CREATE OR REPLACE FUNCTION increment_rate_limit(
  p_user_id      TEXT,
  p_operation    TEXT,
  p_window_start TIMESTAMP WITH TIME ZONE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER   -- runs as table owner, bypasses RLS
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.api_rate_limits (user_id, operation, window_start, count)
  VALUES (p_user_id, p_operation, p_window_start, 1)
  ON CONFLICT (user_id, operation, window_start)
  DO UPDATE SET count = api_rate_limits.count + 1
  RETURNING count INTO v_count;

  RETURN v_count;
END;
$$;

-- Scheduled cleanup: delete windows older than 2 hours
-- (Run manually or via pg_cron if available)
CREATE OR REPLACE FUNCTION cleanup_old_rate_limit_windows()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.api_rate_limits
  WHERE window_start < NOW() - INTERVAL '2 hours';
END;
$$;
