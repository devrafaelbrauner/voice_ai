// Handler tests for the OpenAI proxy edge functions.
// Run: deno test --allow-env --allow-net supabase/functions/_shared/handlers_test.ts
//
// Deno.serve is stubbed to capture each function's handler at import time.
// Network is limited to the esm.sh module import; every runtime fetch
// (Supabase auth/rest, OpenAI) is answered by a stubbed globalThis.fetch.

type Handler = (req: Request) => Response | Promise<Response>;

const handlers = new Map<string, Handler>();

async function loadHandler(fn: 'openai-chat' | 'openai-transcribe'): Promise<Handler> {
  const cached = handlers.get(fn);
  if (cached) return cached;
  const realServe = Deno.serve;
  let captured: Handler | undefined;
  // Test stub replacing the real server; the shape differs from Deno.HttpServer.
  (Deno as unknown as { serve: unknown }).serve = (h: Handler) => {
    captured = h;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  try {
    // Dynamic import is required: Deno.serve must be stubbed BEFORE the module
    // body runs. Literal specifiers keep the imports statically analysable, so
    // no --allow-read is needed.
    if (fn === 'openai-chat') await import('../openai-chat/index.ts');
    else await import('../openai-transcribe/index.ts');
  } finally {
    Deno.serve = realServe;
  }
  if (!captured) throw new Error(`${fn} did not call Deno.serve`);
  handlers.set(fn, captured);
  return captured;
}

const ENV_KEYS = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const FULL_ENV: Record<string, string> = {
  OPENAI_API_KEY: 'sk-test',
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of ENV_KEYS) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const jsonResp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface StubOpts {
  authStatus?: number;
  rpcStatus?: number;
  /** When present (even null), the increment RPC answers 200 with this value. */
  rpcData?: unknown;
  hourStatus?: number;
  /** Makes any api.openai.com call throw this message (network failure). */
  openaiThrows?: string;
  /** Collects bytes the stubbed Whisper endpoint actually received. */
  audio?: { bytes: number };
  onOpenAI?: (body: Record<string, unknown>) => void;
}

async function withStubbedFetch(opts: StubOpts, fn: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === '/auth/v1/user') {
      return (opts.authStatus ?? 200) === 200
        ? jsonResp(200, { id: 'user-1234567890', aud: 'authenticated', email: 'a@b.c' })
        : jsonResp(opts.authStatus!, { message: 'invalid JWT' });
    }
    if (url.pathname === '/rest/v1/rpc/increment_rate_limit') {
      if ('rpcData' in opts) return jsonResp(200, opts.rpcData);
      return (opts.rpcStatus ?? 200) === 200
        ? jsonResp(200, 1)
        : jsonResp(opts.rpcStatus!, { message: 'rpc boom' });
    }
    if (url.pathname === '/rest/v1/api_rate_limits') {
      return (opts.hourStatus ?? 200) === 200
        ? jsonResp(200, [])
        : jsonResp(opts.hourStatus!, { message: 'select boom' });
    }
    if (url.host === 'api.openai.com') {
      if (opts.openaiThrows) throw new TypeError(opts.openaiThrows);
      if (url.pathname === '/v1/audio/transcriptions') {
        // Drain the forwarded body; a stream error (size cap) rejects like real fetch.
        if (req.body && opts.audio) {
          const reader = req.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            opts.audio.bytes += value.byteLength;
          }
        }
        return jsonResp(200, { text: 'hi' });
      }
      opts.onOpenAI?.(await req.json());
      return jsonResp(200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      });
    }
    throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// supabase-js may start auth timers; irrelevant to what is under test.
const opts = { sanitizeOps: false, sanitizeResources: false };

const chatReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://fn.test/openai-chat', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const messages = [{ role: 'user', content: 'hi' }];

function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── (a) missing OPENAI_API_KEY: formerly a ReferenceError on json() ────────────
for (const fn of ['openai-chat', 'openai-transcribe'] as const) {
  Deno.test({
    name: `${fn}: missing OPENAI_API_KEY -> JSON 500 with CORS`,
    ...opts,
    fn: async () => {
      const handler = await loadHandler(fn);
      await withEnv({}, async () => {
        const res = await handler(new Request('http://fn.test/', { method: 'POST' }));
        assertEq(res.status, 500, 'status');
        assertEq(res.headers.get('content-type'), 'application/json', 'content-type');
        assertEq(
          res.headers.get('access-control-allow-origin') !== null,
          true,
          'CORS header present',
        );
        const body = await res.json();
        assertEq(body.error, 'OPENAI_API_KEY not configured on server', 'error');
      });
    },
  });

  // ── (b) auth failure ────────────────────────────────────────────────────────
  Deno.test({
    name: `${fn}: invalid auth -> JSON 401`,
    ...opts,
    fn: async () => {
      const handler = await loadHandler(fn);
      await withEnv(FULL_ENV, () =>
        withStubbedFetch({ authStatus: 401 }, async () => {
          const res = await handler(chatReq({ model: 'gpt-4o-mini', messages }));
          assertEq(res.status, 401, 'status');
          assertEq((await res.json()).error, 'unauthenticated', 'error');
          assertEq(res.headers.get('access-control-allow-origin') !== null, true, 'CORS');
        }));
    },
  });

  // ── (d) rate limiter backend failure is fail-closed ─────────────────────────
  Deno.test({
    name: `${fn}: rate-limit RPC error -> 503 fail-closed`,
    ...opts,
    fn: async () => {
      const handler = await loadHandler(fn);
      await withEnv(FULL_ENV, () =>
        withStubbedFetch({ rpcStatus: 500 }, async () => {
          const res = await handler(chatReq({ model: 'gpt-4o-mini', messages }));
          assertEq(res.status, 503, 'status');
          assertEq(res.headers.get('retry-after'), '5', 'Retry-After');
          assertEq((await res.json()).error, 'Serviço temporariamente indisponível', 'error');
        }));
    },
  });
}

Deno.test({
  name: 'openai-transcribe: x-audio-bytes above cap -> 413',
  ...opts,
  fn: async () => {
    const handler = await loadHandler('openai-transcribe');
    await withEnv(FULL_ENV, () =>
      withStubbedFetch({}, async () => {
        const res = await handler(
          chatReq({}, {
            'content-type': 'multipart/form-data; boundary=x',
            'x-audio-bytes': String(26 * 1024 * 1024),
          }),
        );
        assertEq(res.status, 413, 'status');
      }));
  },
});

// ── (c) openai-chat upstream parameter shaping ─────────────────────────────────
async function chatUpstream(body: Record<string, unknown>) {
  const handler = await loadHandler('openai-chat');
  let upstream: Record<string, unknown> | undefined;
  let res: Response | undefined;
  await withEnv(FULL_ENV, () =>
    withStubbedFetch({ onOpenAI: (b) => (upstream = b) }, async () => {
      res = await handler(chatReq(body));
    }));
  return { res: res!, upstream };
}

Deno.test({
  name: 'openai-chat: gpt-5.4-mini uses max_completion_tokens, no temperature/max_tokens, cost 0',
  ...opts,
  fn: async () => {
    const { res, upstream } = await chatUpstream({
      model: 'gpt-5.4-mini',
      messages,
      temperature: 1,
      max_tokens: 10,
      max_completion_tokens: 800,
    });
    assertEq(res.status, 200, 'status');
    assertEq(upstream!.max_completion_tokens, 800, 'max_completion_tokens');
    assertEq('temperature' in upstream!, false, 'no temperature');
    assertEq('max_tokens' in upstream!, false, 'no max_tokens');
    const out = await res.json();
    assertEq(out.cost_usd, 0, 'unknown price -> cost 0');
    assertEq(out.content, 'ok', 'content');
  },
});

Deno.test({
  name: 'openai-chat: gpt-4o-mini uses max_tokens + temperature, priced',
  ...opts,
  fn: async () => {
    const { res, upstream } = await chatUpstream({ model: 'gpt-4o-mini', messages });
    assertEq(res.status, 200, 'status');
    assertEq(upstream!.max_tokens, 1500, 'default max_tokens');
    assertEq(upstream!.temperature, 0.3, 'default temperature');
    assertEq('max_completion_tokens' in upstream!, false, 'no max_completion_tokens');
    assertEq((await res.json()).cost_usd, 0.15 + 0.6, 'cost');
  },
});

Deno.test({
  name: 'openai-chat: max_tokens clamped to 4000 and temperature to [0,2]',
  ...opts,
  fn: async () => {
    const hi = await chatUpstream({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 99999,
      temperature: 50,
    });
    assertEq(hi.upstream!.max_tokens, 4000, 'max_tokens cap');
    assertEq(hi.upstream!.temperature, 2, 'temperature upper clamp');

    const lo = await chatUpstream({ model: 'gpt-4o-mini', messages, temperature: -3 });
    assertEq(lo.upstream!.temperature, 0, 'temperature lower clamp');

    const reasoning = await chatUpstream({
      model: 'gpt-5.4-mini',
      messages,
      max_completion_tokens: 99999,
    });
    assertEq(reasoning.upstream!.max_completion_tokens, 4000, 'reasoning cap');
  },
});

Deno.test({
  name: 'openai-chat: disallowed model -> JSON 400',
  ...opts,
  fn: async () => {
    const { res, upstream } = await chatUpstream({ model: 'gpt-3', messages });
    assertEq(res.status, 400, 'status');
    assertEq(upstream, undefined, 'no upstream call');
    assertEq((await res.json()).error, 'model not allowed: gpt-3', 'error');
  },
});

// ── Correction cycle 1 ─────────────────────────────────────────────────────────
const MB = 1024 * 1024;

// Lazily-pulled multipart-looking upload with NO content-length / x-audio-bytes.
function chunkedAudioReq(totalChunks: number, chunkBytes: number) {
  const chunk = new Uint8Array(chunkBytes);
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (state.pulled >= totalChunks) return ctrl.close();
      state.pulled++;
      ctrl.enqueue(chunk);
    },
  });
  const req = new Request('http://fn.test/openai-transcribe', {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'multipart/form-data; boundary=x' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { req, state };
}

Deno.test({
  name: 'openai-transcribe: chunked upload without length headers > cap -> 413, not fully consumed',
  ...opts,
  fn: async () => {
    const handler = await loadHandler('openai-transcribe');
    const { req, state } = chunkedAudioReq(40, MB); // 40 MB total
    const audio = { bytes: 0 };
    await withEnv(FULL_ENV, () =>
      withStubbedFetch({ audio }, async () => {
        assertEq(req.headers.get('content-length'), null, 'no content-length');
        const res = await handler(req);
        assertEq(res.status, 413, 'status');
        assertEq((await res.json()).error.startsWith('Audio file too large'), true, 'error');
        assertEq(audio.bytes <= 25 * MB, true, 'upstream saw at most the cap');
        assertEq(state.pulled < 40, true, 'source stream not drained');
      }));
  },
});

Deno.test({
  name: 'openai-transcribe: chunked upload within cap succeeds; cost from counted bytes',
  ...opts,
  fn: async () => {
    const handler = await loadHandler('openai-transcribe');
    const { req } = chunkedAudioReq(1, 32_000);
    const audio = { bytes: 0 };
    await withEnv(FULL_ENV, () =>
      withStubbedFetch({ audio }, async () => {
        const res = await handler(req);
        assertEq(res.status, 200, 'status');
        const out = await res.json();
        assertEq(audio.bytes, 32_000, 'forwarded bytes');
        assertEq(out.audio_seconds, 2, 'audio_seconds from counted bytes');
        assertEq(out.text, 'hi', 'text');
      }));
  },
});

Deno.test({
  name: 'openai-transcribe: content-length alone above cap -> 413 (CR-01)',
  ...opts,
  fn: async () => {
    const handler = await loadHandler('openai-transcribe');
    await withEnv(FULL_ENV, () =>
      withStubbedFetch({}, async () => {
        const req = new Request('http://fn.test/openai-transcribe', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer token',
            'Content-Type': 'multipart/form-data; boundary=x',
            'Content-Length': String(26 * MB),
          },
          body: 'tiny',
        });
        assertEq(req.headers.get('content-length'), String(26 * MB), 'header kept on Request');
        const res = await handler(req);
        assertEq(res.status, 413, 'status');
      }));
  },
});

for (const fn of ['openai-chat', 'openai-transcribe'] as const) {
  Deno.test({
    name: `${fn}: hourly-cap select error -> 503 fail-closed`,
    ...opts,
    fn: async () => {
      const handler = await loadHandler(fn);
      await withEnv(FULL_ENV, () =>
        withStubbedFetch({ hourStatus: 500 }, async () => {
          const res = await handler(chatReq({ model: 'gpt-4o-mini', messages }));
          assertEq(res.status, 503, 'status');
          assertEq(res.headers.get('retry-after'), '5', 'Retry-After');
        }));
    },
  });
}

Deno.test({
  name: 'openai-chat: RPC returning non-numeric data -> 503 fail-closed',
  ...opts,
  fn: async () => {
    const handler = await loadHandler('openai-chat');
    await withEnv(FULL_ENV, () =>
      withStubbedFetch({ rpcData: null }, async () => {
        const res = await handler(chatReq({ model: 'gpt-4o-mini', messages }));
        assertEq(res.status, 503, 'status');
      }));
  },
});

Deno.test({
  name: 'openai-chat: non-number max_tokens (null / "5" / false) -> default 1500',
  ...opts,
  fn: async () => {
    for (const bad of [null, '5', false]) {
      const { res, upstream } = await chatUpstream({ model: 'gpt-4o-mini', messages, max_tokens: bad });
      assertEq(res.status, 200, 'status');
      assertEq(upstream!.max_tokens, 1500, `max_tokens=${JSON.stringify(bad)}`);
    }
    const r = await chatUpstream({ model: 'gpt-5.4-mini', messages, max_completion_tokens: '5' });
    assertEq(r.upstream!.max_completion_tokens, 1500, 'reasoning string -> default');
  },
});

Deno.test({
  name: 'openai-chat: extra message keys are stripped before forwarding',
  ...opts,
  fn: async () => {
    const { upstream } = await chatUpstream({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi', name: 'x', extra: { a: 1 } }],
    });
    assertEq(JSON.stringify(upstream!.messages), JSON.stringify([{ role: 'user', content: 'hi' }]), 'messages');
  },
});

Deno.test({
  name: 'openai-chat: null message / null body -> JSON 400 with CORS',
  ...opts,
  fn: async () => {
    const nullMsg = await chatUpstream({ model: 'gpt-4o-mini', messages: [null] });
    assertEq(nullMsg.res.status, 400, 'null message status');
    assertEq(nullMsg.res.headers.get('access-control-allow-origin') !== null, true, 'CORS');
    assertEq(nullMsg.upstream, undefined, 'no upstream call');

    const nullBody = await chatUpstream(null as unknown as Record<string, unknown>);
    assertEq(nullBody.res.status, 400, 'null body status');
    assertEq(nullBody.res.headers.get('access-control-allow-origin') !== null, true, 'CORS');
  },
});

for (const fn of ['openai-chat', 'openai-transcribe'] as const) {
  Deno.test({
    name: `${fn}: upstream fetch failure -> generic 502 (no error leak)`,
    ...opts,
    fn: async () => {
      const handler = await loadHandler(fn);
      const realError = console.error;
      console.error = () => {};
      try {
        await withEnv(FULL_ENV, () =>
          withStubbedFetch({ openaiThrows: 'secret-internal-host:443 refused' }, async () => {
            const req = fn === 'openai-chat'
              ? chatReq({ model: 'gpt-4o-mini', messages })
              : chunkedAudioReq(1, 1000).req;
            const res = await handler(req);
            assertEq(res.status, 502, 'status');
            const text = await res.text();
            assertEq(text.includes('secret-internal-host'), false, 'no leak');
            assertEq(text.startsWith('{"error":"Erro no servi'), true, 'generic body');
          }));
      } finally {
        console.error = realError;
      }
    },
  });
}
