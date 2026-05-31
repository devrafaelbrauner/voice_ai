// Rate limiter usando tabela Supabase como backend.
// Estratégia: sliding window por (user_id, operation).
// A tabela `api_rate_limits` é criada pela migração
// 20240524000001_create_rate_limits_table.sql.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

interface RateLimitConfig {
  /** Máximo de requisições na janela */
  maxRequests: number;
  /** Tamanho da janela em segundos */
  windowSeconds: number;
}

const DEFAULTS: Record<string, RateLimitConfig> = {
  chat: { maxRequests: 20, windowSeconds: 60 },       // 20 reqs/min
  transcribe: { maxRequests: 10, windowSeconds: 60 }, // 10 reqs/min
};

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}

/**
 * Verifica e incrementa o contador de rate limit.
 *
 * Usa uma tabela com colunas:
 *   user_id TEXT, operation TEXT, window_start TIMESTAMP, count INT
 * PRIMARY KEY (user_id, operation, window_start)
 */
export async function checkRateLimit(
  client: SupabaseClient,
  userId: string,
  operation: 'chat' | 'transcribe'
): Promise<RateLimitResult> {
  const config = DEFAULTS[operation] ?? { maxRequests: 10, windowSeconds: 60 };
  const now = new Date();

  // Início da janela atual (arredonda para baixo)
  const windowStart = new Date(
    Math.floor(now.getTime() / (config.windowSeconds * 1000)) * config.windowSeconds * 1000
  );
  const windowEnd = new Date(windowStart.getTime() + config.windowSeconds * 1000);

  try {
    // RPC `increment_rate_limit` já faz upsert+increment atomicamente:
    //   INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count
    // Definida na migração 20240524000001_create_rate_limits_table.sql
    const { data: newCount, error } = await client.rpc('increment_rate_limit', {
      p_user_id: userId,
      p_operation: operation,
      p_window_start: windowStart.toISOString(),
    });

    if (error) {
      // fail-open: melhor deixar passar do que bloquear usuários legítimos
      console.warn('[rate-limit] RPC error, fail-open:', error.message);
      return { allowed: true, remaining: config.maxRequests, resetAt: windowEnd.toISOString() };
    }

    const currentCount: number = typeof newCount === 'number' ? newCount : 1;
    const remaining = Math.max(0, config.maxRequests - currentCount);
    const allowed = currentCount <= config.maxRequests;

    console.log(`[rate-limit] ${operation} user=${userId.slice(0, 8)} count=${currentCount}/${config.maxRequests} allowed=${allowed}`);

    return {
      allowed,
      remaining,
      resetAt: windowEnd.toISOString(),
    };
  } catch (err) {
    // fail-open
    console.warn('[rate-limit] unexpected error, fail-open:', err);
    return { allowed: true, remaining: config.maxRequests, resetAt: windowEnd.toISOString() };
  }
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': result.resetAt,
  };
}
