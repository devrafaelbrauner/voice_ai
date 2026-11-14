import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { getCurrentUser } from './auth';
import {
  getDb,
  getAllRecordingsMetaRaw,
  getCustomTemplatesRaw,
  setChangeListener,
  getPendingDeletions,
  confirmPendingDeletions,
  clearAllPendingDeletions,
  filterLiveKeys,
  type PendingDeletion,
} from './db';
import { encryptIfNeeded } from './db-crypto';
import {
  getDoctorProfile,
  setDoctorProfile,
  setDoctorChangeListener,
} from './doctor';
import { logError, logDebug } from './log';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'success';

export interface SyncResult {
  pushed: { recordings: number; templates: number; profile: boolean };
  pulled: { recordings: number; templates: number; profile: boolean };
  error?: string;
}

let lastSyncAt: Date | null = null;
let currentStatus: SyncStatus = 'idle';
const listeners = new Set<(status: SyncStatus, lastSync: Date | null) => void>();

export function getSyncStatus() {
  return { status: currentStatus, lastSyncAt };
}

export function onSyncChange(
  callback: (status: SyncStatus, lastSync: Date | null) => void
) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function setStatus(s: SyncStatus) {
  currentStatus = s;
  if (s === 'success') lastSyncAt = new Date();
  listeners.forEach((cb) => cb(currentStatus, lastSyncAt));
}

// ─── Mutex + watchdog ────────────────────────────────────────

/** Um sync que passou do watchdog recebe aborted=true e para no próximo checkpoint. */
interface SyncRun {
  aborted: boolean;
}

const SYNC_WATCHDOG_MS = 25_000;

class SyncAbortedError extends Error {
  constructor() {
    super('Sincronização cancelada (tempo excedido).');
    this.name = 'SyncAbortedError';
  }
}

function assertRun(run: SyncRun) {
  if (run.aborted) throw new SyncAbortedError();
}

/** Status só muda se este run ainda é o vigente (run abortado não sobrescreve o status). */
function setRunStatus(run: SyncRun, s: SyncStatus) {
  if (!run.aborted) setStatus(s);
}

/**
 * Status de falha do chamador. Run abortado pelo watchdog (ou que falhou enquanto outro
 * run já assumiu o lock) NÃO sobrescreve o status do run vigente; o erro continua
 * sendo devolvido/logado ao chamador.
 */
function setFailedStatus() {
  if (!activeLock) setStatus('error');
}

let activeLock: { released: Promise<void> } | null = null;

/**
 * Executa `fn` com exclusão mútua (um sync por vez; os demais esperam a vez).
 * Watchdog: após 25 s o lock é liberado, o run é marcado como abortado e quem
 * chamou recebe erro. O run abortado pode ainda ter uma requisição em voo, por isso
 * todo upsert remoto/local confere o tombstone imediatamente antes de gravar.
 */
async function runExclusive<T>(fn: (run: SyncRun) => Promise<T>): Promise<T> {
  while (activeLock) await activeLock.released;
  const run: SyncRun = { aborted: false };
  let release!: () => void;
  const lock = { released: new Promise<void>((r) => { release = r; }) };
  activeLock = lock;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      run.aborted = true;
      logError('sync', `watchdog: sincronização excedeu ${SYNC_WATCHDOG_MS / 1000} s; lock liberado`);
      if (activeLock === lock) activeLock = null;
      release();
      reject(new Error('A sincronização demorou demais (mais de 25 s) e foi cancelada. Tente novamente.'));
    }, SYNC_WATCHDOG_MS);
  });
  try {
    return await Promise.race([fn(run), watchdog]);
  } finally {
    clearTimeout(timer);
    if (activeLock === lock) activeLock = null;
    release();
  }
}

// ─── Escopo por conta ────────────────────────────────────────

const OWNER_KEY = '@voice_ai_recorder/sync/owner/v1';

/**
 * Tombstones pertencem ao remoto da conta que estava ativa quando o item foi
 * excluído. Em troca de conta eles são descartados — nunca apagam dados de outra conta.
 */
async function ensureOwner(userId: string): Promise<void> {
  const stored = await AsyncStorage.getItem(OWNER_KEY);
  if (stored === userId) return;
  if (stored !== null) {
    await clearAllPendingDeletions();
    logDebug('sync', 'conta mudou: tombstones pendentes descartados');
  }
  await AsyncStorage.setItem(OWNER_KEY, userId);
}

// ─── Estado pendente do perfil ───────────────────────────────

const PROFILE_DIRTY_KEY = '@voice_ai_recorder/sync/profile_dirty/v1';
/** userId para o qual professional_enabled já foi enviado (remoto passa a ser autoritativo). */
const PROFILE_PROF_SYNCED_KEY = '@voice_ai_recorder/sync/profile_prof_synced/v1';

let profileDirty: boolean | null = null;
let profileEditSeq = 0;
let applyingRemoteProfile = false;
let notifiesWhileApplying = 0;

async function isProfileDirty(): Promise<boolean> {
  if (profileDirty === null) {
    profileDirty = (await AsyncStorage.getItem(PROFILE_DIRTY_KEY)) === '1';
  }
  return profileDirty;
}

function markProfileDirty() {
  profileEditSeq++;
  profileDirty = true;
  AsyncStorage.setItem(PROFILE_DIRTY_KEY, '1').catch((e) => logError('sync.profileDirty', e));
}

async function clearProfileDirty() {
  profileDirty = false;
  await AsyncStorage.removeItem(PROFILE_DIRTY_KEY);
}

/**
 * Listener do doctor.ts. A escrita do próprio pull dispara exatamente 1 notificação,
 * que é ignorada; qualquer notificação a mais durante a aplicação é edição local concorrente.
 */
function onDoctorChanged() {
  if (applyingRemoteProfile) {
    notifiesWhileApplying++;
    if (notifiesWhileApplying <= 1) return;
  }
  markProfileDirty();
  queueSync();
}

// ─── Exclusões (flush verificado) ────────────────────────────

const DELETE_CHUNK = 100;

const DELETION_TARGETS = [
  { kind: 'recording', table: 'recordings', col: 'file_name' },
  { kind: 'template', table: 'custom_templates', col: 'id' },
] as const;

/**
 * Envia as exclusões locais pendentes ao Supabase. O tombstone só é removido depois
 * que um SELECT confirma que o remoto não tem mais o item. Se não confirmar, o
 * tombstone permanece (e o pull não ressuscita o item) até a próxima tentativa.
 *
 * Erro em um chunk (rede, RLS, coluna) é isolado: o tombstone do chunk é mantido, o erro
 * é logado e o flush segue para os demais chunks — um tombstone com erro persistente
 * nunca bloqueia pull/push. Só o abort do watchdog interrompe o flush.
 */
async function flushDeletions(userId: string, run: SyncRun): Promise<number> {
  const pending = await getPendingDeletions();
  if (pending.length === 0) return 0;
  let confirmed = 0;
  for (const target of DELETION_TARGETS) {
    const items = pending.filter((p) => p.kind === target.kind);
    for (let i = 0; i < items.length; i += DELETE_CHUNK) {
      assertRun(run);
      const chunk = items.slice(i, i + DELETE_CHUNK);
      const keys = chunk.map((c) => c.key);
      try {
        const del = await supabase
          .from(target.table)
          .delete()
          .eq('user_id', userId)
          .in(target.col, keys);
        if (del.error) throw del.error;

        const check = await supabase
          .from(target.table)
          .select(target.col)
          .eq('user_id', userId)
          .in(target.col, keys);
        if (check.error) throw check.error;
        const remaining = new Set(
          ((check.data ?? []) as unknown as Record<string, unknown>[]).map((r) => String(r[target.col]))
        );
        const done: PendingDeletion[] = chunk.filter((c) => !remaining.has(c.key));
        await confirmPendingDeletions(done);
        confirmed += done.length;
        if (remaining.size > 0) {
          logError('sync', `exclusão remota não confirmada para ${remaining.size} item(ns) de ${target.table}; tombstone mantido`);
        }
      } catch (err) {
        if (err instanceof SyncAbortedError) throw err;
        // Sem chaves/dados no log: só tabela, tamanho do chunk e mensagem do erro.
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === 'object' && err !== null && 'message' in err
              ? String(err.message)
              : String(err);
        logError('sync', `flush de exclusões falhou em ${target.table} (${chunk.length} item(ns)); tombstones mantidos: ${msg}`);
      }
    }
  }
  return confirmed;
}

// ─── PUSH ────────────────────────────────────────────────────

/** Cifra se ainda não estiver cifrado; vazio/nulo passa como está. */
const encField = (v: string | null): Promise<string | null> =>
  v ? encryptIfNeeded(v) : Promise.resolve(v);

/** Loga SEM dados clínicos e devolve o erro que aborta o push da tabela (nada é enviado). */
function pushEncryptFailed(table: string, err: unknown): Error {
  logError('sync', `push ${table} abortado: falha ao cifrar (${err instanceof Error ? err.name : 'erro'})`);
  return new Error('Falha ao cifrar dados para sincronização; envio cancelado.');
}

/**
 * Envia os metadados das gravações para o Supabase com os campos sensíveis
 * já cifrados (enc1:...) — o servidor nunca recebe PHI em texto puro.
 *
 * Usa getAllRecordingsMetaRaw() para obter os valores AES-256-GCM diretamente
 * do banco local, sem descriptografar.
 */
async function pushRecordings(userId: string, run: SyncRun): Promise<number> {
  // Raw = valores com prefixo enc1:... (ou texto puro legado) sem decifrar
  const meta = await getAllRecordingsMetaRaw();
  let rows = [];
  try {
    for (const [fileName, m] of meta.entries()) {
      const match = fileName.match(/recording_(\d+)\.m4a/);
      const createdAt = match
        ? new Date(parseInt(match[1])).toISOString()
        : new Date().toISOString();
      // Guard fail-closed: encryptIfNeeded logo antes de montar o payload — nunca
      // envia texto puro, mesmo se a migração v9 falhou. Já cifrados passam intactos.
      const [customName, transcript, summary, patientName] = await Promise.all([
        encField(m.customName),
        encField(m.transcript),
        encField(m.summary),
        encField(m.patientName),
      ]);
      rows.push({
        user_id: userId,
        file_name: fileName,
        custom_name: customName,
        transcript,
        summary,
        template_id: m.templateId,
        patient_name: patientName,
        created_at: createdAt,
        updated_at: m.updatedAt ?? createdAt,
      });
    }
  } catch (err) {
    throw pushEncryptFailed('recordings', err);
  }
  if (rows.length === 0) return 0;
  // Imediatamente antes do upsert: descarta o que foi excluído depois do snapshot
  // (tombstone pendente ou linha sumiu) — um upsert tardio não ressuscita exclusão.
  assertRun(run);
  const live = await filterLiveKeys('recording', rows.map((r) => r.file_name));
  rows = rows.filter((r) => live.has(r.file_name));
  if (rows.length === 0) return 0;
  assertRun(run);
  const { error } = await supabase
    .from('recordings')
    .upsert(rows, { onConflict: 'user_id,file_name' });
  if (error) throw error;
  return rows.length;
}

async function pushTemplates(userId: string, run: SyncRun): Promise<number> {
  // Raw = valores com prefixo enc1:... sem decifrar (Supabase armazena ciphertext)
  const templates = await getCustomTemplatesRaw();
  if (templates.length === 0) return 0;
  let rows;
  try {
    rows = await Promise.all(
      templates.map(async (t) => ({
        user_id: userId,
        id: t.id,
        // Guard fail-closed: nunca envia texto puro, mesmo se a migração v9 falhou.
        name: await encField(t.name),
        description: await encField(t.description),
        system_prompt: await encField(t.systemPrompt),
        created_at: t.createdAt,
      }))
    );
  } catch (err) {
    throw pushEncryptFailed('templates', err);
  }
  assertRun(run);
  const live = await filterLiveKeys('template', rows.map((r) => r.id));
  rows = rows.filter((r) => live.has(r.id));
  if (rows.length === 0) return 0;
  assertRun(run);
  const { error } = await supabase
    .from('custom_templates')
    .upsert(rows, { onConflict: 'user_id,id' });
  if (error) throw error;
  return rows.length;
}

function isMissingProfessionalColumn(err: { code?: string; message?: string }): boolean {
  return err.code === 'PGRST204' || /professional_enabled/i.test(err.message ?? '');
}

async function pushProfile(userId: string, run: SyncRun): Promise<boolean> {
  const seqAtStart = profileEditSeq;
  const dirty = await isProfileDirty();
  const profile = await getDoctorProfile();
  const hasData = Object.values(profile).some((v) =>
    typeof v === 'boolean' ? v : v.length > 0
  );
  if (!hasData && !dirty) return false;
  const base = {
    user_id: userId,
    name: profile.name,
    title: profile.title,
    crm_number: profile.crmNumber,
    crm_uf: profile.crmUF,
    address: profile.address,
    phone: profile.phone,
    city: profile.city,
  };
  assertRun(run);
  let withColumn = true;
  let { error } = await supabase
    .from('doctor_profiles')
    .upsert({ ...base, professional_enabled: profile.professionalEnabled });
  if (error && isMissingProfessionalColumn(error)) {
    // Schema remoto antigo sem a coluna: envia o resto e mantém o valor local autoritativo.
    logError('sync', 'doctor_profiles.professional_enabled ausente no Supabase; aplique a migration');
    withColumn = false;
    ({ error } = await supabase.from('doctor_profiles').upsert(base));
  }
  if (error) throw error;
  // Só zera o pendente se não houve nova edição local durante o envio.
  if (profileEditSeq === seqAtStart) await clearProfileDirty();
  if (withColumn) await AsyncStorage.setItem(PROFILE_PROF_SYNCED_KEY, userId);
  return true;
}

async function pushAll(userId: string, run: SyncRun) {
  const [r, t, p] = await Promise.all([
    pushRecordings(userId, run),
    pushTemplates(userId, run),
    pushProfile(userId, run),
  ]);
  return { recordings: r, templates: t, profile: p };
}

// ─── PULL ────────────────────────────────────────────────────

/**
 * Puxa as gravações do Supabase e garante que os campos sensíveis ficam
 * cifrados no banco local — independentemente de o Supabase armazenar
 * enc1:... (pós-fix) ou texto puro (registros legados anteriores ao fix).
 *
 * encryptIfNeeded() é idempotente: se o valor já tiver prefixo enc1:
 * (mesmo dispositivo que fez o push), não cifra novamente. Se for texto
 * puro legado, cifra antes de salvar.
 *
 * Itens com tombstone pendente NÃO são regravados: a checagem é feita dentro do
 * próprio INSERT (atômica), então uma exclusão concorrente também vence.
 */
async function pullRecordings(userId: string, run: SyncRun): Promise<number> {
  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  if (!data || data.length === 0) return 0;

  const db = await getDb();
  let applied = 0;
  for (const r of data) {
    assertRun(run);
    // Garante cifração local — encryptIfNeeded é idempotente
    const [customName, transcript, summary, patientName] = await Promise.all([
      r.custom_name  ? encryptIfNeeded(r.custom_name)  : Promise.resolve(null),
      r.transcript   ? encryptIfNeeded(r.transcript)   : Promise.resolve(null),
      r.summary      ? encryptIfNeeded(r.summary)      : Promise.resolve(null),
      r.patient_name ? encryptIfNeeded(r.patient_name) : Promise.resolve(null),
    ]);
    assertRun(run);

    const res = await db.runAsync(
      `INSERT INTO recordings (fileName, customName, transcript, summary, templateId, patientName, updatedAt)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM pending_deletions WHERE kind = 'recording' AND key = ?)
       ON CONFLICT(fileName) DO UPDATE SET
         customName = excluded.customName,
         transcript = excluded.transcript,
         summary = excluded.summary,
         templateId = excluded.templateId,
         patientName = excluded.patientName,
         updatedAt = excluded.updatedAt
       WHERE excluded.updatedAt > recordings.updatedAt OR recordings.updatedAt IS NULL`,
      [
        r.file_name,
        customName,
        transcript,
        summary,
        r.template_id,
        patientName,
        r.updated_at,
        r.file_name,
      ]
    );
    if (res.changes > 0) applied++;
  }
  return applied;
}

async function pullTemplates(userId: string, run: SyncRun): Promise<number> {
  const { data, error } = await supabase
    .from('custom_templates')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  if (!data || data.length === 0) return 0;

  const db = await getDb();
  let applied = 0;
  for (const t of data) {
    assertRun(run);
    // Garante cifração local — encryptIfNeeded é idempotente (não cifra duas vezes)
    const [name, description, systemPrompt] = await Promise.all([
      t.name        ? encryptIfNeeded(t.name)        : Promise.resolve(null),
      t.description ? encryptIfNeeded(t.description) : Promise.resolve(null),
      t.system_prompt ? encryptIfNeeded(t.system_prompt) : Promise.resolve(null),
    ]);
    assertRun(run);
    const res = await db.runAsync(
      `INSERT INTO custom_templates (id, name, description, systemPrompt, createdAt)
       SELECT ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM pending_deletions WHERE kind = 'template' AND key = ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         systemPrompt = excluded.systemPrompt,
         createdAt = excluded.createdAt`,
      [t.id, name, description, systemPrompt, t.created_at, t.id]
    );
    if (res.changes > 0) applied++;
  }
  return applied;
}

async function pullProfile(userId: string, run: SyncRun): Promise<boolean> {
  const seqAtStart = profileEditSeq;
  const { data, error } = await supabase
    .from('doctor_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  assertRun(run);

  // Edição local pendente (ou ocorrida durante o pull) vence: será enviada no push.
  if ((await isProfileDirty()) || profileEditSeq !== seqAtStart) {
    logDebug('sync', 'pull do perfil ignorado: edição local pendente');
    return false;
  }

  const local = await getDoctorProfile();
  // Remoto sem a coluna (schema antigo): mantém o valor local.
  const remoteHasFlag = typeof data.professional_enabled === 'boolean';
  let professionalEnabled = remoteHasFlag ? (data.professional_enabled as boolean) : local.professionalEnabled;
  if (remoteHasFlag && (await AsyncStorage.getItem(PROFILE_PROF_SYNCED_KEY)) !== userId) {
    // Primeiro sync com este campo: linhas antigas têm FALSE por DEFAULT, não por escolha.
    // Não rebaixa um `true` local; marca como pendente para o push enviar o valor local.
    if (local.professionalEnabled && !professionalEnabled) {
      professionalEnabled = true;
      markProfileDirty();
      return false;
    }
  }

  // Última checagem antes de gravar (a leitura acima é assíncrona).
  if (profileEditSeq !== seqAtStart || run.aborted) return false;

  applyingRemoteProfile = true;
  notifiesWhileApplying = 0;
  try {
    await setDoctorProfile({
      name: data.name ?? '',
      title: data.title ?? '',
      crmNumber: data.crm_number ?? '',
      crmUF: data.crm_uf ?? '',
      address: data.address ?? '',
      phone: data.phone ?? '',
      city: data.city ?? '',
      professionalEnabled,
    });
  } finally {
    applyingRemoteProfile = false;
  }
  return true;
}

async function pullAll(userId: string, run: SyncRun) {
  const [r, t, p] = await Promise.all([
    pullRecordings(userId, run),
    pullTemplates(userId, run),
    pullProfile(userId, run),
  ]);
  return { recordings: r, templates: t, profile: p };
}

// ─── API pública ────────────────────────────────────────────

export async function syncNow(): Promise<SyncResult> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      pushed: { recordings: 0, templates: 0, profile: false },
      pulled: { recordings: 0, templates: 0, profile: false },
      error: 'Não logado.',
    };
  }
  try {
    return await runExclusive(async (run) => {
      setRunStatus(run, 'syncing');
      await ensureOwner(user.id);
      // Exclusões primeiro: o pull seguinte nunca vê o item remoto que o usuário apagou.
      await flushDeletions(user.id, run);
      const pulled = await pullAll(user.id, run);
      const pushed = await pushAll(user.id, run);
      // Exclusões feitas durante este sync (depois do primeiro flush).
      await flushDeletions(user.id, run);
      setRunStatus(run, 'success');
      return { pulled, pushed };
    });
  } catch (err: any) {
    setFailedStatus();
    return {
      pushed: { recordings: 0, templates: 0, profile: false },
      pulled: { recordings: 0, templates: 0, profile: false },
      error: err?.message ?? String(err),
    };
  }
}

// Pull-only — usado no login e na inicialização do app
export async function pullOnLogin(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;
  try {
    await runExclusive(async (run) => {
      setRunStatus(run, 'syncing');
      await ensureOwner(user.id);
      await flushDeletions(user.id, run);
      await pullAll(user.id, run);
      setRunStatus(run, 'success');
    });
  } catch (err) {
    logError('sync.pull', err);
    setFailedStatus();
  }
}

// Push debounced — disparado por mudanças locais
let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function queueSync() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      const user = await getCurrentUser();
      if (!user) return;
      await runExclusive(async (run) => {
        setRunStatus(run, 'syncing');
        await ensureOwner(user.id);
        await flushDeletions(user.id, run);
        await pushAll(user.id, run);
        await flushDeletions(user.id, run);
        setRunStatus(run, 'success');
      });
      logDebug('sync', 'auto-push concluído');
    } catch (err) {
      logError('sync.autoPush', err);
      setFailedStatus();
    }
  }, 3000); // 3 segundos de debounce
}

// Registra os listeners de mudança
setChangeListener(queueSync);
setDoctorChangeListener(onDoctorChanged);
