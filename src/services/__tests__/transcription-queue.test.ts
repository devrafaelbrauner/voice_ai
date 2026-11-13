// Fila offline de transcrição: AsyncStorage em memória, TranscriptionError real, relógio falso.
import type * as QueueModule from '../transcription-queue';
import type * as OpenAIModule from '../openai';

declare global {
  var __fakeFs: Map<string, string | { size: number }>;
}
jest.mock('expo/fetch', () => ({ __esModule: true, fetch: jest.fn() }));

type TranscribeFn = jest.Mock<Promise<{ text: string }>, [string, QueueModule.QueuedTranscription]>;

const MINUTE = 60_000;
const START = new Date('2025-06-01T12:00:00.000Z');
const QUEUE_KEY = '@voice_ai_recorder/transcription_queue/v1';

let queue: typeof QueueModule;
let openai: typeof OpenAIModule;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest.setSystemTime(START);
  jest.resetModules();
  queue = jest.requireActual<typeof QueueModule>('../transcription-queue');
  openai = jest.requireActual<typeof OpenAIModule>('../openai');
});

afterEach(() => {
  jest.useRealTimers();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(0);
};

const uriOf = (fileName: string) => `file:///doc/${fileName}`;

/** Item na fila com o áudio presente no "disco". */
async function enqueue(...fileNames: string[]) {
  for (const fileName of fileNames) {
    globalThis.__fakeFs.set(uriOf(fileName), 'audio-bytes');
    await queue.enqueueTranscription({ fileName, uri: uriOf(fileName), createdAt: START.toISOString() });
  }
}

const fail = (kind: OpenAIModule.TranscriptionErrorKind, init: { retryAfterMs?: number; code?: string } = {}) =>
  new openai.TranscriptionError(kind, `falha ${kind}`, init);

const item = async (fileName: string) => (await queue.getQueue()).find((q) => q.fileName === fileName);
const names = (fn: TranscribeFn) => fn.mock.calls.map(([, it]) => it.fileName);
const makeFn = (impl: (it: QueueModule.QueuedTranscription) => Promise<{ text: string }> | { text: string }): TranscribeFn =>
  jest.fn(async (_uri: string, it: QueueModule.QueuedTranscription) => impl(it));
const ok = { text: 'transcrição ok' };

describe('cooldown por item', () => {
  test('item com falha transitória entra em cooldown sozinho: o próximo item segue e o drain seguinte o pula', async () => {
    await enqueue('a.m4a', 'b.m4a');
    const fn = makeFn((it) => {
      if (it.fileName === 'a.m4a') throw fail('server');
      return ok;
    });

    const s1 = await queue.processQueue(fn);

    expect(s1).toMatchObject({ processed: 1, failed: 1, permanentlyFailed: 0, remaining: 1, alreadyRunning: false });
    expect(s1.stoppedBy).toBeUndefined();
    const a = await item('a.m4a');
    expect(a).toMatchObject({ attempts: 1, countedFailures: 0, lastErrorKind: 'server' });
    expect(a!.nextAttemptAt! - Date.now()).toBeGreaterThanOrEqual(15_000);
    expect(a!.nextAttemptAt! - Date.now()).toBeLessThanOrEqual(30_000);

    const s2 = await queue.processQueue(fn);
    expect(s2).toMatchObject({ processed: 0, deferred: 1, remaining: 1 });
    expect(names(fn)).toEqual(['a.m4a', 'b.m4a']); // a não foi tentado de novo

    jest.advanceTimersByTime(30_000);
    fn.mockImplementation(async () => ok);
    expect(await queue.processQueue(fn)).toMatchObject({ processed: 1, remaining: 0 });
  });

  test('ignoreCooldown (ação do usuário) processa item que ainda está em cooldown', async () => {
    await enqueue('a.m4a');
    const fn = makeFn(() => {
      throw fail('server');
    });
    await queue.processQueue(fn);
    fn.mockImplementation(async () => ok);

    expect(await queue.processQueue(fn)).toMatchObject({ processed: 0, deferred: 1 });
    expect(await queue.processQueue(fn, undefined, { ignoreCooldown: true })).toMatchObject({ processed: 1, remaining: 0 });
  });

  test('Retry-After do servidor define o cooldown, limitado a 15 min', async () => {
    await enqueue('a.m4a', 'b.m4a');
    const fn = makeFn((it) => {
      throw fail('rate_limit', { retryAfterMs: it.fileName === 'a.m4a' ? 120_000 : 3_600_000 });
    });
    await queue.processQueue(fn);
    await queue.processQueue(fn, undefined, { ignoreCooldown: true, skip: (q) => q.fileName === 'a.m4a' });

    expect((await item('a.m4a'))!.nextAttemptAt).toBe(Date.now() + 120_000);
    expect((await item('b.m4a'))!.nextAttemptAt).toBe(Date.now() + 15 * MINUTE);
  });

  test('cooldown cresce com as falhas (30 s dobrando, metade fixa + jitter) e para em 15 min', async () => {
    await enqueue('a.m4a');
    const fn = makeFn(() => {
      throw fail('timeout');
    });
    for (let n = 1; n <= 10; n++) {
      await queue.processQueue(fn, undefined, { ignoreCooldown: true });
      const exp = Math.min(30_000 * 2 ** (n - 1), 15 * MINUTE);
      const wait = (await item('a.m4a'))!.nextAttemptAt! - Date.now();
      expect(wait).toBeGreaterThanOrEqual(Math.floor(exp / 2));
      expect(wait).toBeLessThanOrEqual(exp);
    }
  });
});

describe('erros que param a drenagem sem gastar tentativa', () => {
  test.each(['network', 'rate_limit', 'invalid_key', 'forbidden', 'quota'] as const)(
    '%s: para na hora (o 2º item nem é tentado), informa stoppedBy e nunca leva a "permanentlyFailed"',
    async (kind) => {
      await enqueue('a.m4a', 'b.m4a');
      const fn = makeFn(() => {
        throw fail(kind);
      });

      const first = await queue.processQueue(fn);
      expect(first).toMatchObject({ processed: 0, failed: 1, permanentlyFailed: 0, remaining: 2, stoppedBy: kind });
      expect(names(fn)).toEqual(['a.m4a']);

      for (let i = 0; i < 12; i++) await queue.processQueue(fn, undefined, { ignoreCooldown: true });

      const a = await item('a.m4a');
      expect(a!.permanentlyFailed).toBeUndefined();
      expect(a!.countedFailures ?? 0).toBe(0);
      expect(a!.lastErrorKind).toBe(kind);
      expect(await item('b.m4a')).toMatchObject({ attempts: 0 });
      expect(globalThis.__fakeFs.has(uriOf('a.m4a'))).toBe(true);
    }
  );

  test.each(['invalid_key', 'forbidden', 'quota'] as const)(
    '%s é erro de configuração: não gasta nem tentativa; drenagens automáticas pausam por 60 s; ação manual ignora a pausa',
    async (kind) => {
      await enqueue('a.m4a');
      const fn = makeFn(() => {
        throw fail(kind);
      });
      await queue.processQueue(fn);
      expect((await item('a.m4a'))).toMatchObject({ attempts: 0, lastErrorKind: kind });
      expect((await item('a.m4a'))!.nextAttemptAt).toBeUndefined();

      jest.advanceTimersByTime(59_000);
      const paused = await queue.processQueue(fn);
      expect(paused).toMatchObject({ processed: 0, deferred: 1, stoppedBy: kind });
      expect(fn).toHaveBeenCalledTimes(1);

      // Usuário corrigiu a chave e tocou em "processar": ignora a pausa.
      fn.mockImplementation(async () => ok);
      expect(await queue.processQueue(fn, undefined, { ignoreCooldown: true })).toMatchObject({ processed: 1 });
    }
  );

  test('depois dos 60 s a drenagem automática volta sozinha (erro de configuração já corrigido)', async () => {
    await enqueue('a.m4a');
    const fn = makeFn(() => {
      throw fail('invalid_key');
    });
    await queue.processQueue(fn);
    fn.mockImplementation(async () => ok);
    jest.advanceTimersByTime(60_000);
    expect(await queue.processQueue(fn)).toMatchObject({ processed: 1, remaining: 0 });
  });

  test('rede volta: o item tentado reentra depois de ~10 s, sem pausa global de 60 s', async () => {
    await enqueue('a.m4a');
    const fn = makeFn(() => {
      throw fail('network');
    });
    await queue.processQueue(fn);
    expect((await item('a.m4a'))!.nextAttemptAt).toBe(Date.now() + 10_000);
    fn.mockImplementation(async () => ok);
    jest.advanceTimersByTime(10_000);
    expect(await queue.processQueue(fn)).toMatchObject({ processed: 1 });
  });
});

describe('falhas permanentes', () => {
  test('5 falhas permanentes marcam permanentlyFailed — o áudio nunca é apagado e o item sai da fila ativa', async () => {
    await enqueue('a.m4a');
    const fn = makeFn(() => {
      throw fail('bad_response', { code: 'http_400' });
    });
    for (let n = 1; n <= 4; n++) {
      const s = await queue.processQueue(fn, undefined, { ignoreCooldown: true });
      expect(s).toMatchObject({ failed: 1, permanentlyFailed: 0, remaining: 1 });
    }
    expect((await item('a.m4a'))).toMatchObject({ countedFailures: 4 });

    const last = await queue.processQueue(fn, undefined, { ignoreCooldown: true });

    expect(last).toMatchObject({ failed: 0, permanentlyFailed: 1, remaining: 0 });
    expect(await item('a.m4a')).toMatchObject({ permanentlyFailed: true, countedFailures: 5 });
    expect((await item('a.m4a'))!.nextAttemptAt).toBeUndefined();
    expect(globalThis.__fakeFs.get(uriOf('a.m4a'))).toBe('audio-bytes'); // áudio intacto
    expect(await queue.getQueueCount()).toBe(0);
    expect((await queue.getFailedItems()).map((q) => q.fileName)).toEqual(['a.m4a']);

    // Nunca mais tentado automaticamente (nem com ignoreCooldown).
    await queue.processQueue(fn, undefined, { ignoreCooldown: true });
    expect(fn).toHaveBeenCalledTimes(5);

    await queue.clearFailedItems();
    expect(await queue.getQueue()).toEqual([]);
    expect(globalThis.__fakeFs.has(uriOf('a.m4a'))).toBe(true); // limpar a fila também não apaga o áudio
  });

  test('erro desconhecido (não é TranscriptionError) conta como permanente', async () => {
    await enqueue('a.m4a');
    const fn = makeFn(() => {
      throw new Error('algo inesperado');
    });
    await queue.processQueue(fn);
    expect(await item('a.m4a')).toMatchObject({ countedFailures: 1, attempts: 1 });
  });

  test('falhas transitórias não contam: 4 permanentes + 20 de servidor + 1 permanente → só a 5ª permanente fecha', async () => {
    await enqueue('a.m4a');
    let plan: 'permanent' | 'server' = 'permanent';
    const fn = makeFn(() => {
      throw plan === 'permanent' ? fail('bad_response') : fail('server');
    });
    const drain = () => queue.processQueue(fn, undefined, { ignoreCooldown: true });
    for (let i = 0; i < 4; i++) await drain();
    plan = 'server';
    for (let i = 0; i < 20; i++) await drain();
    expect(await item('a.m4a')).toMatchObject({ countedFailures: 4, attempts: 24 });
    expect((await item('a.m4a'))!.permanentlyFailed).toBeUndefined();
    plan = 'permanent';
    await drain();
    expect((await item('a.m4a'))!.permanentlyFailed).toBe(true);
  });

  test('áudio sumiu do aparelho: falha permanente imediata, sem chamar a transcrição, e o resto da fila segue', async () => {
    await enqueue('some.m4a', 'fica.m4a');
    globalThis.__fakeFs.delete(uriOf('some.m4a'));
    const fn = makeFn(() => ok);
    const onItemError = jest.fn();

    const s = await queue.processQueue(fn, undefined, { onItemError });

    expect(s).toMatchObject({ processed: 1, permanentlyFailed: 1, remaining: 0 });
    expect(names(fn)).toEqual(['fica.m4a']);
    expect(await item('some.m4a')).toMatchObject({ permanentlyFailed: true });
    expect(onItemError).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'some.m4a' }),
      expect.objectContaining({ kind: 'bad_response', code: 'file' })
    );
  });
});

describe('sucesso e persistência do resultado', () => {
  test('onItemSuccess roda ANTES de remover da fila; se salvar falha, o item permanece (nada se perde)', async () => {
    await enqueue('a.m4a', 'b.m4a');
    const seenInQueue: boolean[] = [];
    const onItemSuccess = jest.fn(async (it: QueueModule.QueuedTranscription) => {
      seenInQueue.push((await item(it.fileName)) !== undefined);
      if (it.fileName === 'a.m4a') throw new Error('disco cheio');
    });
    const onItemError = jest.fn();

    const s = await queue.processQueue(makeFn(() => ({ text: 'texto' })), onItemSuccess, { onItemError });

    expect(seenInQueue).toEqual([true, true]);
    expect(onItemSuccess).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'b.m4a' }), 'texto');
    expect(s).toMatchObject({ processed: 1, failed: 1, remaining: 1 });
    expect(await item('a.m4a')).toMatchObject({ lastError: 'disco cheio' });
    expect(await item('b.m4a')).toBeUndefined();
    expect(onItemError).toHaveBeenCalledTimes(1);
    expect(globalThis.__fakeFs.has(uriOf('a.m4a'))).toBe(true);
  });

  test('skip(item): item ocupado em outro lugar não é tentado e conta como adiado', async () => {
    await enqueue('a.m4a', 'b.m4a');
    const fn = makeFn(() => ok);
    const s = await queue.processQueue(fn, undefined, { skip: (q) => q.fileName === 'a.m4a' });
    expect(names(fn)).toEqual(['b.m4a']);
    expect(s).toMatchObject({ processed: 1, deferred: 1, remaining: 1 });
  });

  test('armazenamento corrompido não derruba a fila: lê como vazia e volta a funcionar', async () => {
    const storage = jest.requireMock('@react-native-async-storage/async-storage');
    await storage.setItem(QUEUE_KEY, '{isto não é json');
    expect(await queue.getQueue()).toEqual([]);
    await expect(queue.processQueue(makeFn(() => ok))).resolves.toMatchObject({ processed: 0, remaining: 0 });
    await enqueue('a.m4a');
    expect((await queue.getQueue()).map((q) => q.fileName)).toEqual(['a.m4a']);
  });
});

describe('identificação por fileName (nunca por posição)', () => {
  test('item removido durante a drenagem desloca índices, mas a falha vai para o item certo', async () => {
    await enqueue('a.m4a', 'b.m4a', 'c.m4a');
    const fn = makeFn(async (it) => {
      if (it.fileName === 'b.m4a') {
        await queue.dequeueTranscription('a.m4a'); // usuário limpou o 'a' enquanto o 'b' transcreve
        throw fail('bad_response');
      }
      return ok;
    });

    await queue.processQueue(fn);

    expect(names(fn)).toEqual(['a.m4a', 'b.m4a', 'c.m4a']);
    const left = await queue.getQueue();
    expect(left.map((q) => q.fileName)).toEqual(['b.m4a']); // a: sucesso; c: sucesso; b: ficou
    expect(left[0]).toMatchObject({ attempts: 1, countedFailures: 1, lastErrorKind: 'bad_response' });
  });

  test('item removido pelo usuário antes de a sua vez não é transcrito', async () => {
    await enqueue('a.m4a', 'b.m4a');
    const fn = makeFn(async (it) => {
      if (it.fileName === 'a.m4a') await queue.dequeueTranscription('b.m4a');
      return ok;
    });
    await queue.processQueue(fn);
    expect(names(fn)).toEqual(['a.m4a']);
  });

  test('enfileirar o mesmo fileName duas vezes não duplica e acumula a falha no item existente', async () => {
    await enqueue('a.m4a');
    await queue.enqueueTranscription({ fileName: 'a.m4a', uri: uriOf('a.m4a'), createdAt: START.toISOString(), error: fail('bad_response') });
    await queue.enqueueTranscription({ fileName: 'a.m4a', uri: 'file:///outro/caminho.m4a', createdAt: START.toISOString(), error: fail('bad_response') });

    const all = await queue.getQueue();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ uri: uriOf('a.m4a'), attempts: 2, countedFailures: 2 });
  });
});

describe('não reentrante', () => {
  test('segunda chamada durante um drain não faz nada (alreadyRunning) e não duplica a transcrição', async () => {
    await enqueue('a.m4a');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fn = makeFn(async () => {
      await gate;
      return ok;
    });

    const first = queue.processQueue(fn);
    await settle();
    const second = await queue.processQueue(fn);

    expect(second).toMatchObject({ alreadyRunning: true, processed: 0, failed: 0, deferred: 0, remaining: 1 });
    expect(fn).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toMatchObject({ processed: 1, alreadyRunning: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a trava é liberada mesmo quando a transcrição lança: o próximo drain roda', async () => {
    await enqueue('a.m4a');
    const fn = makeFn(() => {
      throw fail('server');
    });
    expect((await queue.processQueue(fn)).alreadyRunning).toBe(false);
    fn.mockImplementation(async () => ok);
    expect(await queue.processQueue(fn, undefined, { ignoreCooldown: true })).toMatchObject({ alreadyRunning: false, processed: 1 });
  });

  test('enfileirar durante o drain não perde nem sobrescreve itens (escritas serializadas)', async () => {
    await enqueue('a.m4a');
    const fn = makeFn(async (it) => {
      if (it.fileName === 'a.m4a') await enqueue('novo.m4a'); // gravação nova entra durante a drenagem
      return ok;
    });
    await queue.processQueue(fn);
    expect((await queue.getQueue()).map((q) => q.fileName)).toEqual(['novo.m4a']);
  });
});

describe('isRetryableTranscriptionError', () => {
  test('só erros transitórios do motor valem fila; chave/permissão/cota/resposta ruim/erro comum não', () => {
    const retry = (e: unknown) => queue.isRetryableTranscriptionError(e);
    for (const kind of ['network', 'timeout', 'rate_limit', 'server'] as const) expect(retry(fail(kind))).toBe(true);
    for (const kind of ['invalid_key', 'forbidden', 'quota', 'bad_response', 'cancelled'] as const) expect(retry(fail(kind))).toBe(false);
    expect(retry(new Error('rede'))).toBe(false);
    expect(retry('texto')).toBe(false);
  });
});
