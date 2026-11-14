// sync.ts de ponta a ponta: SQL real (node:sqlite) + cifra real + um "Supabase" em memória
// que o teste controla (recusa exclusão, erro, trava). Tempo falso: nada espera relógio real.
import type { DatabaseSync } from 'node:sqlite';
import type * as SyncModule from '../sync';
import type * as DbModule from '../db';
import type * as CryptoModule from '../db-crypto';
import type * as DoctorModule from '../doctor';

type Row = Record<string, any>;
type Query = {
  op: 'select' | 'delete' | 'upsert';
  payload?: Row | Row[];
  filters: [string, unknown][];
  inCol?: string;
  inVals?: unknown[];
  single?: boolean;
};
type Deferred = { promise: Promise<void>; resolve: () => void };

const USER = 'user-1';
const OWNER_KEY = '@voice_ai_recorder/sync/owner/v1';
const PROF_SYNCED_KEY = '@voice_ai_recorder/sync/profile_prof_synced/v1';
const PK: Record<string, string[]> = {
  recordings: ['user_id', 'file_name'],
  custom_templates: ['user_id', 'id'],
  doctor_profiles: ['user_id'],
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Remoto em memória com ganchos de falha. */
class FakeRemote {
  tables: Record<string, Row[]> = { recordings: [], custom_templates: [], doctor_profiles: [] };
  calls: string[] = [];
  upserts: { table: string; rows: Row[] }[] = [];
  /** true = ignora todos os DELETEs; Set = ignora só essas chaves (o item "volta" no SELECT de verificação). */
  ignoreDeletes: boolean | Set<string> = false;
  failOp?: (op: string, table: string, q: Query) => { message: string } | null;
  /** A próxima operação remota só termina quando o teste liberar. */
  gate?: Deferred;
  noProfessionalColumn = false;

  from(table: string) {
    const q: Query = { op: 'select', filters: [] };
    const api = {
      select: () => { q.op = 'select'; return api; },
      delete: () => { q.op = 'delete'; return api; },
      upsert: (payload: Row | Row[]) => { q.op = 'upsert'; q.payload = payload; return api; },
      eq: (col: string, val: unknown) => { q.filters.push([col, val]); return api; },
      in: (col: string, vals: unknown[]) => { q.inCol = col; q.inVals = vals; return api; },
      maybeSingle: () => { q.single = true; return api; },
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => this.exec(table, q).then(ok, bad),
    };
    return api;
  }

  private match(table: string, q: Query, r: Row) {
    return q.filters.every(([c, v]) => r[c] === v) && (!q.inCol || q.inVals!.includes(r[q.inCol]));
  }

  private async exec(table: string, q: Query) {
    this.calls.push(`${q.op}:${table}`);
    if (this.gate) {
      const g = this.gate;
      this.gate = undefined;
      await g.promise;
    }
    const injected = this.failOp?.(q.op, table, q);
    if (injected) return { data: null, error: injected };
    const rows = this.tables[table];
    if (q.op === 'delete') {
      const keep = (r: Row) => {
        if (this.ignoreDeletes === true) return true;
        const key = r.file_name ?? r.id;
        return this.ignoreDeletes instanceof Set && this.ignoreDeletes.has(key);
      };
      this.tables[table] = rows.filter((r) => !this.match(table, q, r) || keep(r));
      return { data: null, error: null };
    }
    if (q.op === 'upsert') {
      const list = Array.isArray(q.payload) ? q.payload : [q.payload!];
      if (table === 'doctor_profiles' && this.noProfessionalColumn && list.some((r) => 'professional_enabled' in r)) {
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'professional_enabled' column" } };
      }
      this.upserts.push({ table, rows: list.map((r) => ({ ...r })) });
      for (const item of list) {
        const i = rows.findIndex((r) => PK[table].every((k) => r[k] === item[k]));
        if (i >= 0) rows[i] = { ...rows[i], ...item };
        else rows.push({ ...item });
      }
      return { data: null, error: null };
    }
    const found = rows.filter((r) => this.match(table, q, r)).map((r) => ({ ...r }));
    return { data: q.single ? (found[0] ?? null) : found, error: null };
  }
}

declare global {
  var __remote: FakeRemote;
  var __userId: string;
  /** 'never' = supabase.auth.getUser nunca responde; Deferred = responde quando o teste liberar. */
  var __authHang: 'never' | Deferred | undefined;
}

jest.mock('../supabase', () => ({
  __esModule: true,
  supabase: {
    from: (t: string) => globalThis.__remote.from(t),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}));
jest.mock('../auth', () => ({
  __esModule: true,
  getCurrentUser: async () => {
    const hang = globalThis.__authHang;
    if (hang === 'never') await new Promise<never>(() => {});
    else if (hang) await hang.promise;
    return globalThis.__userId ? { id: globalThis.__userId } : null;
  },
}));

interface Env {
  sync: typeof SyncModule;
  db: typeof DbModule;
  crypto: typeof CryptoModule;
  doctor: typeof DoctorModule;
  secure: { setItemAsync(k: string, v: string): Promise<void>; getItemAsync(k: string): Promise<string | null> };
  storage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };
  raw: () => Promise<DatabaseSync>;
}

let remote: FakeRemote;
let env: Env;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2025-06-01T12:00:00.000Z'));
  remote = new FakeRemote();
  globalThis.__remote = remote;
  globalThis.__userId = USER;
  globalThis.__authHang = undefined;
  jest.resetModules();
  const db = jest.requireActual<typeof DbModule>('../db');
  env = {
    sync: jest.requireActual<typeof SyncModule>('../sync'),
    db,
    crypto: jest.requireActual<typeof CryptoModule>('../db-crypto'),
    doctor: jest.requireActual<typeof DoctorModule>('../doctor'),
    secure: jest.requireMock('expo-secure-store'),
    storage: jest.requireMock('@react-native-async-storage/async-storage'),
    raw: async () => ((await db.getDb()) as unknown as { raw: DatabaseSync }).raw,
  };
  // Sem auto-sync de fundo (debounce de 3 s): cada teste dispara o sync que quer.
  db.setChangeListener(null);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(0);
};

/** Linha local direta no SQL (sem passar pelo listener de mudança). */
async function seedLocal(fileName: string, fields: { transcript?: string; summary?: string; updatedAt?: string }, plain = false) {
  const enc = (v?: string) => (v === undefined ? null : plain ? v : env.crypto.encrypt(v));
  const d = await env.db.getDb();
  await d.runAsync(
    'INSERT INTO recordings (fileName, transcript, summary, updatedAt) VALUES (?,?,?,?)',
    [fileName, await enc(fields.transcript), await enc(fields.summary), fields.updatedAt ?? '2025-01-01T00:00:00.000Z']
  );
}

async function seedRemote(fileName: string, transcript: string | null, updatedAt = '2025-01-01T00:00:00.000Z') {
  remote.tables.recordings.push({
    user_id: USER, file_name: fileName, custom_name: null, transcript, summary: null,
    template_id: null, patient_name: null, created_at: updatedAt, updated_at: updatedAt,
  });
}

const localKeys = async () => [...(await env.db.getAllRecordingsMetaRaw()).keys()].sort();
const remoteKeys = (table = 'recordings') => remote.tables[table].map((r) => r.file_name ?? r.id).sort();

describe('flush de exclusões verificado', () => {
  test('exclusão local chega ao remoto, o tombstone só some após confirmação e o pull não ressuscita', async () => {
    await seedLocal('r1.m4a', { transcript: 'a' });
    await seedRemote('r1.m4a', await env.crypto.encrypt('a'));
    await env.db.deleteRecordingMeta('r1.m4a');

    const res = await env.sync.syncNow();

    expect(res.error).toBeUndefined();
    expect(remoteKeys()).toEqual([]);
    expect(await env.db.getPendingDeletions()).toEqual([]);
    expect(await localKeys()).toEqual([]);
    expect(res.pulled.recordings).toBe(0);
  });

  test('remoto NÃO confirma a ausência: tombstone permanece e o item remoto não volta ao aparelho', async () => {
    await seedLocal('r1.m4a', { transcript: 'a' });
    await seedRemote('r1.m4a', await env.crypto.encrypt('a'));
    await env.db.deleteRecordingMeta('r1.m4a');
    remote.ignoreDeletes = true;

    const res = await env.sync.syncNow();

    expect(res.error).toBeUndefined();
    expect((await env.db.getPendingDeletions()).map((p) => p.key)).toEqual(['r1.m4a']);
    expect(await localKeys()).toEqual([]); // pull respeitou o tombstone
    expect(res.pulled.recordings).toBe(0);

    // Quando o remoto passa a aceitar a exclusão, a próxima rodada confirma e limpa.
    remote.ignoreDeletes = false;
    await env.sync.syncNow();
    expect(remoteKeys()).toEqual([]);
    expect(await env.db.getPendingDeletions()).toEqual([]);
  });

  test('confirmação parcial: só os itens ausentes do remoto perdem o tombstone', async () => {
    for (const name of ['r1.m4a', 'r2.m4a']) {
      await seedLocal(name, { transcript: 'x' });
      await seedRemote(name, await env.crypto.encrypt('x'));
      await env.db.deleteRecordingMeta(name);
    }
    remote.ignoreDeletes = new Set(['r2.m4a']);

    await env.sync.syncNow();

    expect((await env.db.getPendingDeletions()).map((p) => p.key)).toEqual(['r2.m4a']);
    expect(await localKeys()).toEqual([]);
  });

  test('erro no DELETE remoto mantém o tombstone mas não bloqueia pull/push das outras gravações', async () => {
    await seedLocal('apagada.m4a', { transcript: 'a' });
    await env.db.deleteRecordingMeta('apagada.m4a');
    await seedLocal('nova.m4a', { transcript: 'b' });
    remote.failOp = (op, table) => (op === 'delete' && table === 'recordings' ? { message: 'RLS negou' } : null);

    const res = await env.sync.syncNow();

    expect(res.error).toBeUndefined();
    expect((await env.db.getPendingDeletions()).map((p) => p.key)).toEqual(['apagada.m4a']);
    expect(remoteKeys()).toEqual(['nova.m4a']);
  });

  test('erro no SELECT de verificação também mantém o tombstone (não assume sucesso do DELETE)', async () => {
    await seedLocal('r1.m4a', { transcript: 'a' });
    await env.db.deleteRecordingMeta('r1.m4a');
    // Só o SELECT de verificação do flush (filtra por chave com .in) falha, sempre.
    remote.failOp = (op, table, q) => (op === 'select' && table === 'recordings' && q.inCol ? { message: 'timeout' } : null);

    await env.sync.syncNow();

    expect((await env.db.getPendingDeletions()).map((p) => p.key)).toEqual(['r1.m4a']);
  });

  test('templates: mesmo contrato (confirmado remove; não confirmado mantém)', async () => {
    const id = await env.db.createCustomTemplate('modelo', '', 'prompt');
    remote.tables.custom_templates.push({ user_id: USER, id, name: 'x', description: null, system_prompt: 'y', created_at: '2025-01-01' });
    await env.db.deleteCustomTemplate(id);
    remote.ignoreDeletes = true;

    await env.sync.syncNow();
    expect((await env.db.getPendingDeletions()).map((p) => p.key)).toEqual([id]);
    expect(await env.db.getCustomTemplates()).toEqual([]); // pull não recriou

    remote.ignoreDeletes = false;
    await env.sync.syncNow();
    expect(await env.db.getPendingDeletions()).toEqual([]);
    expect(remoteKeys('custom_templates')).toEqual([]);
  });

  test('troca de conta: tombstones da conta anterior são descartados e NUNCA apagam dados da nova conta', async () => {
    await env.storage.setItem(OWNER_KEY, 'user-A');
    globalThis.__userId = 'user-B';
    await seedLocal('compartilhado.m4a', { transcript: 'a' });
    await env.db.deleteRecordingMeta('compartilhado.m4a'); // exclusão feita como user-A
    remote.tables.recordings.push({
      user_id: 'user-B', file_name: 'compartilhado.m4a', transcript: null, updated_at: '2025-01-01', created_at: '2025-01-01',
    });

    await env.sync.syncNow();

    expect(remote.calls).not.toContain('delete:recordings');
    expect(remote.tables.recordings.some((r) => r.user_id === 'user-B' && r.file_name === 'compartilhado.m4a')).toBe(true);
    expect(await env.db.getPendingDeletions()).toEqual([]);
    expect(await env.storage.getItem(OWNER_KEY)).toBe('user-B');
  });
});

describe('pull', () => {
  test('não ressuscita item com tombstone pendente, mas traz itens sem tombstone', async () => {
    await seedLocal('apagada.m4a', { transcript: 'a' });
    await env.db.deleteRecordingMeta('apagada.m4a');
    await seedRemote('apagada.m4a', await env.crypto.encrypt('a'));
    await seedRemote('outra.m4a', await env.crypto.encrypt('b'));
    remote.ignoreDeletes = true; // tombstone fica

    const res = await env.sync.syncNow();

    expect(await localKeys()).toEqual(['outra.m4a']);
    expect(res.pulled.recordings).toBe(1);
  });

  test('só aplica remoto estritamente mais novo: dado local mais novo ou igual não é sobrescrito', async () => {
    await seedLocal('local-novo.m4a', { transcript: 'LOCAL-NOVO', updatedAt: '2025-05-01T00:00:00.000Z' });
    await seedLocal('empate.m4a', { transcript: 'LOCAL-EMPATE', updatedAt: '2025-05-01T00:00:00.000Z' });
    await seedLocal('remoto-novo.m4a', { transcript: 'LOCAL-VELHO', updatedAt: '2025-01-01T00:00:00.000Z' });
    await seedRemote('local-novo.m4a', await env.crypto.encrypt('REMOTO-VELHO'), '2025-01-01T00:00:00.000Z');
    await seedRemote('empate.m4a', await env.crypto.encrypt('REMOTO-EMPATE'), '2025-05-01T00:00:00.000Z');
    await seedRemote('remoto-novo.m4a', await env.crypto.encrypt('REMOTO-NOVO'), '2025-05-01T00:00:00.000Z');

    await env.sync.syncNow();

    expect(await env.db.getField('local-novo.m4a', 'transcript')).toBe('LOCAL-NOVO');
    expect(await env.db.getField('empate.m4a', 'transcript')).toBe('LOCAL-EMPATE');
    expect(await env.db.getField('remoto-novo.m4a', 'transcript')).toBe('REMOTO-NOVO');
  });

  test('remoto legado em texto puro é cifrado antes de ir para o disco', async () => {
    await seedRemote('legado.m4a', 'transcrição legada em texto puro');

    await env.sync.syncNow();

    const [row] = (await env.raw()).prepare('SELECT transcript FROM recordings').all() as { transcript: string }[];
    expect(row.transcript).toMatch(/^enc1:/);
    expect(row.transcript).not.toContain('legada');
    expect(await env.db.getField('legado.m4a', 'transcript')).toBe('transcrição legada em texto puro');
  });
});

describe('push', () => {
  test('nunca envia texto puro, mesmo de linha legada não migrada', async () => {
    await seedLocal('legado.m4a', { transcript: 'texto legado sensível', summary: 'resumo legado' }, true);

    await env.sync.syncNow();

    const [row] = remote.tables.recordings;
    expect(row.transcript).toMatch(/^enc1:/);
    expect(row.summary).toMatch(/^enc1:/);
    expect(JSON.stringify(remote.tables)).not.toContain('sensível');
  });

  test('item excluído DEPOIS do snapshot do push não é reenviado (upsert tardio não ressuscita)', async () => {
    await seedLocal('fica.m4a', { transcript: 'a' });
    await seedLocal('some-no-meio.m4a', { transcript: 'b' });
    const original = env.db.getAllRecordingsMetaRaw;
    jest.spyOn(env.db, 'getAllRecordingsMetaRaw').mockImplementation(async () => {
      const snapshot = await original();
      await env.db.deleteRecordingMeta('some-no-meio.m4a'); // usuário apaga enquanto o sync cifra/monta
      return snapshot;
    });

    await env.sync.syncNow();

    expect(remoteKeys()).toEqual(['fica.m4a']);
    expect(remote.upserts.flatMap((u) => u.rows).some((r) => r.file_name === 'some-no-meio.m4a')).toBe(false);
  });

  test('erro de upsert devolve error no SyncResult e status "error" (não finge sucesso)', async () => {
    await seedLocal('r1.m4a', { transcript: 'a' });
    remote.failOp = (op) => (op === 'upsert' ? { message: 'falha de rede' } : null);

    const res = await env.sync.syncNow();

    expect(res.error).toMatch(/falha de rede/);
    expect(env.sync.getSyncStatus().status).toBe('error');
  });
});

describe('mutex e watchdog (25 s)', () => {
  test('dois syncNow simultâneos nunca se sobrepõem: o segundo espera o primeiro terminar', async () => {
    const events: string[] = [];
    env.sync.onSyncChange((s) => events.push(s));
    const gate = deferred();
    remote.gate = gate;

    const p1 = env.sync.syncNow();
    await settle();
    const p2 = env.sync.syncNow();
    await settle();
    expect(events).toEqual(['syncing']); // run 2 ainda não começou

    gate.resolve(); // libera a operação travada do run 1
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(events).toEqual(['syncing', 'success', 'syncing', 'success']);
  });

  test('sync travado é cancelado aos 25 s: erro claro, lock liberado e o próximo sync roda', async () => {
    const gate = deferred();
    remote.gate = gate;
    let settled = false;
    const p1 = env.sync.syncNow().then((r) => { settled = true; return r; });

    await jest.advanceTimersByTimeAsync(24_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const r1 = await p1;

    expect(r1.error).toMatch(/demorou demais/);
    expect(env.sync.getSyncStatus().status).toBe('error');

    const r2 = await env.sync.syncNow(); // lock liberado: não fica preso atrás do run abortado
    expect(r2.error).toBeUndefined();
    expect(env.sync.getSyncStatus().status).toBe('success');
    gate.resolve();
  });

  test('run abortado que "acorda" depois não grava no banco local nem rebaixa o status do run vigente', async () => {
    await seedRemote('fantasma.m4a', await env.crypto.encrypt('x'));
    const gate = deferred();
    remote.gate = gate;
    const p1 = env.sync.syncNow();
    await jest.advanceTimersByTimeAsync(25_000);
    await p1;

    // O run 2 puxa o item; o usuário o exclui; só então o run 1 abortado recebe a resposta antiga.
    expect((await env.sync.syncNow()).error).toBeUndefined();
    expect(await localKeys()).toEqual(['fantasma.m4a']);
    await env.db.getDb().then((d) => d.runAsync('DELETE FROM recordings'));
    await env.db.getDb().then((d) => d.runAsync('DELETE FROM pending_deletions'));
    gate.resolve();
    await settle();

    expect(await localKeys()).toEqual([]);
    expect(env.sync.getSyncStatus().status).toBe('success');
  });

  describe('servidor aceita a conexão e não responde ANTES do lock (G1)', () => {
    const TIMEOUT = /Tempo esgotado/;

    test('syncNow: getUser que nunca responde estoura aos 25 s com erro claro, sem prender status nem mutex', async () => {
      globalThis.__authHang = 'never';
      let settled = false;
      const p1 = env.sync.syncNow().then((r) => { settled = true; return r; });

      await jest.advanceTimersByTimeAsync(24_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const r1 = await p1;

      expect(r1.error).toMatch(TIMEOUT);
      expect(r1.error).toMatch(/demorou demais/);
      expect(env.sync.getSyncStatus().status).toBe('error'); // nunca fica em 'syncing'

      globalThis.__authHang = undefined; // servidor voltou
      const r2 = await env.sync.syncNow();
      expect(r2.error).toBeUndefined();
      expect(env.sync.getSyncStatus().status).toBe('success');
    });

    test('pullOnLogin: getUser que nunca responde resolve aos 25 s (não pendura o login) e o sync seguinte funciona', async () => {
      globalThis.__authHang = 'never';
      let settled = false;
      const p1 = env.sync.pullOnLogin().then(() => { settled = true; });

      await jest.advanceTimersByTimeAsync(24_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await p1;
      expect(settled).toBe(true);
      expect(env.sync.getSyncStatus().status).toBe('error');

      globalThis.__authHang = undefined;
      expect((await env.sync.syncNow()).error).toBeUndefined();
      expect(env.sync.getSyncStatus().status).toBe('success');
    });

    test('queueSync: auto-push com getUser travado estoura aos 25 s (após o debounce de 3 s) e o próximo sync roda', async () => {
      // O beforeEach desliga o listener de mudança; aqui o disparo é direto.
      globalThis.__authHang = 'never';
      env.sync.queueSync();
      await jest.advanceTimersByTimeAsync(3_000 + 24_999);
      expect(env.sync.getSyncStatus().status).toBe('idle');
      await jest.advanceTimersByTimeAsync(1);
      expect(env.sync.getSyncStatus().status).toBe('error');

      globalThis.__authHang = undefined;
      expect((await env.sync.syncNow()).error).toBeUndefined();
      expect(env.sync.getSyncStatus().status).toBe('success');
    });

    test('getUser que responde depois do limite não executa o sync abortado nem assume o lock', async () => {
      const auth = deferred();
      globalThis.__authHang = auth;
      const p1 = env.sync.syncNow();
      await jest.advanceTimersByTimeAsync(25_000);
      expect((await p1).error).toMatch(TIMEOUT);
      expect(env.sync.getSyncStatus().status).toBe('error');

      auth.resolve(); // resposta atrasada do servidor
      await settle();
      expect(remote.calls).toEqual([]); // o run abortado não tocou no remoto
      expect(env.sync.getSyncStatus().status).toBe('error');

      globalThis.__authHang = undefined;
      expect((await env.sync.syncNow()).error).toBeUndefined(); // sem lock preso
    });

    test('espera pelo lock conta no limite total: quem chega depois não ganha um novo prazo de 25 s para esperar', async () => {
      const gate = deferred();
      remote.gate = gate; // run 1 trava dentro do lock
      const p1 = env.sync.syncNow();
      await settle();
      await jest.advanceTimersByTimeAsync(15_000);
      const p2 = env.sync.syncNow(); // chega aos 15 s e espera o lock
      await settle();

      await jest.advanceTimersByTimeAsync(10_000); // 25 s do run 1: ele estoura e libera o lock
      expect((await p1).error).toMatch(TIMEOUT);
      const r2 = await p2; // run 2 assume o lock e termina dentro do seu próprio limite
      expect(r2.error).toBeUndefined();
      expect(env.sync.getSyncStatus().status).toBe('success');
      gate.resolve();
    });
  });
});

describe('perfil: professionalEnabled', () => {
  const remoteProfile = (extra: Row = {}) => ({
    user_id: USER, name: 'Dr. Remoto', title: '', crm_number: '123', crm_uf: 'SP',
    address: '', phone: '', city: '', ...extra,
  });
  async function legacyLocalProfessional() {
    // Perfil criado antes do campo existir no remoto: gravado direto, sem marcar "pendente".
    await env.secure.setItemAsync('doctor_name', 'Dr. Local');
    await env.secure.setItemAsync('doctor_crm_number', '123');
    await env.secure.setItemAsync('profile_professional_enabled', 'true');
  }

  test('FALSE legado do remoto (DEFAULT da coluna) não rebaixa o professionalEnabled=true local; o push corrige o remoto', async () => {
    await legacyLocalProfessional();
    remote.tables.doctor_profiles.push(remoteProfile({ professional_enabled: false }));

    const res = await env.sync.syncNow();

    expect(res.error).toBeUndefined();
    expect((await env.doctor.getDoctorProfile()).professionalEnabled).toBe(true);
    expect(remote.tables.doctor_profiles[0].professional_enabled).toBe(true);
    expect(await env.storage.getItem(PROF_SYNCED_KEY)).toBe(USER);
  });

  test('depois da 1ª sincronização do campo o remoto é autoritativo (false remoto vale)', async () => {
    await legacyLocalProfessional();
    await env.storage.setItem(PROF_SYNCED_KEY, USER);
    remote.tables.doctor_profiles.push(remoteProfile({ professional_enabled: false }));

    await env.sync.syncNow();

    expect((await env.doctor.getDoctorProfile()).professionalEnabled).toBe(false);
  });

  test('schema remoto antigo (sem a coluna): mantém o valor local e envia o resto', async () => {
    await legacyLocalProfessional();
    remote.noProfessionalColumn = true;
    remote.tables.doctor_profiles.push(remoteProfile());

    const res = await env.sync.syncNow();

    expect(res.error).toBeUndefined();
    expect((await env.doctor.getDoctorProfile()).professionalEnabled).toBe(true);
    const sent = remote.upserts.filter((u) => u.table === 'doctor_profiles');
    expect(sent).toHaveLength(1);
    expect('professional_enabled' in sent[0].rows[0]).toBe(false);
    expect(await env.storage.getItem(PROF_SYNCED_KEY)).toBeNull(); // não declara o campo sincronizado
  });

  test('edição local pendente vence o remoto no pull e é enviada no push', async () => {
    remote.tables.doctor_profiles.push(remoteProfile({ name: 'Dr. Remoto', professional_enabled: true }));
    await env.doctor.setDoctorProfile({ name: 'Dr. Editado Agora' }); // listener do sync marca pendente

    await env.sync.syncNow();

    expect((await env.doctor.getDoctorProfile()).name).toBe('Dr. Editado Agora');
    expect(remote.tables.doctor_profiles[0].name).toBe('Dr. Editado Agora');
  });
});
