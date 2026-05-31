// Supabase Edge Function: proxies Chat Completions to OpenAI.
// See ../openai-transcribe/index.ts for the rationale.
//
// Deployment:
//   $ supabase functions deploy openai-chat
//   $ supabase secrets set OPENAI_API_KEY=sk-...

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { checkRateLimit, rateLimitHeaders } from '../_shared/rate-limit.ts';

// Pricing per 1M tokens (USD). Keep in sync with src/services/api_usage.ts.
const PRICING = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
} as Record<string, { input: number; output: number }>;

const ALLOWED_MODELS = new Set(Object.keys(PRICING));
const OPENAI_TIMEOUT_MS = 55_000; // 55s (edge functions have 60s limit)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiKey) {
    return json(500, { error: 'OPENAI_API_KEY not configured on server' });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) {
    return json(401, { error: 'unauthenticated' });
  }

  // ── Rate limit ──────────────────────────────────────────────
  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
  const rl = await checkRateLimit(serviceClient, userData.user.id, 'chat');
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: 'Limite de requisições atingido. Tente novamente em instantes.' }),
      {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          ...rateLimitHeaders(rl),
        },
      }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  const model = String(body.model ?? 'gpt-4o-mini');
  if (!ALLOWED_MODELS.has(model)) {
    return json(400, { error: `model not allowed: ${model}` });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(400, { error: 'messages must be a non-empty array' });
  }

  // ── OpenAI call with timeout ────────────────────────────────
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: body.messages,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
        max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 1500,
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      return json(504, { error: 'OpenAI request timed out. Try again.' });
    }
    return json(502, { error: `Upstream error: ${err?.message ?? String(err)}` });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return json(upstream.status, {
      error: `OpenAI ${upstream.status}: ${errText.slice(0, 500)}`,
    });
  }

  const result = await upstream.json();
  const content: string = result.choices?.[0]?.message?.content ?? '';
  const inputTokens: number = result.usage?.prompt_tokens ?? 0;
  const outputTokens: number = result.usage?.completion_tokens ?? 0;
  const pricing = PRICING[model];
  const costUSD =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  return new Response(
    JSON.stringify({
      content,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUSD,
    }),
    {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        ...rateLimitHeaders(rl),
      },
    }
  );
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
