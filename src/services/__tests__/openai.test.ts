// Motor de transcrição (openai.ts) com fetch mockado. Relógio falso e sono/aleatório injetados
// via engineEnv: nenhum teste espera tempo real nem toca a rede.
import { fetch as expoFetch } from 'expo/fetch';
import {
  AVAILABLE_TRANSCRIPTION_MODELS,
  TranscriptionError,
  backoffDelayMs,
  checkTranscriptSanity,
  classifyHttpError,
  engineEnv,
  parseRetryAfter,
  setApiKey,
  setForceDirect,
  setOpenRouterApiKey,
  setTranscriptionModel,
  stepTimeoutMs,
  transcribeAudio,
  transcribeWithChain,
  transcriptionChainFor,
  type TranscriptionModelId,
} from '../openai';
import { WHISPER_MEDICAL_PROMPT } from '../openai-shared';
import { isProxyAvailable } from '../openai-proxy';
import { supabase } from '../supabase';

jest.mock('expo/fetch', () => ({ __esModule: true, fetch: jest.fn() }));
jest.mock('../api_usage', () => ({
  __esModule: true,
  logApiUsage: jest.fn(async () => undefined),
  calculateWhisperCost: () => 0,
  calculateChatCost: () => 0,
}));
jest.mock('../openai-proxy', () => ({
  __esModule: true,
  isProxyAvailable: jest.fn(async () => false),
  chatViaProxy: jest.fn(),
}));
jest.mock('../db', () => ({
  __esModule: true,
  getField: jest.fn(),
  setField: jest.fn(),
  clearField: jest.fn(),
  getCustomTemplates: jest.fn(),
}));

const fetchMock = expoFetch as unknown as jest.Mock;
const AUDIO = 'file:///doc/recording_1.m4a';
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const OPENAI_KEY = 'sk-test-OPENAI-KEY-1234567890';
const OPENROUTER_KEY = 'or-key-OPENROUTER-0987654321';
const GOOD_TEXT = 'Paciente refere dor torácica há dois dias, nega febre e dispneia.';
const originalEnv = { ...engineEnv };

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  };
}
const ok = (text: string) => res(200, { text });

/** Resposta escrita no fetch na ordem das chamadas; uma chamada além do script falha o teste. */
function script(...responses: unknown[]) {
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
}

const calls = () =>
  fetchMock.mock.calls.map(([url, init]: [string, RequestInit & { body: FormData; headers: Record<string, string> }]) => ({
    url,
    model: String(init.body.get('model')),
    auth: init.headers.Authorization,
  }));

declare global {
  var __fakeFs: Map<string, string | { size: number }>;
}

let sleeps: number[];
let getSessionSpy: jest.SpyInstance;
const originalSupabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;

beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2025-06-01T12:00:00.000Z'));
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error('fetch não roteirizado neste teste');
  });
  sleeps = [];
  engineEnv.random = () => 0.5;
  engineEnv.sleep = async (ms: number) => {
    sleeps.push(ms);
    jest.setSystemTime(Date.now() + ms);
  };
  (isProxyAvailable as jest.Mock).mockResolvedValue(false);
  // Padrão: sem sessão e sem URL. Cada teste de proxy declara o que precisa (nada depende de ordem).
  getSessionSpy = jest.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session: null }, error: null } as never);
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  await setForceDirect(false);
  await setApiKey(OPENAI_KEY);
  await setOpenRouterApiKey(OPENROUTER_KEY);
  await setTranscriptionModel('whisper-1');
  globalThis.__fakeFs.set(AUDIO, { size: 40_000 });
});

afterEach(() => {
  Object.assign(engineEnv, originalEnv);
  getSessionSpy.mockRestore();
  if (originalSupabaseUrl === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  else process.env.EXPO_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
  jest.useRealTimers();
});

const thrown = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as TranscriptionError);

describe('classificação de erros HTTP', () => {
  const SECRET_BODY = JSON.stringify({
    error: {
      message: 'Incorrect API key provided: sk-proj-SECRET123abc. Authorization: Bearer sk-proj-SECRET123abc',
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  });

  test.each([
    [401, 'invalid_key', false],
    [403, 'forbidden', false],
    [402, 'quota', false],
    [408, 'timeout', true],
    [429, 'rate_limit', true],
    [500, 'server', true],
    [502, 'server', true],
    [503, 'server', true],
    [599, 'server', true],
    [400, 'bad_response', false],
    [404, 'bad_response', false],
    [413, 'bad_response', false],
  ])('HTTP %i → %s (transitório=%s)', (status, kind, transient) => {
    const err = classifyHttpError(status);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect({ kind: err.kind, transient: err.transient, status: err.status }).toEqual({ kind, transient, status });
  });

  test.each([
    ['code', { error: { code: 'insufficient_quota', message: 'x' } }],
    ['type', { error: { type: 'insufficient_quota', message: 'x' } }],
    ['mensagem da OpenAI', { error: { message: 'You exceeded your current quota, please check your plan and billing details.' } }],
    ['mensagem do OpenRouter', { error: { message: 'Insufficient credits. Add more using https://openrouter.ai/credits' } }],
    ['sem crédito', { error: { message: 'Your account is out of credits' } }],
  ])('429 com cota esgotada (%s) é "quota", não rate_limit: esperar não resolve', (_how, body) => {
    const err = classifyHttpError(429, '30', JSON.stringify(body));
    expect(err.kind).toBe('quota');
    expect(err.transient).toBe(false);
    expect(err.retryAfterMs).toBeUndefined();
  });

  test('429 comum de taxa continua rate_limit transitório', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached for gpt-4o in organization org-x on requests per min.', code: 'rate_limit_exceeded' } });
    const err = classifyHttpError(429, '7', body);
    expect(err).toMatchObject({ kind: 'rate_limit', transient: true, retryAfterMs: 7000 });
  });

  test('Retry-After em segundos, em data HTTP, ausente, inválido, passado e absurdo', () => {
    const now = Date.parse('2025-06-01T12:00:00.000Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(' 5 ', now)).toBe(5_000);
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(parseRetryAfter(new Date(now - 90_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter('99999999', now)).toBe(3_600_000); // teto de 1 h
    expect(parseRetryAfter(new Date(now + 10 * 3_600_000).toUTCString(), now)).toBe(3_600_000);
    for (const bad of [undefined, null, '', 'logo', '12abc']) expect(parseRetryAfter(bad, now)).toBeUndefined();
    // Via classificador: data HTTP no relógio (falso) de agora.
    const date = new Date(Date.now() + 45_000).toUTCString();
    expect(classifyHttpError(429, date).retryAfterMs).toBe(45_000);
    expect(classifyHttpError(503, '3').retryAfterMs).toBe(3_000);
  });

  // Date.parse('1.5') e Date.parse('-5') "funcionam" no V8 e viravam datas de 2001 → espera de 0 ms.
  test.each(['1.5', '-5'])('Retry-After não padrão (%s) é ignorado, não vira espera de 0 ms', (value) => {
    expect(parseRetryAfter(value, Date.parse('2025-06-01T12:00:00.000Z'))).toBeUndefined();
  });

  test('Retry-After: "0" vale 0 ms e data HTTP futura vale a diferença', () => {
    const now = Date.parse('2025-06-01T12:00:00.000Z');
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('Sun, 01 Jun 2025 12:00:30 GMT', now)).toBe(30_000);
  });

  test.each([400, 401, 403, 429, 500, 503])('HTTP %i: corpo do provedor com chave/Bearer nunca vaza para a mensagem', (status) => {
    const err = classifyHttpError(status, null, SECRET_BODY);
    expect(`${err.message} ${err.code ?? ''} ${JSON.stringify(err)} ${err.stack}`).not.toMatch(/sk-|bearer|SECRET123/i);
  });

  test('400 mostra detalhe curto do provedor quando é seguro, e identifica áudio curto', () => {
    expect(classifyHttpError(400, null, JSON.stringify({ error: { message: 'Unsupported file format' } })).message).toContain(
      'Unsupported file format'
    );
    expect(classifyHttpError(400, null, JSON.stringify({ error: { message: 'Audio file is too short' } }))).toMatchObject({
      kind: 'bad_response',
      code: 'audio_too_short',
    });
  });
});

describe('backoff exponencial com jitter limitado', () => {
  test('sempre entre metade e o valor cheio do degrau, nunca acima de 8 s, mesmo com aleatório fora de [0,1]', () => {
    let previous = 0;
    for (let attempt = -3; attempt <= 40; attempt++) {
      const exp = Math.min(500 * 2 ** Math.min(Math.max(attempt, 0), 16), 8000);
      for (const random of [-1, 0, 0.25, 0.5, 1, 7]) {
        const d = backoffDelayMs(attempt, random);
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(Math.floor(exp / 2));
        expect(d).toBeLessThanOrEqual(exp);
        expect(d).toBeLessThanOrEqual(8000);
      }
      const mid = backoffDelayMs(attempt, 0.5);
      expect(mid).toBeGreaterThanOrEqual(previous); // não encolhe com as tentativas
      previous = mid;
    }
    expect(backoffDelayMs(0, 0)).toBe(250);
    expect(backoffDelayMs(0, 1)).toBe(500);
    expect(backoffDelayMs(30, 1)).toBe(8000);
  });
});

describe('retry dentro da cadeia', () => {
  test('503 transitório é repetido com backoff e a transcrição final chega ao usuário', async () => {
    script(res(503, 'Service Unavailable'), ok(GOOD_TEXT));
    await expect(transcribeWithChain(AUDIO, 'whisper-1')).resolves.toBe(GOOD_TEXT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([375]); // 500 ms, random 0.5 → 250 + 125
  });

  test('429 respeita Retry-After do servidor (em vez do backoff)', async () => {
    script(res(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '2' }), ok(GOOD_TEXT));
    await expect(transcribeWithChain(AUDIO, 'whisper-1')).resolves.toBe(GOOD_TEXT);
    expect(sleeps).toEqual([2000]);
  });

  test('429 com Retry-After de 1 h não cabe no orçamento do passo: devolve o erro na hora, sem dormir', async () => {
    script(res(429, 'slow down', { 'retry-after': '3600' }));
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1'));
    expect(err).toMatchObject({ kind: 'rate_limit', transient: true, retryAfterMs: 3_600_000 });
    expect(sleeps).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('transitório persistente: 1 tentativa + 3 repetições (backoff crescente) e então o erro', async () => {
    script(res(503, 'x'), res(503, 'x'), res(503, 'x'), res(503, 'x'));
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1'));
    expect(err).toMatchObject({ kind: 'server', transient: true, status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([375, 750, 1500]);
  });

  test.each([
    [400, 'bad_response'],
    [401, 'invalid_key'],
    [403, 'forbidden'],
    [402, 'quota'],
  ])('HTTP %i é permanente: UMA chamada, sem retry e sem fallback', async (status, kind) => {
    script(res(status, { error: { message: 'x' } }));
    const err = await thrown(transcribeWithChain(AUDIO, 'openai/gpt-4o-transcribe'));
    expect(err?.kind).toBe(kind);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  test('falha de rede (fetch rejeita): repete 3 vezes e devolve kind "network" com mensagem fixa', async () => {
    const boom = () => new TypeError('Network request failed: connect ECONNREFUSED Authorization: Bearer sk-live-LEAK');
    script(boom(), boom(), boom(), boom());
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1'));
    expect(err).toMatchObject({ kind: 'network', transient: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(err?.message).not.toMatch(/sk-|bearer|ECONNREFUSED/i);
  });

  test('timeout do passo: aborta o fetch no limite e devolve kind "timeout" (sem esperar relógio real)', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    const pending = thrown(transcribeWithChain(AUDIO, 'whisper-1', { audioBytes: 40_000 })); // 10 s de áudio → 12 s
    await jest.advanceTimersByTimeAsync(11_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err).toMatchObject({ kind: 'timeout', transient: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // o orçamento acabou: não tenta de novo
  });

  test('cancelamento do chamador durante o upload é "cancelled" (não timeout) e não recua na cadeia', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    const ctrl = new AbortController();
    const pending = thrown(transcribeWithChain(AUDIO, 'openai/gpt-4o-transcribe', { signal: ctrl.signal }));
    await jest.advanceTimersByTimeAsync(0);
    ctrl.abort();
    const err = await pending;
    expect(err?.kind).toBe('cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('sinal já abortado: não chama a rede', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1', { signal: ctrl.signal }));
    expect(err?.kind).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('corpo 200 que não é JSON de objeto: bad_response permanente (sem retry)', async () => {
    script(res(200, 'isto não é json'));
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1'));
    expect(err).toMatchObject({ kind: 'bad_response', code: 'invalid_json', transient: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('arquivo de áudio ilegível (FormData falha) é erro do ITEM ("file"), não de rede', async () => {
    jest.spyOn(FormData.prototype, 'append').mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1'));
    expect(err).toMatchObject({ kind: 'bad_response', code: 'file', transient: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a cadeia nunca troca de provedor', () => {
  test.each(AVAILABLE_TRANSCRIPTION_MODELS.map((m) => [m.id, m.provider] as const))(
    'cadeia de %s: sem repetição e só modelos do mesmo provedor (%s)',
    (id, provider) => {
      const chain = transcriptionChainFor(id);
      expect(chain[0]).toBe(id);
      expect(new Set(chain).size).toBe(chain.length);
      for (const m of chain) expect(AVAILABLE_TRANSCRIPTION_MODELS.find((x) => x.id === m)?.provider).toBe(provider);
    }
  );

  test('modelo OpenRouter que falha: todas as chamadas vão ao OpenRouter, nunca à OpenAI (mesmo com chave OpenAI salva)', async () => {
    script(...Array.from({ length: 8 }, () => res(503, 'x')));
    const err = await thrown(transcribeWithChain(AUDIO, 'openai/gpt-4o-transcribe'));
    expect(err?.kind).toBe('server');
    const urls = new Set(calls().map((c: { url: string }) => c.url));
    expect([...urls]).toEqual([OPENROUTER_URL]);
    expect(calls().map((c: { model: string }) => c.model)).toEqual([
      ...Array(4).fill('openai/gpt-4o-transcribe'),
      ...Array(4).fill('openai/gpt-4o-mini-transcribe'),
    ]);
    expect(JSON.stringify(calls())).not.toContain(OPENAI_KEY);
  });

  test('whisper-1 direto só fala com a OpenAI e usa a chave da OpenAI', async () => {
    script(ok(GOOD_TEXT));
    await transcribeWithChain(AUDIO, 'whisper-1');
    expect(calls()).toEqual([{ url: OPENAI_URL, model: 'whisper-1', auth: `Bearer ${OPENAI_KEY}` }]);
  });

  test('modelo OpenRouter sem chave OpenRouter: erro de credencial, e NÃO cai para a chave OpenAI', async () => {
    await setOpenRouterApiKey('');
    const err = await thrown(transcribeWithChain(AUDIO, 'openai/gpt-4o-transcribe'));
    expect(err).toMatchObject({ kind: 'invalid_key', code: 'no_credential' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('modo proxy sem sessão: falha fechado — não usa a chave direta da OpenAI', async () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'; // URL presente: só falta a sessão
    (isProxyAvailable as jest.Mock).mockResolvedValue(true);
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1'));
    expect(err).toMatchObject({ kind: 'invalid_key', code: 'no_credential' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('modo proxy com sessão: vai ao proxy com o JWT, nunca com a chave da OpenAI', async () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
    (isProxyAvailable as jest.Mock).mockResolvedValue(true);
    getSessionSpy.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } }, error: null } as never);
    script(ok(GOOD_TEXT));
    await transcribeWithChain(AUDIO, 'whisper-1');
    expect(calls()).toEqual([
      { url: 'https://proj.supabase.co/functions/v1/openai-transcribe', model: 'whisper-1', auth: 'Bearer jwt-123' },
    ]);
  });
});

describe('sanidade do texto transcrito', () => {
  test.each(['', '   ', '...', '— — —', '\n'])('texto sem palavras (%j) é "vazio"', (text) => {
    expect(checkTranscriptSanity(text)).toBe('vazio');
  });

  test('eco do prompt inteiro, parcial ou com sobra mínima é "eco"', () => {
    const words = WHISPER_MEDICAL_PROMPT.split(' ');
    expect(checkTranscriptSanity(WHISPER_MEDICAL_PROMPT)).toBe('eco');
    expect(checkTranscriptSanity(words.slice(0, Math.floor(words.length * 0.7)).join(' '))).toBe('eco');
    expect(checkTranscriptSanity(`${WHISPER_MEDICAL_PROMPT} Obrigado.`)).toBe('eco');
  });

  test('ditado clínico real com nomes de remédios do prompt NÃO é falso positivo', () => {
    const text =
      'Paciente de 54 anos refere uso contínuo de Losartana, Amlodipina e Metformina, queixa de cefaleia e tontura há dois dias, nega febre. Conduta: dipirona se dor, retorno em sete dias.';
    expect(checkTranscriptSanity(text)).toBeNull();
    expect(checkTranscriptSanity('pressão 120 por 80')).toBeNull();
  });

  test('trecho curto (<8 palavras) copiado do prompt, ou texto maior que o prompt, não é eco', () => {
    expect(checkTranscriptSanity('Receita médica Clavulin BD Amoxicilina Clavulanato Amoxil')).toBeNull();
    const longOwnText = Array.from({ length: 700 }, (_, i) => `palavra${i}`).join(' ');
    expect(checkTranscriptSanity(`${WHISPER_MEDICAL_PROMPT} ${longOwnText}`)).toBeNull();
  });

  test('laço de alucinação (bloco repetido cobrindo ≥ 50%) é "repeticao"', () => {
    expect(checkTranscriptSanity('obrigado '.repeat(30))).toBe('repeticao');
    expect(checkTranscriptSanity('Legendas pela comunidade Amara.org '.repeat(6))).toBe('repeticao');
  });

  test('repetição curta ou diluída em texto real é aceita', () => {
    expect(checkTranscriptSanity('sim sim sim sim')).toBeNull();
    const text = `${GOOD_TEXT} ah ah ah ah ${GOOD_TEXT} Retorno em uma semana com exames de sangue e urina.`;
    expect(checkTranscriptSanity(text)).toBeNull();
  });
});

describe('cadeia: recuo por texto recusado e resultado vazio', () => {
  const CHOSEN: TranscriptionModelId = 'openai/gpt-4o-transcribe';

  test('modelo escolhido devolve eco do prompt: recua para o próximo e entrega o texto bom', async () => {
    script(ok(WHISPER_MEDICAL_PROMPT), ok(GOOD_TEXT));
    await expect(transcribeWithChain(AUDIO, CHOSEN)).resolves.toBe(GOOD_TEXT);
    expect(calls().map((c: { model: string }) => c.model)).toEqual([CHOSEN, 'openai/gpt-4o-mini-transcribe']);
  });

  test('texto repetitivo no 1º passo também recua', async () => {
    script(ok('obrigado '.repeat(40)), ok(GOOD_TEXT));
    await expect(transcribeWithChain(AUDIO, CHOSEN)).resolves.toBe(GOOD_TEXT);
  });

  test('1º passo com falha transitória persistente recua para o 2º', async () => {
    script(res(503, 'x'), res(503, 'x'), res(503, 'x'), res(503, 'x'), ok(GOOD_TEXT));
    await expect(transcribeWithChain(AUDIO, CHOSEN)).resolves.toBe(GOOD_TEXT);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('só eco em todos os passos: lança bad_response "eco" (nunca grava o eco, nunca devolve vazio)', async () => {
    script(ok(WHISPER_MEDICAL_PROMPT), ok(WHISPER_MEDICAL_PROMPT));
    const err = await thrown(transcribeWithChain(AUDIO, CHOSEN));
    expect(err).toMatchObject({ kind: 'bad_response', code: 'eco' });
    expect(err?.message).not.toContain('Clavulin');
  });

  test('whisper-1 sem alternativa no provedor: eco vira erro (cadeia de 1 passo)', async () => {
    script(ok(WHISPER_MEDICAL_PROMPT));
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1'));
    expect(err).toMatchObject({ kind: 'bad_response', code: 'eco' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['texto vazio', ok('')],
    ['sem campo text', res(200, {})],
    ['só pontuação', ok(' ... ')],
  ])('TODOS os passos vazios (%s) → "" (nenhuma fala)', async (_label, response) => {
    script(response, response);
    await expect(transcribeWithChain(AUDIO, CHOSEN)).resolves.toBe('');
  });

  test('vazio num passo + falha transitória no outro NÃO vira "sem fala": lança para a fila tentar de novo', async () => {
    script(ok(''), res(503, 'x'), res(503, 'x'), res(503, 'x'), res(503, 'x'));
    const err = await thrown(transcribeWithChain(AUDIO, CHOSEN));
    expect(err).toMatchObject({ kind: 'server', transient: true });
  });

  test('falha transitória no 1º e vazio no 2º também lança (não devolve "")', async () => {
    script(res(503, 'x'), res(503, 'x'), res(503, 'x'), res(503, 'x'), ok(''));
    const err = await thrown(transcribeWithChain(AUDIO, CHOSEN));
    expect(err?.transient).toBe(true);
  });
});

describe('segredos nunca aparecem em erros nem em logs', () => {
  test('provedor devolve a chave no corpo do 401: nem o erro nem console.warn/error a contêm', async () => {
    script(
      res(401, {
        error: { message: `Incorrect API key provided: ${OPENAI_KEY}. Authorization: Bearer ${OPENAI_KEY}`, code: 'invalid_api_key' },
      })
    );
    const err = await thrown(transcribeWithChain(AUDIO, 'whisper-1'));
    const logs = JSON.stringify([(console.warn as jest.Mock).mock.calls, (console.error as jest.Mock).mock.calls, (console.log as jest.Mock).mock.calls]);
    for (const text of [`${err?.message}`, JSON.stringify(err), `${err?.stack}`, logs]) {
      expect(text).not.toContain(OPENAI_KEY);
      expect(text).not.toContain(OPENROUTER_KEY);
      expect(text).not.toMatch(/sk-|bearer/i);
    }
  });

  test('erro 400 com chave no corpo: mensagem genérica, sem o detalhe do provedor', async () => {
    script(res(400, { error: { message: `bad request for key ${OPENROUTER_KEY} Bearer ${OPENROUTER_KEY}` } }));
    await setTranscriptionModel('openai/gpt-4o-mini-transcribe');
    const err = await thrown(transcribeWithChain(AUDIO, 'openai/gpt-4o-mini-transcribe'));
    expect(err?.message).toMatch(/Pedido recusado \(HTTP 400\)/);
    expect(err?.message).not.toMatch(/bearer/i);
  });
});

describe('transcribeAudio (porta de entrada)', () => {
  test('arquivo inexistente: erro "file" sem chamar a rede', async () => {
    globalThis.__fakeFs.delete(AUDIO);
    const err = await thrown(transcribeAudio(AUDIO));
    expect(err).toMatchObject({ kind: 'bad_response', code: 'file' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('áudio de menos de ~0,1 s é recusado antes do upload', async () => {
    globalThis.__fakeFs.set(AUDIO, { size: 1599 });
    const err = await thrown(transcribeAudio(AUDIO));
    expect(err).toMatchObject({ kind: 'bad_response', code: 'audio_too_short' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('usa o modelo escolhido nas configurações', async () => {
    await setTranscriptionModel('openai/gpt-4o-mini-transcribe');
    script(ok(GOOD_TEXT));
    await expect(transcribeAudio(AUDIO)).resolves.toBe(GOOD_TEXT);
    expect(calls()[0]).toMatchObject({ url: OPENROUTER_URL, model: 'openai/gpt-4o-mini-transcribe' });
  });
});

describe('orçamento de tempo do passo', () => {
  test('cresce com a duração, tem teto de 45 s e áudio longo não é cortado em 45 s', () => {
    expect(stepTimeoutMs(10)).toBe(12_000);
    expect(stepTimeoutMs(60)).toBe(32_000);
    expect(stepTimeoutMs(100)).toBe(45_000);
    expect(stepTimeoutMs(130)).toBeGreaterThan(45_000); // sem chunking, o upload sozinho passa de 45 s
    expect(stepTimeoutMs(100_000)).toBe(120_000);
    for (const unknown of [undefined, 0, -5, Number.NaN]) expect(stepTimeoutMs(unknown)).toBe(120_000);
  });
});
