import { getDb } from './db';

export type ApiOperation = 'whisper' | 'chat';

export interface ApiUsageEntry {
  id?: number;
  operation: ApiOperation;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  costUSD: number;
  createdAt: string;
}

// Preços oficiais da OpenAI (USD) — atualizar conforme mudarem
// Referência: https://openai.com/api/pricing/
export const PRICING = {
  'whisper-1': {
    perMinute: 0.006, // $0.006 por minuto de áudio
  },
  'gpt-4o-mini': {
    inputPer1M: 0.15, // $0.15 por 1M de input tokens
    outputPer1M: 0.6, // $0.60 por 1M de output tokens
  },
  'gpt-4o': {
    inputPer1M: 2.5, // $2.50 por 1M de input tokens
    outputPer1M: 10.0, // $10.00 por 1M de output tokens
  },
} as const;

export function calculateWhisperCost(audioSeconds: number): number {
  const minutes = audioSeconds / 60;
  return minutes * PRICING['whisper-1'].perMinute;
}

export function calculateChatCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = (PRICING as any)[model];
  if (!p) return 0;
  return (
    (inputTokens / 1_000_000) * p.inputPer1M +
    (outputTokens / 1_000_000) * p.outputPer1M
  );
}

export async function logApiUsage(
  entry: Omit<ApiUsageEntry, 'createdAt' | 'id'> & { createdAt?: string }
): Promise<void> {
  const db = await getDb();
  const createdAt = entry.createdAt ?? new Date().toISOString();
  await db.runAsync(
    `INSERT INTO api_usage (operation, model, input_tokens, output_tokens, audio_seconds, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.operation,
      entry.model,
      entry.inputTokens ?? null,
      entry.outputTokens ?? null,
      entry.audioSeconds ?? null,
      entry.costUSD,
      createdAt,
    ]
  );
}

export interface ApiUsageStats {
  totalUSD: number;
  totalCalls: number;
  byModel: { model: string; calls: number; costUSD: number }[];
  byOperation: { operation: string; calls: number; costUSD: number }[];
  last30Days: { date: string; costUSD: number }[];
  whisperTotalMinutes: number;
  chatTotalTokens: number;
}

export async function getApiUsageStats(): Promise<ApiUsageStats> {
  const db = await getDb();

  const totals = await db.getFirstAsync<{
    total: number | null;
    count: number | null;
  }>('SELECT SUM(cost_usd) as total, COUNT(*) as count FROM api_usage');

  const byModel = await db.getAllAsync<{
    model: string;
    calls: number;
    costUSD: number;
  }>(
    `SELECT model, COUNT(*) as calls, SUM(cost_usd) as costUSD
     FROM api_usage
     GROUP BY model
     ORDER BY costUSD DESC`
  );

  const byOperation = await db.getAllAsync<{
    operation: string;
    calls: number;
    costUSD: number;
  }>(
    `SELECT operation, COUNT(*) as calls, SUM(cost_usd) as costUSD
     FROM api_usage
     GROUP BY operation
     ORDER BY costUSD DESC`
  );

  const whisperAgg = await db.getFirstAsync<{ seconds: number | null }>(
    `SELECT SUM(audio_seconds) as seconds FROM api_usage WHERE operation = 'whisper'`
  );

  const chatAgg = await db.getFirstAsync<{
    input: number | null;
    output: number | null;
  }>(
    `SELECT SUM(input_tokens) as input, SUM(output_tokens) as output
     FROM api_usage WHERE operation = 'chat'`
  );

  // Últimos 30 dias agrupados por dia
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const rows = await db.getAllAsync<{ created_at: string; cost_usd: number }>(
    `SELECT created_at, cost_usd FROM api_usage WHERE created_at >= ?`,
    [since.toISOString()]
  );

  const dayMap = new Map<string, number>();
  for (const r of rows) {
    const day = r.created_at.split('T')[0]; // YYYY-MM-DD
    dayMap.set(day, (dayMap.get(day) ?? 0) + r.cost_usd);
  }

  const last30Days: { date: string; costUSD: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    last30Days.push({ date: key, costUSD: dayMap.get(key) ?? 0 });
  }

  const whisperSeconds = whisperAgg?.seconds ?? 0;

  return {
    totalUSD: totals?.total ?? 0,
    totalCalls: totals?.count ?? 0,
    byModel,
    byOperation,
    last30Days,
    whisperTotalMinutes: whisperSeconds / 60,
    chatTotalTokens: (chatAgg?.input ?? 0) + (chatAgg?.output ?? 0),
  };
}

export function formatUSD(value: number): string {
  if (value < 0.01) return '< $0.01';
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

// Conversão aproximada USD -> BRL (taxa indicativa, atualizar se quiser)
const BRL_RATE = 5.5;

export function formatBRL(usdValue: number): string {
  const brl = usdValue * BRL_RATE;
  if (brl < 0.01) return '< R$0,01';
  if (brl < 1) return `R$${brl.toFixed(4).replace('.', ',')}`;
  return `R$${brl.toFixed(2).replace('.', ',')}`;
}
