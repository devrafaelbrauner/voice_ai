// Supabase Edge Function: proxies Chat Completions to OpenAI.
// See ../openai-transcribe/index.ts for the rationale.
//
// Deployment:
//   $ supabase functions deploy openai-chat
//   $ supabase secrets set OPENAI_API_KEY=sk-...

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { buildCorsHeaders } from '../_shared/cors.ts';
import {
  checkRateLimit,
  rateLimitHeaders,
  rateLimitUnavailableResponse,
} from '../_shared/rate-limit.ts';

type Pricing = { input: number; output: number };

// Pricing per 1M tokens (USD). Keep in sync with src/services/api_usage.ts.
// 'gpt-5.4-mini' is allowed but its price is UNKNOWN to us: it has no entry here,
// so cost_usd is reported as 0 for it (do not invent a number; add it once confirmed).
const PRICING: Partial<Record<string, Pricing>> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
};

const ALLOWED_MODELS = new Set<string>([...Object.keys(PRICING), 'gpt-5.4-mini']);
// gpt-5*/o-series: max_completion_tokens, no temperature, no max_tokens.
const REASONING_MODEL_RE = /^gpt-5|^o[1-9]/;
const MAX_TOKENS_CAP = 4000;
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_TEMPERATURE = 0.3;
const OPENAI_TIMEOUT_MS = 55_000; // 55s (edge functions have 60s limit)

// Seg #2: limites de validação de payload
const MAX_MESSAGES = 20;
const MAX_CONTENT_CHARS = 60_000; // ~15k tokens — segurança contra payload enorme
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
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
    if (rl.unavailable) return rateLimitUnavailableResponse(corsHeaders);
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
  // R5: JSON `null`, arrays and primitives are not valid request bodies.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { error: 'invalid JSON body' });
  }

  const model = String(body.model ?? 'gpt-4o-mini');
  if (!ALLOWED_MODELS.has(model)) {
    return json(400, { error: `model not allowed: ${model}` });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(400, { error: 'messages must be a non-empty array' });
  }

  // Seg #2: validar estrutura e tamanho das mensagens
  if (body.messages.length > MAX_MESSAGES) {
    return json(400, { error: `Too many messages (max ${MAX_MESSAGES})` });
  }
  let totalChars = 0;
  // R6: rebuild each message as {role, content} only; extra keys are never forwarded.
  const sanitizedMessages: { role: string; content: string }[] = [];
  for (const msg of body.messages) {
    if (msg === null || typeof msg !== 'object') {
      return json(400, { error: 'Each message must be an object' });
    }
    if (!ALLOWED_ROLES.has(msg.role)) {
      return json(400, { error: `Invalid message role: ${msg.role}` });
    }
    if (typeof msg.content !== 'string') {
      return json(400, { error: 'Each message must have a string content field' });
    }
    totalChars += msg.content.length;
    if (totalChars > MAX_CONTENT_CHARS) {
      return json(400, { error: 'Total message content exceeds size limit' });
    }
    sanitizedMessages.push({ role: msg.role, content: msg.content });
  }

  // ── Upstream params (B2 / AS-02) ────────────────────────────
  // Reasoning models (gpt-5*, o-series) require max_completion_tokens and
  // reject temperature/max_tokens; other models take max_tokens + temperature.
  // Only a finite positive number is honoured; anything else (null, "5", false…) -> default.
  const rawMax = body.max_completion_tokens ?? body.max_tokens;
  const maxTokens =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(MAX_TOKENS_CAP, Math.max(1, Math.floor(rawMax)))
      : DEFAULT_MAX_TOKENS;
  const upstreamBody: Record<string, unknown> = { model, messages: sanitizedMessages };
  if (REASONING_MODEL_RE.test(model)) {
    upstreamBody.max_completion_tokens = maxTokens;
  } else {
    upstreamBody.max_tokens = maxTokens;
    upstreamBody.temperature =
      typeof body.temperature === 'number' && Number.isFinite(body.temperature)
        ? Math.min(2, Math.max(0, body.temperature))
        : DEFAULT_TEMPERATURE;
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
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      return json(504, { error: 'OpenAI request timed out. Try again.' });
    }
    // AS-10: log the real error server-side only; keep the client body generic.
    console.error('[openai-chat] upstream fetch failed:', err);
    return json(502, { error: 'Erro no serviço de IA. Tente novamente em instantes.' });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    // Seg #2: logar internamente mas não expor detalhes do upstream ao cliente
    console.error(`[openai-chat] upstream error ${upstream.status}: ${errText.slice(0, 500)}`);
    const clientStatus = upstream.status === 429 ? 429 : 502;
    return json(clientStatus, {
      error: upstream.status === 429
        ? 'Limite de requisições OpenAI atingido. Tente novamente em instantes.'
        : 'Erro no serviço de IA. Tente novamente em instantes.',
    });
  }

  const result = await upstream.json();
  const content: string = result.choices?.[0]?.message?.content ?? '';
  const inputTokens: number = result.usage?.prompt_tokens ?? 0;
  const outputTokens: number = result.usage?.completion_tokens ?? 0;
  // Unknown price => cost_usd 0 (never throws, never invents a price).
  const pricing = PRICING[model];
  const costUSD = pricing
    ? (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output
    : 0;

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
