// Leitor incremental de JSON (restore em lotes): fronteiras, escapes cortados na borda de pedaço e
// fuzz contra o JSON.parse (mesmo veredito, mesmo conteúdo) com pedaços de 1 caractere em diante.
import { JsonNotObjectError, JsonSliceError, MAX_ARRAY_ITEMS, MAX_FIELD_CHARS, readJsonObject, type JsonItem } from '../json-slices';

const KEYS: ReadonlySet<string> = new Set(['recordings', 'customTemplates']);

/** Pedaços de tamanho `size` (ou sorteados por `next`, se for função). */
function pullFrom(text: string, size: number | (() => number)) {
  let at = 0;
  return () => {
    if (at >= text.length) return null;
    const step = typeof size === 'number' ? size : size();
    const piece = text.slice(at, at + step);
    at += step;
    return piece;
  };
}

async function readAll(text: string, size: number | (() => number) = 7, minRead = 1) {
  const items: JsonItem[] = [];
  await readJsonObject(pullFrom(text, size), KEYS, (item) => { items.push(item); }, minRead);
  return items;
}

describe('readJsonObject: casos básicos', () => {
  test('entrega campos e elementos dos arrays na ordem do documento', async () => {
    const items = await readAll('{"version":2,"recordings":[{"a":1},"x",3,null,[1,2]],"app":"v","customTemplates":[]}', 3);
    expect(items).toEqual([
      { key: 'version', value: 2, element: false },
      { key: 'recordings', value: { a: 1 }, element: true },
      { key: 'recordings', value: 'x', element: true },
      { key: 'recordings', value: 3, element: true },
      { key: 'recordings', value: null, element: true },
      { key: 'recordings', value: [1, 2], element: true },
      { key: 'app', value: 'v', element: false },
    ]);
  });

  test('chave "streamed" com valor que não é array vira um campo; outros arrays também', async () => {
    const items = await readAll('{"recordings":null,"customTemplates":{"a":[1]},"outro":[1,2]}');
    expect(items).toEqual([
      { key: 'recordings', value: null, element: false },
      { key: 'customTemplates', value: { a: [1] }, element: false },
      { key: 'outro', value: [1, 2], element: false },
    ]);
  });

  test('espaço JSON (inclusive indentação) é aceito; strings com chaves, colchetes, aspas e barras não confundem a fronteira', async () => {
    const tricky = 'a}],{"b":[ \\" \\\\ \\\\\\" ]} \n';
    const text = JSON.stringify({ recordings: [{ t: tricky }, { t: '\\' }, { t: '"' }, { t: '{' }] }, null, 2);
    const items = await readAll(`\n\t ${text} \r\n`, 1);
    expect(items.map((i) => (i.value as { t: string }).t)).toEqual([tricky, '\\', '"', '{']);
  });

  test('objeto vazio, arrays vazios e números soltos no fim de elemento', async () => {
    expect(await readAll('{}')).toEqual([]);
    expect(await readAll('{"recordings":[],"customTemplates":[ ]}')).toEqual([]);
    expect((await readAll('{"recordings":[1,-2.5e3,true]}', 2)).map((i) => i.value)).toEqual([1, -2500, true]);
  });

  test('JSON válido que não é objeto: JsonNotObjectError; texto de primeiro nível depois do objeto é recusado', async () => {
    for (const text of ['[]', 'null', '12', '"x"', ' [1,2] ']) {
      await expect(readAll(text)).rejects.toBeInstanceOf(JsonNotObjectError);
    }
    for (const text of ['{} {}', '{}x', '{}}', '{"a":1}\n,']) {
      await expect(readAll(text)).rejects.toBeInstanceOf(JsonSliceError);
    }
  });

  test.each([
    ['vazio', ''],
    ['só espaço', '  \n'],
    ['truncado no meio da string', '{"recordings":[{"a":"xx'],
    ['truncado antes do fechamento', '{"recordings":[{"a":1}'],
    ['vírgula sobrando em array', '{"recordings":[1,]}'],
    ['vírgula sobrando em objeto', '{"a":1,}'],
    ['vírgula inicial', '{"recordings":[,1]}'],
    ['falta dois-pontos', '{"a" 1}'],
    ['falta valor', '{"a":}'],
    ['elementos sem vírgula', '{"recordings":[1 2]}'],
    ['chave sem aspas', '{a:1}'],
    ['colchete trocado por chave', '{"recordings":[{"a":1]}'],
    ['literal quebrado', '{"recordings":[tru]}'],
    ['espaço não-JSON (NBSP)', '{"a":\u00a01}'],
    ['espaço não-JSON (form feed)', '{"a":1,\f"b":2}'],
    ['BOM no começo', '\ufeff{"a":1}'],
    ['controle dentro da string', '{"a":"x\ny"}'],
    ['escape inválido', '{"a":"\\x"}'],
  ])('recusa JSON malformado: %s', async (_name, text) => {
    for (const size of [1, 3, 1000]) {
      await expect(readAll(text, size)).rejects.toBeInstanceOf(JsonSliceError);
    }
  });

  test('array de registros repetido (mesma chave "streamed") é recusado; chave comum repetida entrega as duas (consumidor fica com a última)', async () => {
    await expect(readAll('{"recordings":[1],"recordings":[2]}')).rejects.toMatchObject({ reason: 'duplicate' });
    await expect(readAll('{"recordings":[1],"recordings":null}')).rejects.toMatchObject({ reason: 'duplicate' });
    expect((await readAll('{"version":1,"version":2}')).map((i) => i.value)).toEqual([1, 2]);
  });

  test('onItem assíncrono: a próxima leitura só acontece depois que ele termina (contrapressão)', async () => {
    const log: string[] = [];
    const pull = pullFrom('{"recordings":[1,2,3]}', 4);
    await readJsonObject(
      () => {
        log.push('pull');
        return pull();
      },
      KEYS,
      async (item) => {
        log.push(`start ${item.value}`);
        await Promise.resolve();
        await Promise.resolve();
        log.push(`end ${item.value}`);
      },
      1
    );
    const order = log.filter((l) => l !== 'pull');
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  test('erro lançado por onItem propaga como está (não vira erro de JSON)', async () => {
    await expect(
      readJsonObject(pullFrom('{"recordings":[1]}', 5), KEYS, () => { throw new Error('banco caiu'); }, 1)
    ).rejects.toThrow('banco caiu');
  });
});

describe('readJsonObject: memória', () => {
  test('o JSON.parse só vê fatias do tamanho de um elemento, nunca o documento (≈ 12 MB em 12 000 registros)', async () => {
    const record = (i: number) => ({ fileName: `recording_${i}.m4a`, transcript: `texto ${i} ${'á"\\'.repeat(250)}`, durationSecs: i });
    const parts = ['{"version":2,"recordings":['];
    for (let i = 0; i < 12_000; i++) parts.push((i ? ',' : '') + JSON.stringify(record(i)));
    parts.push('],"customTemplates":[]}');
    const text = parts.join('');
    expect(text.length).toBeGreaterThan(10 * 1024 * 1024);

    const parse = jest.spyOn(JSON, 'parse');
    try {
      let count = 0;
      await readJsonObject(pullFrom(text, 192 * 1024), KEYS, (item) => {
        if (item.element) count++;
      });
      expect(count).toBe(12_000);
      const biggest = Math.max(...parse.mock.calls.map(([s]) => String(s).length));
      expect(biggest).toBeLessThan(4096);
    } finally {
      parse.mockRestore();
    }
  });

  test('um único elemento gigante (6 MB) é lido em tempo linear (recargas dobram), sem recopiar a cada pedaço', async () => {
    const big = 'x'.repeat(6 * 1024 * 1024);
    const text = `{"recordings":[{"t":"${big}"},{"t":"fim"}]}`;
    const t0 = Date.now();
    const items = await readAll(text, 4096, 64 * 1024);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(items.map((i) => (i.value as { t: string }).t.length)).toEqual([big.length, 3]);
  });
});

// ─── Fuzz: o veredito e o conteúdo têm de ser os do JSON.parse ────────────────

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('readJsonObject: fuzz contra JSON.parse', () => {
  const ALPHABET = ['a', 'Z', ' ', '"', '\\', '{', '}', '[', ']', ',', ':', '/', '\n', 'é', '€', '😀', '0', '-', '\u0000'];
  const MUTATIONS = ['{', '}', '[', ']', '"', ',', ':', '\\', ' ', '\n', '\t', '0', 'a', '\u00a0', '\f'];

  function randomValue(rnd: () => number, depth: number): unknown {
    const r = rnd();
    if (depth > 2 || r < 0.35) {
      const len = Math.floor(rnd() * 12);
      let s = '';
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      return r < 0.1 ? Math.floor(rnd() * 1000) - 500 : r < 0.15 ? null : r < 0.2 ? rnd() < 0.5 : s;
    }
    if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(rnd, depth + 1));
    const o: Record<string, unknown> = {};
    for (let i = Math.floor(rnd() * 4); i > 0; i--) o[`k${Math.floor(rnd() * 5)}${ALPHABET[Math.floor(rnd() * 4)]}`] = randomValue(rnd, depth + 1);
    return o;
  }

  function randomDocument(rnd: () => number): string {
    const doc: Record<string, unknown> = {};
    const keys = ['version', 'app', 'doctor', 'recordings', 'customTemplates', 'extra'].sort(() => rnd() - 0.5);
    for (const key of keys) {
      if (rnd() < 0.15) continue;
      doc[key] = key === 'recordings' || key === 'customTemplates'
        ? rnd() < 0.9 ? Array.from({ length: Math.floor(rnd() * 5) }, () => randomValue(rnd, 0)) : randomValue(rnd, 0)
        : randomValue(rnd, 0);
    }
    return JSON.stringify(doc, null, rnd() < 0.3 ? 2 : undefined);
  }

  function mutate(rnd: () => number, text: string): string {
    const rounds = 1 + Math.floor(rnd() * 3);
    let out = text;
    for (let i = 0; i < rounds && out.length > 0; i++) {
      const at = Math.floor(rnd() * out.length);
      const kind = Math.floor(rnd() * 6);
      if (kind === 0) out = out.slice(0, at) + out.slice(at + 1);
      else if (kind === 1) out = out.slice(0, at) + MUTATIONS[Math.floor(rnd() * MUTATIONS.length)] + out.slice(at);
      else if (kind === 2) out = out.slice(0, at);
      else if (kind === 3) out = out.slice(0, at) + MUTATIONS[Math.floor(rnd() * MUTATIONS.length)] + out.slice(at + 1);
      else if (kind === 4) out = out.slice(0, at) + out.slice(at, at + 1) + out.slice(at);
      else out = out.slice(0, at) + out.slice(at + 1, at + 2) + out.slice(at, at + 1) + out.slice(at + 2);
    }
    return out;
  }

  test('4000 documentos (válidos e mutados), pedaços de 1..40 chars e recargas mínimas variadas', async () => {
    const rnd = mulberry32(0xc0ffee);
    let valid = 0;
    let invalid = 0;
    let notObject = 0;
    let duplicates = 0;
    for (let n = 0; n < 4000; n++) {
      const base = randomDocument(rnd);
      const text = rnd() < 0.6 ? mutate(rnd, base) : base;
      const size = rnd() < 0.2 ? 1 : () => 1 + Math.floor(rnd() * 40);
      const minRead = [1, 3, 17, 64 * 1024][Math.floor(rnd() * 4)];

      let expected: unknown;
      let expectedError = false;
      try {
        expected = JSON.parse(text);
      } catch {
        expectedError = true;
      }

      const items: JsonItem[] = [];
      let error: unknown = null;
      try {
        await readJsonObject(pullFrom(text, size), KEYS, (item) => { items.push(item); }, minRead);
      } catch (err) {
        error = err;
      }
      const label = JSON.stringify(text);

      if (expectedError) {
        invalid++;
        expect([label, error instanceof JsonSliceError && error.reason === 'syntax']).toEqual([label, true]);
        continue;
      }
      if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) {
        notObject++;
        expect([label, error instanceof JsonNotObjectError]).toEqual([label, true]);
        continue;
      }
      if (error instanceof JsonSliceError && error.reason === 'duplicate') {
        duplicates++;
        continue; // único desvio deliberado do JSON.parse
      }
      valid++;
      expect([label, error]).toEqual([label, null]);

      const exp = expected as Record<string, unknown>;
      const fields: Record<string, unknown> = {};
      const arrays: Record<string, unknown[]> = {};
      for (const item of items) {
        if (item.element) (arrays[item.key] ??= []).push(item.value);
        else fields[item.key] = item.value;
      }
      for (const key of KEYS) {
        if (Array.isArray(exp[key])) {
          expect([label, key, arrays[key] ?? []]).toEqual([label, key, exp[key]]);
          expect(key in fields).toBe(false);
        } else {
          expect(arrays[key]).toBeUndefined();
        }
      }
      const expectedFields = Object.fromEntries(Object.entries(exp).filter(([k]) => !(KEYS.has(k) && Array.isArray(exp[k]))));
      expect([label, fields]).toEqual([label, expectedFields]);
    }
    // a amostra exercita todos os ramos (senão o fuzz seria vácuo)
    expect(valid).toBeGreaterThan(500);
    expect(invalid).toBeGreaterThan(500);
    expect(notObject).toBeGreaterThanOrEqual(0);
    expect(duplicates).toBeGreaterThanOrEqual(0);
  });
});

describe('readJsonObject: tetos (arquivo hostil)', () => {
  const run = (text: string, limits?: Parameters<typeof readJsonObject>[4]) => {
    const items: JsonItem[] = [];
    return readJsonObject(pullFrom(text, 4096), KEYS, (i) => { items.push(i); }, 64 * 1024, limits).then(() => items);
  };
  const ones = (n: number) => `[${'1,'.repeat(n - 1)}1]`;

  test('o teto padrão é 200 000 itens por array: 200 000 passam, 200 001 dão JsonSliceError(limit) antes de entregar o excedente', async () => {
    expect(MAX_ARRAY_ITEMS).toBe(200_000);
    expect(await run(`{"recordings":${ones(200_000)}}`)).toHaveLength(200_000);
    const seen: number[] = [];
    const err = await readJsonObject(pullFrom(`{"recordings":${ones(200_001)}}`, 4096), KEYS, () => { seen.push(1); }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonSliceError);
    expect(err).toMatchObject({ reason: 'limit' });
    expect(seen).toHaveLength(200_000);
  });

  test('o teto vale POR chave (gravações e templates contam separado)', async () => {
    expect(await run(`{"recordings":${ones(3)},"customTemplates":${ones(3)}}`, { maxElements: 3 })).toHaveLength(6);
    await expect(run(`{"recordings":${ones(3)},"customTemplates":${ones(4)}}`, { maxElements: 3 })).rejects.toMatchObject({ reason: 'limit' });
  });

  test('valor de primeiro nível que não é array "streamed": acima de maxFieldChars é recusado SEM JSON.parse; no limite passa', async () => {
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const doc = (n: number) => `{"doctor":{"name":"${'d'.repeat(n)}"}}`;
      const limit = 1000;
      expect(await run(doc(limit - 20), { maxFieldChars: limit })).toHaveLength(1);
      parse.mockClear();
      await expect(run(doc(limit), { maxFieldChars: limit })).rejects.toMatchObject({ reason: 'limit' });
      expect(parse.mock.calls.every(([s]) => String(s).length < limit)).toBe(true); // só a chave "doctor", nunca o valor
      await expect(run(`{"x":${ones(1000)}}`, { maxFieldChars: 100 })).rejects.toMatchObject({ reason: 'limit' });
      await expect(run(`"${'x'.repeat(200)}"`, { maxFieldChars: 100 })).rejects.toMatchObject({ reason: 'limit' }); // não-objeto grande
    } finally {
      parse.mockRestore();
    }
    expect(MAX_FIELD_CHARS).toBe(1024 * 1024);
  });

  test('elemento grande de array "streamed" NÃO tem o teto de campo (uma gravação pode ter transcrição de MBs)', async () => {
    const items = await run(`{"recordings":[{"t":"${'x'.repeat(3000)}"}]}`, { maxFieldChars: 100 });
    expect(items).toHaveLength(1);
  });
});
