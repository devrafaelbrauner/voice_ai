// SQL real (node:sqlite via adaptador do jest.setup.js) + cifra real (db-crypto com chave em
// memória). Cada teste recarrega os módulos: banco :memory: novo, chave nova, sem estado.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gcm } from '@noble/ciphers/aes.js';
import type * as DbModule from '../db';
import type * as CryptoModule from '../db-crypto';

declare global {
  var __nextSqliteDb: DatabaseSync | undefined;
}

let db: typeof DbModule;
let crypto: typeof CryptoModule;

// Registry novo a cada teste (banco/chave/cache de getDb zerados). requireActual em vez de
// import() dinâmico: o jest roda CJS e não aceita import() sem --experimental-vm-modules.
beforeEach(() => {
  jest.resetModules();
  db = jest.requireActual<typeof DbModule>('../db');
  crypto = jest.requireActual<typeof CryptoModule>('../db-crypto');
});

/** Esquema "de fábrica" na versão `version`, como um aparelho que não abriu o app desde então. */
function legacyDb(version: number): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE recordings (
      fileName TEXT PRIMARY KEY, customName TEXT, transcript TEXT, summary TEXT,
      templateId TEXT, patientName TEXT, updatedAt TEXT, durationSecs INTEGER
    );
    CREATE TABLE custom_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      systemPrompt TEXT NOT NULL, createdAt TEXT NOT NULL
    );
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, audio_seconds REAL,
      cost_usd REAL NOT NULL, created_at TEXT NOT NULL
    );
    PRAGMA user_version = ${version};
  `);
  return raw;
}

const userVersion = (raw: DatabaseSync) =>
  (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

/** Linha crua, como está no disco (campos sensíveis cifrados). */
async function rawRow(fileName: string) {
  const d = await db.getDb();
  return d.getFirstAsync<Record<string, string | null>>(
    'SELECT * FROM recordings WHERE fileName = ?',
    [fileName]
  );
}

async function insertRecording(fileName: string, fields: Record<string, string | null> = {}) {
  const d = await db.getDb();
  const cols = ['fileName', ...Object.keys(fields), 'updatedAt'];
  const vals = [fileName, ...Object.values(fields), '2025-01-01T00:00:00.000Z'];
  await d.runAsync(
    `INSERT INTO recordings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    vals
  );
}

describe('migração para v10 (tombstones) sem perder dados', () => {
  test('v6 com texto puro: vira cifrado, continua legível e o esquema v10 existe', async () => {
    const raw = legacyDb(6);
    raw
      .prepare(
        'INSERT INTO recordings (fileName, customName, transcript, summary, patientName, updatedAt, durationSecs) VALUES (?,?,?,?,?,?,?)'
      )
      .run('recording_1.m4a', 'Consulta Joana', 'queixa de dor lombar', 'Resumo: lombalgia', 'Joana Silva', '2025-01-01T00:00:00.000Z', 42);
    raw
      .prepare('INSERT INTO custom_templates (id, name, description, systemPrompt, createdAt) VALUES (?,?,?,?,?)')
      .run('custom_1', 'Meu modelo', 'desc', 'prompt secreto do consultório', '2025-01-01T00:00:00.000Z');
    globalThis.__nextSqliteDb = raw;

    await db.getDb();

    expect(userVersion(raw)).toBe(10);
    // Nada em texto puro no disco.
    const dump = JSON.stringify(raw.prepare('SELECT * FROM recordings').all()) +
      JSON.stringify(raw.prepare('SELECT * FROM custom_templates').all());
    for (const secret of ['dor lombar', 'lombalgia', 'Joana', 'prompt secreto', 'Meu modelo']) {
      expect(dump).not.toContain(secret);
    }
    // ...e o app continua lendo tudo igual.
    expect(await db.getField('recording_1.m4a', 'transcript')).toBe('queixa de dor lombar');
    expect(await db.getField('recording_1.m4a', 'patientName')).toBe('Joana Silva');
    expect(await db.getField('recording_1.m4a', 'durationSecs')).toBe(42);
    const [tpl] = await db.getCustomTemplates();
    expect(tpl).toMatchObject({ id: 'custom_1', name: 'Meu modelo', systemPrompt: 'prompt secreto do consultório' });
    // Migração não fabrica tombstone.
    expect(await db.getPendingDeletions()).toEqual([]);
  });

  test('v9 já cifrado: dados e ciphertext intactos; só o esquema de tombstone é acrescentado', async () => {
    const raw = legacyDb(9);
    const encTranscript = await crypto.encrypt('evolução do paciente');
    const encSummary = await crypto.encrypt('resumo clínico');
    raw
      .prepare('INSERT INTO recordings (fileName, transcript, summary, updatedAt) VALUES (?,?,?,?)')
      .run('recording_9.m4a', encTranscript, encSummary, '2025-02-02T00:00:00.000Z');
    globalThis.__nextSqliteDb = raw;

    await db.getDb();

    expect(userVersion(raw)).toBe(10);
    const row = raw.prepare('SELECT transcript, summary FROM recordings').get() as Record<string, string>;
    expect(row.transcript).toBe(encTranscript); // não recifrou
    expect(row.summary).toBe(encSummary);
    expect(await db.getField('recording_9.m4a', 'transcript')).toBe('evolução do paciente');
    const objects = raw
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('pending_deletions','recordings_tombstone_ad','custom_templates_tombstone_ad')")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(objects).toEqual(['custom_templates_tombstone_ad', 'pending_deletions', 'recordings_tombstone_ad']);
  });

  test('cifra falha (chave indisponível): getDb abre, user_version NÃO avança, mas exclusões já geram tombstone', async () => {
    const raw = legacyDb(6);
    raw
      .prepare('INSERT INTO recordings (fileName, transcript, updatedAt) VALUES (?,?,?)')
      .run('recording_x.m4a', 'texto legado', '2025-01-01T00:00:00.000Z');
    globalThis.__nextSqliteDb = raw;
    const SecureStore = jest.requireMock('expo-secure-store');
    const original = SecureStore.getItemAsync;
    jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValue(new Error('keystore indisponível'));

    await db.getDb();
    expect(userVersion(raw)).toBe(6);
    // Texto legado segue legível (decrypt aceita texto puro) — nada foi destruído.
    jest.spyOn(SecureStore, 'getItemAsync').mockImplementation(original);
    expect(await db.getField('recording_x.m4a', 'transcript')).toBe('texto legado');

    await db.deleteRecordingMeta('recording_x.m4a');
    expect(await db.getPendingDeletions()).toEqual([
      expect.objectContaining({ kind: 'recording', key: 'recording_x.m4a' }),
    ]);
  });
});

describe('tombstones de exclusão', () => {
  test('DELETE de gravação e de template grava tombstone com o tipo certo', async () => {
    await db.setField('recording_a.m4a', 'transcript', 'a');
    const id = await db.createCustomTemplate('modelo', '', 'prompt');
    await db.deleteRecordingMeta('recording_a.m4a');
    await db.deleteCustomTemplate(id);

    const pending = await db.getPendingDeletions();
    expect(pending.map((p) => [p.kind, p.key]).sort()).toEqual(
      [['recording', 'recording_a.m4a'], ['template', id]].sort()
    );
    expect(pending.every((p) => /^\d{4}-\d\d-\d\dT/.test(p.deletedAt))).toBe(true);
  });

  test('INSERT OR REPLACE (pull/restore) NÃO gera tombstone, nem ao sobrescrever linha existente', async () => {
    await insertRecording('recording_b.m4a', { transcript: 'v1' });
    const d = await db.getDb();
    await d.runAsync(
      "INSERT OR REPLACE INTO recordings (fileName, transcript, updatedAt) VALUES ('recording_b.m4a', 'v2', '2025-03-03')"
    );
    await d.runAsync(
      "INSERT OR REPLACE INTO recordings (fileName, transcript, updatedAt) VALUES ('recording_novo.m4a', 'n', '2025-03-03')"
    );
    expect(await db.getPendingDeletions()).toEqual([]);
  });

  test('INSERT direto de um nome com tombstone NÃO apaga o tombstone (sem trigger AFTER INSERT cega)', async () => {
    await insertRecording('recording_k.m4a', { transcript: 'a' });
    await db.deleteRecordingMeta('recording_k.m4a');
    const before = await db.getPendingDeletions();

    await insertRecording('recording_k.m4a', { transcript: 'recriada por caminho legado' });

    expect(await db.getPendingDeletions()).toEqual(before);
    expect(await db.recordingRowLive('recording_k.m4a')).toBe(false); // linha existe, mas tombstone a mantém "excluída"
  });

  test('limpar o último campo de uma gravação apaga a linha e gera tombstone (e some do filterLiveKeys)', async () => {
    await db.setField('recording_c.m4a', 'customName', 'Nome');
    await db.clearField('recording_c.m4a', 'customName');
    expect(await rawRow('recording_c.m4a')).toBeNull();
    expect((await db.getPendingDeletions()).map((p) => p.key)).toEqual(['recording_c.m4a']);
  });

  test('confirmPendingDeletions só remove o tombstone confirmado; re-exclusão mais nova sobrevive', async () => {
    await insertRecording('recording_d.m4a', { transcript: 't' });
    await insertRecording('recording_e.m4a', { transcript: 't' });
    await db.deleteRecordingMeta('recording_d.m4a');
    await db.deleteRecordingMeta('recording_e.m4a');
    const snapshot = await db.getPendingDeletions();
    expect(snapshot).toHaveLength(2);

    // Entre o flush e a confirmação, d foi recriado e excluído de novo (tombstone mais novo).
    const d = await db.getDb();
    await d.runAsync(
      "UPDATE pending_deletions SET deletedAt = '2099-01-01T00:00:00.000Z' WHERE key = 'recording_d.m4a'"
    );
    await db.confirmPendingDeletions(snapshot);

    expect((await db.getPendingDeletions()).map((p) => p.key)).toEqual(['recording_d.m4a']);
  });

  test('clearAllPendingDeletions (troca de conta) zera todos', async () => {
    await insertRecording('recording_f.m4a', { transcript: 't' });
    await db.deleteRecordingMeta('recording_f.m4a');
    await db.clearAllPendingDeletions();
    expect(await db.getPendingDeletions()).toEqual([]);
  });

  test('filterLiveKeys: só chaves com linha e sem tombstone; resultado correto com muitas chaves', async () => {
    await insertRecording('live.m4a', { transcript: 't' });
    await insertRecording('dead.m4a', { transcript: 't' });
    await db.deleteRecordingMeta('dead.m4a');
    const many = Array.from({ length: 900 }, (_, i) => `ghost_${i}.m4a`);
    const live = await db.filterLiveKeys('recording', ['live.m4a', 'dead.m4a', 'never.m4a', ...many, 'live.m4a']);
    expect([...live]).toEqual(['live.m4a']);

    // Linha existente na posição > 400 também é encontrada (chunking não perde chaves).
    await insertRecording('late.m4a', { transcript: 't' });
    const live2 = await db.filterLiveKeys('recording', [...many, 'late.m4a']);
    expect([...live2]).toEqual(['late.m4a']);
  });

  test('filterLiveKeys nunca manda mais de ~401 parâmetros por SQL (limite de variáveis do SQLite do aparelho)', async () => {
    // O node:sqlite aceita milhares de variáveis, então só olhar o resultado não pega a falta de chunk:
    // o contrato é o tamanho de cada chamada (o SQLite embarcado no Android antigo limita a 999).
    const d = await db.getDb();
    const spy = jest.spyOn(d, 'getAllAsync');
    const keys = Array.from({ length: 1234 }, (_, i) => `ghost_${i}.m4a`);

    await db.filterLiveKeys('recording', keys);

    const sentParams = spy.mock.calls.map(([, params]) => (Array.isArray(params) ? params : []));
    const sizes = sentParams.map((p) => p.length);
    expect(sizes.length).toBeGreaterThanOrEqual(4); // 1234 chaves → 4 consultas
    expect(Math.max(...sizes)).toBeLessThanOrEqual(401); // 400 chaves + o `kind`
    // Nenhuma chave some nem se repete entre os pedaços (o último parâmetro é o `kind`).
    const sent = sentParams.flatMap((p) => p.slice(0, -1));
    expect(sent).toEqual(keys);
    spy.mockRestore();
  });
});

describe('setField / updateFieldIfExists não ressuscitam gravação excluída', () => {
  test('setField com tombstone: não grava, retorna false, não recria a linha e não dispara auto-sync', async () => {
    await db.setField('recording_g.m4a', 'transcript', 'conteúdo clínico');
    await db.deleteRecordingMeta('recording_g.m4a');
    const onChange = jest.fn();
    db.setChangeListener(onChange);

    const ok = await db.setField('recording_g.m4a', 'transcript', 'escrita tardia');

    expect(ok).toBe(false);
    expect(await rawRow('recording_g.m4a')).toBeNull();
    expect(await db.recordingRowLive('recording_g.m4a')).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('setField cria a linha na primeira gravação, atualiza depois, e cifra campo sensível no disco', async () => {
    expect(await db.setField('recording_h.m4a', 'transcript', 'segredo clínico')).toBe(true);
    expect(await db.setField('recording_h.m4a', 'durationSecs', '12')).toBe(true);
    expect(await db.setField('recording_h.m4a', 'transcript', 'segredo v2')).toBe(true);

    const row = await rawRow('recording_h.m4a');
    expect(row?.transcript).toMatch(/^enc1:/);
    expect(JSON.stringify(row)).not.toContain('segredo');
    expect(await db.getField('recording_h.m4a', 'transcript')).toBe('segredo v2');
    const d = await db.getDb();
    expect(await d.getFirstAsync('SELECT COUNT(*) AS n FROM recordings')).toEqual({ n: 1 });
  });

  test('updateFieldIfExists: linha viva atualiza; sem linha NUNCA recria (tombstone já confirmado)', async () => {
    await db.setField('recording_i.m4a', 'transcript', 'texto');
    expect(await db.updateFieldIfExists('recording_i.m4a', 'summary', 'resumo')).toBe(true);
    expect(await db.getField('recording_i.m4a', 'summary')).toBe('resumo');

    // Exclusão durante o processamento; o sync já confirmou e apagou o tombstone.
    await db.deleteRecordingMeta('recording_i.m4a');
    await db.confirmPendingDeletions(await db.getPendingDeletions());
    expect(await db.getPendingDeletions()).toEqual([]);

    expect(await db.updateFieldIfExists('recording_i.m4a', 'summary', 'resumo tardio com PHI')).toBe(false);
    expect(await rawRow('recording_i.m4a')).toBeNull();
    expect(await db.recordingRowLive('recording_i.m4a')).toBe(false);
  });

  test('updateFieldIfExists com tombstone pendente e linha ainda presente (re-criada por pull antigo) não grava', async () => {
    await insertRecording('recording_j.m4a', { transcript: 't' });
    const d = await db.getDb();
    await d.runAsync(
      "INSERT INTO pending_deletions (kind, key, deletedAt) VALUES ('recording', 'recording_j.m4a', '2025-01-01T00:00:00.000Z')"
    );
    expect(await db.updateFieldIfExists('recording_j.m4a', 'summary', 'x')).toBe(false);
    expect((await rawRow('recording_j.m4a'))?.summary).toBeNull();
  });
});

describe('resumo por contagem SQL', () => {
  test('getBackupCounts: vazio não é transcrito; finalizada exige transcrição E resumo; templates contados', async () => {
    await insertRecording('r1.m4a', { transcript: 'enc', summary: 'enc' }); // finalizada
    await insertRecording('r2.m4a', { transcript: 'enc' }); // só transcrita
    await insertRecording('r3.m4a', { transcript: '', summary: 'enc' }); // transcrição vazia
    await insertRecording('r4.m4a', { customName: 'enc' }); // só nome
    await db.createCustomTemplate('t1', '', 'p1');
    await db.createCustomTemplate('t2', 'd', 'p2');

    expect(await db.getBackupCounts()).toEqual({ recordings: 4, transcribed: 2, finalized: 1, templates: 2 });
  });

  test('getBackupCounts em banco vazio devolve zeros (sem null/NaN)', async () => {
    expect(await db.getBackupCounts()).toEqual({ recordings: 0, transcribed: 0, finalized: 0, templates: 0 });
  });

  test('exclusão reduz a contagem imediatamente', async () => {
    await db.setField('r1.m4a', 'transcript', 'a');
    await db.setField('r2.m4a', 'transcript', 'b');
    await db.deleteRecordingMeta('r1.m4a');
    expect((await db.getBackupCounts()).recordings).toBe(1);
  });
});

describe('db-crypto com AES-GCM nativo (formato enc1:iv:ct inalterado)', () => {
  // Gerado pelo db-crypto ANTERIOR (@noble/ciphers em JS): chave fixa + valores cifrados.
  const FIXTURE: { keyB64: string; cases: { plain: string; stored: string }[] } = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'db-crypto-noble.json'), 'utf8')
  );
  const secureStore = () => jest.requireMock('expo-secure-store').__store as Map<string, string>;
  const nativeMock = () =>
    jest.requireMock('react-native-quick-crypto') as { createCipheriv: jest.Mock; createDecipheriv: jest.Mock };

  test('valores cifrados pelo código antigo (@noble) continuam abrindo com a mesma chave', async () => {
    secureStore().set('db_aes_key_v1', FIXTURE.keyB64);
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(4);
    for (const { plain, stored } of FIXTURE.cases) {
      expect(stored.startsWith('enc1:')).toBe(true);
      expect(await crypto.decrypt(stored)).toBe(plain);
    }
  });

  test('valores cifrados pelo código nativo abrem na referência @noble (mesmo layout iv + ciphertext||tag)', async () => {
    secureStore().set('db_aes_key_v1', FIXTURE.keyB64);
    const key = Buffer.from(FIXTURE.keyB64, 'base64');
    for (const plain of ['', 'evolução 😀 do paciente', 'y'.repeat(3000)]) {
      const stored = await crypto.encrypt(plain);
      const [, ivB64, ctB64] = stored.split(':');
      const out = gcm(key, Buffer.from(ivB64, 'base64')).decrypt(Buffer.from(ctB64, 'base64'));
      expect(new TextDecoder().decode(out)).toBe(plain);
    }
  });

  /** enc1 com a chave da fixture para BYTES arbitrários (inclusive UTF-8 inválido), cifrado por node:crypto. */
  const sealBytes = (keyB64: string, bytes: Uint8Array): string => {
    const nodeCrypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const iv = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
    const ct = Buffer.concat([c.update(bytes), c.final(), c.getAuthTag()]);
    return `enc1:${iv.toString('base64')}:${ct.toString('base64')}`;
  };

  test('UTF-8/multibyte/emoji: round-trip exato, sem TextDecoder (que é JS no Hermes) e sem perder BOM/U+FFFD/NUL', async () => {
    secureStore().set('db_aes_key_v1', FIXTURE.keyB64);
    const decoder = jest.spyOn(globalThis, 'TextDecoder').mockImplementation(() => {
      throw new Error('TextDecoder não pode estar no caminho de decifra');
    });
    try {
      const samples = [
        '',
        'ação — não há 😀 👨‍⚕️',
        '中文 日本語 한국어 العربية',
        'a\u0000b',
        '\ufeffcom BOM no início', // o TextDecoder descartaria; o dado do usuário tem que voltar igual
        'U+FFFD legítimo: \ufffd',
        '\u{10ffff}\u{10000}',
        'x'.repeat(4500) + 'é',
      ];
      for (const plain of samples) expect(await crypto.decrypt(await crypto.encrypt(plain))).toBe(plain);
      // surrogate solto: o TextEncoder já o troca por U+FFFD ao cifrar (comportamento mantido)
      expect(await crypto.decrypt(await crypto.encrypt('a\ud800b'))).toBe('a\ufffdb');
      const { bufferToString } = jest.requireMock('react-native-quick-crypto') as { bufferToString: jest.Mock };
      expect(bufferToString).toHaveBeenCalled(); // o caminho novo é o conversor nativo
    } finally {
      decoder.mockRestore();
    }
  });

  test('UTF-8 inválido autenticado pelo GCM é rejeitado (vira sentinel, nunca texto com U+FFFD)', async () => {
    secureStore().set('db_aes_key_v1', FIXTURE.keyB64);
    const invalid: [string, number[]][] = [
      ['byte de continuação solto', [0x61, 0x80, 0x62]],
      ['0xFF', [0xff]],
      ['sequência truncada no fim', [0x61, 0xe2, 0x82]],
      ['lead sem continuação', [0xc3, 0x28]],
      ['overlong de "/" (C0 AF)', [0xc0, 0xaf]],
      ['overlong de 3 bytes (E0 80 AF)', [0xe0, 0x80, 0xaf]],
      ['surrogate em UTF-8 (ED A0 80)', [0xed, 0xa0, 0x80]],
      ['acima de U+10FFFF (F4 90 80 80)', [0xf4, 0x90, 0x80, 0x80]],
      ['F5 inválido', [0xf5, 0x80, 0x80, 0x80]],
      ['U+FFFD como bytes inválidos que decodificariam igual ao tamanho', [0xe0, 0x80, 0x80]],
    ];
    for (const [label, bytes] of invalid) {
      const stored = sealBytes(FIXTURE.keyB64, Uint8Array.from(bytes));
      expect([label, await crypto.decrypt(stored)]).toEqual([label, crypto.DECRYPT_FAILED_SENTINEL]);
    }
    // Válido logo ao lado do inválido continua abrindo (a checagem não é cega).
    expect(await crypto.decrypt(sealBytes(FIXTURE.keyB64, Buffer.from('ok é 😀', 'utf8')))).toBe('ok é 😀');
  });

  test('a conferência é por CONTEÚDO, não só por tamanho: decodificador que devolve texto de mesmo tamanho porém diferente é rejeitado', async () => {
    secureStore().set('db_aes_key_v1', FIXTURE.keyB64);
    const stored = await crypto.encrypt('abc');
    const { bufferToString } = jest.requireMock('react-native-quick-crypto') as { bufferToString: jest.Mock };
    bufferToString.mockImplementationOnce(() => 'abd'); // p.ex. um U+FFFD único no lugar de 3 bytes inválidos
    expect(await crypto.decrypt(stored)).toBe(crypto.DECRYPT_FAILED_SENTINEL);
    expect(await crypto.decrypt(stored)).toBe('abc');
  });

  test('chave errada ou dado adulterado continua dando o sentinel (nunca lança)', async () => {
    secureStore().set('db_aes_key_v1', Buffer.alloc(32, 1).toString('base64'));
    const { stored } = FIXTURE.cases[2];
    expect(await crypto.decrypt(stored)).toBe(crypto.DECRYPT_FAILED_SENTINEL);
    secureStore().set('db_aes_key_v1', FIXTURE.keyB64);
    jest.resetModules();
    const c2 = jest.requireActual<typeof CryptoModule>('../db-crypto');
    expect(await c2.decrypt(`${stored.slice(0, -6)}AAAA==`)).toBe(c2.DECRYPT_FAILED_SENTINEL);
    expect(await c2.decrypt('enc1:semdoispontos')).toBe('enc1:semdoispontos');
    expect(await c2.decrypt('enc1:AAAA:AAAA')).toBe(c2.DECRYPT_FAILED_SENTINEL);
  });

  test('módulo nativo ausente: encrypt/decrypt de valor cifrado falham com erro claro (não viram sentinel); texto puro segue legível', async () => {
    secureStore().set('db_aes_key_v1', FIXTURE.keyB64);
    const missing = () => { throw new Error('Nitro: HybridObject CipherFactory not found'); };
    nativeMock().createCipheriv.mockImplementationOnce(missing);
    await expect(crypto.encrypt('x')).rejects.toThrow(/criptografia nativa/i);
    nativeMock().createCipheriv.mockImplementationOnce(missing);
    await expect(crypto.decrypt(FIXTURE.cases[1].stored)).rejects.toThrow(/criptografia nativa/i);
    // Legado em texto puro não precisa do módulo nativo.
    nativeMock().createCipheriv.mockImplementationOnce(missing);
    expect(await crypto.decrypt('texto legado')).toBe('texto legado');
  });

  test('lote de ~2800 campos (700 linhas x 4) cifra e decifra via JSI síncrono sem estourar o tempo', async () => {
    secureStore().set('db_aes_key_v1', FIXTURE.keyB64);
    const field = 'Paciente relata cefaleia há três dias, sem febre. '.repeat(8); // ~400 B
    const t0 = Date.now();
    const stored = await Promise.all(Array.from({ length: 2800 }, () => crypto.encrypt(field)));
    const plain = await Promise.all(stored.map((s) => crypto.decrypt(s)));
    expect(plain.every((p) => p === field)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
