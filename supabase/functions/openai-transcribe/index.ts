// Supabase Edge Function: proxies Whisper transcription to OpenAI.
//
// Why this exists:
//   Keeping the OpenAI key on the client (mobile device) means anyone with
//   access to the unlocked phone, or who reverse-engineers the APK, can extract
//   it. This proxy keeps the key server-side; the client authenticates via the
//   Supabase JWT it already has after login.
//
// Auth model:
//   Supabase auto-validates the JWT in `Authorization: Bearer ...` because
//   verify_jwt=true is the default (see config.toml). Unauthenticated requests
//   get rejected with 401 before this code runs.
//
// Deployment:
//   $ supabase functions deploy openai-transcribe
//   $ supabase secrets set OPENAI_API_KEY=sk-...

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { checkRateLimit, rateLimitHeaders } from '../_shared/rate-limit.ts';

// Pricing — keep in sync with src/services/api_usage.ts on the client.
const WHISPER_USD_PER_MINUTE = 0.006;
const OPENAI_TIMEOUT_MS = 115_000; // 115s — áudio pode ser grande; edge tem 120s

// Seg #2: Whisper aceita até 25 MB; rejeitamos antes de chegar na OpenAI
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB

Deno.serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiKey) {
    return json(500, { error: 'OPENAI_API_KEY not configured on server' });
  }

  // Confirm the caller is a logged-in Supabase user. Even though verify_jwt
  // already gates the function, doing it explicitly lets us log who called.
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
  const rl = await checkRateLimit(serviceClient, userData.user.id, 'transcribe');
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: 'Limite de transcrições atingido. Tente novamente em instantes.' }),
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

  // Seg #2: validar tamanho do arquivo antes de repassar à OpenAI
  const audioBytes = Number(req.headers.get('x-audio-bytes') ?? 0);
  if (audioBytes > MAX_AUDIO_BYTES) {
    return json(413, { error: `Audio file too large (max ${MAX_AUDIO_BYTES / 1024 / 1024} MB)` });
  }

  // Forward the multipart body straight to Whisper. We don't parse it — that
  // would force-load the entire audio file into memory.
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    return json(400, { error: 'expected multipart/form-data' });
  }

  // ── OpenAI call with timeout ────────────────────────────────
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          'Content-Type': contentType,
        },
        body: req.body,
        // @ts-ignore — Deno-specific, required when streaming a body through.
        duplex: 'half',
        signal: controller.signal,
      }
    );
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      return json(504, { error: 'OpenAI transcription timed out. Try again.' });
    }
    return json(502, { error: `Upstream error: ${err?.message ?? String(err)}` });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    // Seg #2: logar internamente mas não expor detalhes do upstream ao cliente
    console.error(`[openai-transcribe] upstream error ${upstream.status}: ${errText.slice(0, 500)}`);
    const clientStatus = upstream.status === 429 ? 429 : 502;
    return json(clientStatus, {
      error: upstream.status === 429
        ? 'Limite de transcrições OpenAI atingido. Tente novamente em instantes.'
        : 'Erro no serviço de transcrição. Tente novamente em instantes.',
    });
  }

  const result = await upstream.json();

  // Best-effort cost estimate. Whisper response doesn't include duration in
  // the default json format, so we approximate from the file size header.
  const contentLength = Number(req.headers.get('x-audio-bytes') ?? 0);
  const audioSeconds = contentLength > 0 ? Math.max(1, contentLength / 16000) : 0;
  const costUSD = (audioSeconds / 60) * WHISPER_USD_PER_MINUTE;

  return new Response(
    JSON.stringify({
      text: result.text,
      audio_seconds: audioSeconds,
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
