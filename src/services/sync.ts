import { supabase } from './supabase';
import { getCurrentUser } from './auth';
import {
  getDb,
  getAllRecordingsMetaRaw,
  getCustomTemplatesRaw,
  setChangeListener,
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

// ─── PUSH ────────────────────────────────────────────────────

/**
 * Envia os metadados das gravações para o Supabase com os campos sensíveis
 * já cifrados (enc1:...) — o servidor nunca recebe PHI em texto puro.
 *
 * Usa getAllRecordingsMetaRaw() para obter os valores AES-256-GCM diretamente
 * do banco local, sem descriptografar.
 */
async function pushRecordings(userId: string): Promise<number> {
  // Raw = valores com prefixo enc1:... (ou texto puro legado) sem decifrar
  const meta = await getAllRecordingsMetaRaw();
  const rows = [];
  for (const [fileName, m] of meta.entries()) {
    const match = fileName.match(/recording_(\d+)\.m4a/);
    const createdAt = match
      ? new Date(parseInt(match[1])).toISOString()
      : new Date().toISOString();
    rows.push({
      user_id: userId,
      file_name: fileName,
      // Campos sensíveis chegam já cifrados — Supabase armazena enc1:...
      custom_name: m.customName,
      transcript: m.transcript,
      summary: m.summary,
      template_id: m.templateId,
      patient_name: m.patientName,
      created_at: createdAt,
      updated_at: m.updatedAt ?? createdAt,
    });
  }
  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from('recordings')
    .upsert(rows, { onConflict: 'user_id,file_name' });
  if (error) throw error;
  return rows.length;
}

async function pushTemplates(userId: string): Promise<number> {
  // Raw = valores com prefixo enc1:... sem decifrar (Supabase armazena ciphertext)
  const templates = await getCustomTemplatesRaw();
  if (templates.length === 0) return 0;
  const rows = templates.map((t) => ({
    user_id: userId,
    id: t.id,
    name: t.name,
    description: t.description,
    system_prompt: t.systemPrompt,
    created_at: t.createdAt,
  }));
  const { error } = await supabase
    .from('custom_templates')
    .upsert(rows, { onConflict: 'user_id,id' });
  if (error) throw error;
  return rows.length;
}

async function pushProfile(userId: string): Promise<boolean> {
  const profile = await getDoctorProfile();
  const hasData = Object.values(profile).some((v) =>
    typeof v === 'boolean' ? v : v.length > 0
  );
  if (!hasData) return false;
  const { error } = await supabase.from('doctor_profiles').upsert({
    user_id: userId,
    name: profile.name,
    title: profile.title,
    crm_number: profile.crmNumber,
    crm_uf: profile.crmUF,
    address: profile.address,
    phone: profile.phone,
    city: profile.city,
    // professional_enabled omitted — coluna ainda não existe no schema do Supabase
  });
  if (error) throw error;
  return true;
}

async function pushAll(userId: string) {
  const [r, t, p] = await Promise.all([
    pushRecordings(userId),
    pushTemplates(userId),
    pushProfile(userId),
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
 */
async function pullRecordings(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('recordings')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  if (!data || data.length === 0) return 0;

  const db = await getDb();
  for (const r of data) {
    // Garante cifração local — encryptIfNeeded é idempotente
    const [customName, transcript, summary, patientName] = await Promise.all([
      r.custom_name  ? encryptIfNeeded(r.custom_name)  : Promise.resolve(null),
      r.transcript   ? encryptIfNeeded(r.transcript)   : Promise.resolve(null),
      r.summary      ? encryptIfNeeded(r.summary)      : Promise.resolve(null),
      r.patient_name ? encryptIfNeeded(r.patient_name) : Promise.resolve(null),
    ]);

    await db.runAsync(
      `INSERT INTO recordings (fileName, customName, transcript, summary, templateId, patientName, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
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
      ]
    );
  }
  return data.length;
}

async function pullTemplates(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('custom_templates')
    .select('*')
    .eq('user_id', userId);
  if (error) throw error;
  if (!data || data.length === 0) return 0;

  const db = await getDb();
  for (const t of data) {
    // Garante cifração local — encryptIfNeeded é idempotente (não cifra duas vezes)
    const [name, description, systemPrompt] = await Promise.all([
      t.name        ? encryptIfNeeded(t.name)        : Promise.resolve(null),
      t.description ? encryptIfNeeded(t.description) : Promise.resolve(null),
      t.system_prompt ? encryptIfNeeded(t.system_prompt) : Promise.resolve(null),
    ]);
    await db.runAsync(
      `INSERT OR REPLACE INTO custom_templates (id, name, description, systemPrompt, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      [t.id, name, description, systemPrompt, t.created_at]
    );
  }
  return data.length;
}

async function pullProfile(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('doctor_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  await setDoctorProfile({
    name: data.name ?? '',
    title: data.title ?? '',
    crmNumber: data.crm_number ?? '',
    crmUF: data.crm_uf ?? '',
    address: data.address ?? '',
    phone: data.phone ?? '',
    city: data.city ?? '',
    professionalEnabled: false, // coluna não existe no Supabase ainda
  });
  return true;
}

async function pullAll(userId: string) {
  const [r, t, p] = await Promise.all([
    pullRecordings(userId),
    pullTemplates(userId),
    pullProfile(userId),
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
  setStatus('syncing');
  try {
    const pulled = await pullAll(user.id);
    const pushed = await pushAll(user.id);
    setStatus('success');
    return { pulled, pushed };
  } catch (err: any) {
    setStatus('error');
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
    setStatus('syncing');
    await pullAll(user.id);
    setStatus('success');
  } catch (err) {
    logError('sync.pull', err);
    setStatus('error');
  }
}

// Push debounced — disparado por mudanças locais
let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function queueSync() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    const user = await getCurrentUser();
    if (!user) return;
    try {
      setStatus('syncing');
      await pushAll(user.id);
      setStatus('success');
      logDebug('sync', 'auto-push concluído');
    } catch (err) {
      logError('sync.autoPush', err);
      setStatus('error');
    }
  }, 3000); // 3 segundos de debounce
}

// Registra os listeners de mudança
setChangeListener(queueSync);
setDoctorChangeListener(queueSync);
