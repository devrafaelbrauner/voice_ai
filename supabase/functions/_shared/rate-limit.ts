// Rate limiter usando tabela Supabase como backend.
// Estratégia: janela fixa por minuto (per-minute) + cap horário absoluto.
// A tabela `api_rate_limits` é criada pela migração
// 20240524000001_create_rate_limits_table.sql.
//
// Seg #3: dois níveis de proteção:
//   1. Janela por minuto (per-minute): limita burst momentâneo.
//   2. Cap horário absoluto (hourly): impede burst 2× na virada de janela
//      (um usuário pode acumular maxRequests no final de uma janela e
//       maxRequests no início da seguinte — o cap horário limita o total).

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

interface RateLimitConfig {
  /** Máximo de requisições na janela por minuto */
  maxRequests: number;
  /** Tamanho da janela em segundos */
  windowSeconds: number;
  /** Cap absoluto por hora (evita burst na virada de janela) */
  maxPerHour: number;
}

const DEFAULTS: Record<string, RateLimitConfig> = {
  chat:       { maxRequests: 20, windowSeconds: 60, maxPerHour: 60  },
  transcribe: { maxRequests: 10, windowSeconds: 60, maxPerHour: 30  },
};

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}

/**
 * Verifica e incrementa o contador de rate limit (por minuto + por hora).
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
  const config = DEFAULTS[operation] ?? { maxRequests: 10, windowSeconds: 60, maxPerHour: 30 };
  const now = new Date();

  // ── Janela por minuto ────────────────────────────────────────────────────────
  const windowStart = new Date(
    Math.floor(now.getTime() / (config.windowSeconds * 1000)) * config.windowSeconds * 1000
  );
  const windowEnd = new Date(windowStart.getTime() + config.windowSeconds * 1000);

  // ── Janela por hora (cap absoluto) ──────────────────────────────────────────
  const hourStart = new Date(
    Math.floor(now.getTime() / 3_600_000) * 3_600_000
  );
  const hourEnd = new Date(hourStart.getTime() + 3_600_000);

  try {
    // 1. Incrementa contador per-minute atomicamente
    const { data: newCount, error } = await client.rpc('increment_rate_limit', {
      p_user_id: userId,
      p_operation: operation,
      p_window_start: windowStart.toISOString(),
    });

    if (error) {
      // fail-open: melhor deixar passar do que bloquear usuários legítimos por falha de DB
      console.warn('[rate-limit] RPC error, fail-open:', error.message);
      return { allowed: true, remaining: config.maxRequests, resetAt: windowEnd.toISOString() };
    }

    const currentCount: number = typeof newCount === 'number' ? newCount : 1;

    // 2. Verificar cap horário: somar todos os contadores da hora atual
    const { data: hourRows, error: hourErr } = await client
      .from('api_rate_limits')
      .select('count')
      .eq('user_id', userId)
      .eq('operation', operation)
      .gte('window_start', hourStart.toISOString())
      .lt('window_start', hourEnd.toISOString());

    const hourTotal: number = hourErr
      ? currentCount // se falhar, usa apenas o count atual (conservador)
      : (hourRows ?? []).reduce((sum: number, row: { count: number }) => sum + (row.count ?? 0), 0);

    const withinMinute = currentCount <= config.maxRequests;
    const withinHour   = hourTotal   <= config.maxPerHour;
    const allowed = withinMinute && withinHour;

    const remaining = Math.max(
      0,
      Math.min(
        config.maxRequests - currentCount,
        config.maxPerHour  - hourTotal
      )
    );

    // Reset é o mais restritivo: fim da janela por minuto
    const resetAt = withinHour ? windowEnd.toISOString() : hourEnd.toISOString();

    console.log(
      `[rate-limit] ${operation} user=${userId.slice(0, 8)} ` +
      `min=${currentCount}/${config.maxRequests} ` +
      `hour=${hourTotal}/${config.maxPerHour} allowed=${allowed}`
    );

    return { allowed, remaining, resetAt };
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
