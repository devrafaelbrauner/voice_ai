import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { encrypt, decrypt, encryptIfNeeded } from './db-crypto';
import { logDebug, logError } from './log';

const DB_NAME = 'voice-ai-recorder.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

// ─── Change notification (para auto-sync) ───────────────────
let changeListener: (() => void) | null = null;

export function setChangeListener(cb: (() => void) | null) {
  changeListener = cb;
}

function notifyChange() {
  try {
    changeListener?.();
  } catch {}
}



export interface RecordingMeta {
  fileName: string;
  customName: string | null;
  transcript: string | null;
  summary: string | null;
  templateId: string | null;
  patientName: string | null;
  durationSecs: number | null;
  updatedAt: string | null;
}

type Field = 'customName' | 'transcript' | 'summary' | 'templateId' | 'patientName' | 'durationSecs';

// Campos que contêm dados clínicos sensíveis e são cifrados com AES-256-GCM
const SENSITIVE_FIELDS: Field[] = ['transcript', 'summary', 'patientName', 'customName'];

export const getDb = async (): Promise<SQLite.SQLiteDatabase> => {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS recordings (
          fileName TEXT PRIMARY KEY,
          customName TEXT,
          transcript TEXT,
          summary TEXT,
          templateId TEXT,
          patientName TEXT,
          updatedAt TEXT
        );
      `);
      await runMigrations(db);
      return db;
    })();
  }
  return dbPromise;
};

async function runMigrations(db: SQLite.SQLiteDatabase) {
  const result = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version'
  );
  const currentVersion = result?.user_version ?? 0;

  if (currentVersion < 1) {
    await migrateFromSecureStore(db);
    await db.execAsync('PRAGMA user_version = 1');
  }
  if (currentVersion < 2) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS custom_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        systemPrompt TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
    `);
    await db.execAsync('PRAGMA user_version = 2');
    logDebug('DB', 'Tabela custom_templates criada');
  }
  if (currentVersion < 3) {
    // Adiciona coluna patientName se ainda não existir
    try {
      await db.execAsync('ALTER TABLE recordings ADD COLUMN patientName TEXT;');
    } catch {
      // Coluna já existe (CREATE TABLE acima já cria em DBs novos)
    }
    await populatePatientNames(db);
    await db.execAsync('PRAGMA user_version = 3');
    logDebug('DB', 'Coluna patientName adicionada e populada');
  }
  if (currentVersion < 4) {
    // Tabela de uso/custo da API OpenAI
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        audio_seconds REAL,
        cost_usd REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api_usage_created_at_idx ON api_usage (created_at);
      CREATE INDEX IF NOT EXISTS api_usage_operation_idx ON api_usage (operation);
    `);
    await db.execAsync('PRAGMA user_version = 4');
    logDebug('DB', 'Tabela api_usage criada');
  }
  if (currentVersion < 5) {
    // Backfill: estima custos das gravações existentes
    await backfillApiUsage(db);
    await db.execAsync('PRAGMA user_version = 5');
    logDebug('DB', 'Backfill de api_usage concluído');
  }
  if (currentVersion < 6) {
    try {
      await db.execAsync('ALTER TABLE recordings ADD COLUMN durationSecs INTEGER;');
    } catch {
      // Coluna já existe
    }
    await db.execAsync('PRAGMA user_version = 6');
    logDebug('DB', 'Coluna durationSecs adicionada');
  }
  if (currentVersion < 7) {
    // Criptografa dados sensíveis já existentes no banco (migração one-shot)
    const rows = await db.getAllAsync<{
      fileName: string;
      transcript: string | null;
      summary: string | null;
      patientName: string | null;
      customName: string | null;
    }>('SELECT fileName, transcript, summary, patientName, customName FROM recordings');

    for (const r of rows) {
      const [transcript, summary, patientName, customName] = await Promise.all([
        r.transcript ? encryptIfNeeded(r.transcript) : null,
        r.summary    ? encryptIfNeeded(r.summary)    : null,
        r.patientName ? encryptIfNeeded(r.patientName) : null,
        r.customName  ? encryptIfNeeded(r.customName)  : null,
      ]);
      await db.runAsync(
        `UPDATE recordings
           SET transcript = ?, summary = ?, patientName = ?, customName = ?
         WHERE fileName = ?`,
        [transcript, summary, patientName, customName, r.fileName]
      );
    }

    await db.execAsync('PRAGMA user_version = 7');
    logDebug('DB', `Migration v7: ${rows.length} gravações cifradas com AES-256-GCM`);
  }
  if (currentVersion < 8) {
    // Criptografa campos sensíveis dos templates customizados (name, description, systemPrompt)
    const tmplRows = await db.getAllAsync<{
      id: string;
      name: string | null;
      description: string | null;
      systemPrompt: string | null;
    }>('SELECT id, name, description, systemPrompt FROM custom_templates');

    for (const t of tmplRows) {
      const [name, description, systemPrompt] = await Promise.all([
        t.name        ? encryptIfNeeded(t.name)        : Promise.resolve(null),
        t.description ? encryptIfNeeded(t.description) : Promise.resolve(null),
        t.systemPrompt ? encryptIfNeeded(t.systemPrompt) : Promise.resolve(null),
      ]);
      await db.runAsync(
        'UPDATE custom_templates SET name = ?, description = ?, systemPrompt = ? WHERE id = ?',
        [name, description, systemPrompt, t.id]
      );
    }

    await db.execAsync('PRAGMA user_version = 8');
    logDebug('DB', `Migration v8: ${tmplRows.length} templates cifrados com AES-256-GCM`);
  }
}

async function backfillApiUsage(db: SQLite.SQLiteDatabase) {
  // Só roda se a tabela estiver vazia (primeira execução pós-criação)
  const existing = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM api_usage'
  );
  if ((existing?.count ?? 0) > 0) {
    logDebug('DB', 'api_usage já tem dados, pulando backfill');
    return;
  }

  const dir = FileSystem.documentDirectory;
  if (!dir) return;

  const rows = await db.getAllAsync<{
    fileName: string;
    transcript: string | null;
    summary: string | null;
  }>(
    'SELECT fileName, transcript, summary FROM recordings WHERE transcript IS NOT NULL OR summary IS NOT NULL'
  );

  let whisperLogged = 0;
  let chatLogged = 0;

  for (const r of rows) {
    // Extrai data da gravação do filename
    const match = r.fileName.match(/recording_(\d+)\.m4a/);
    const createdAt = match
      ? new Date(parseInt(match[1])).toISOString()
      : new Date().toISOString();

    // Whisper backfill: estima segundos pelo tamanho do arquivo (m4a ~16KB/s)
    if (r.transcript) {
      try {
        const info = await FileSystem.getInfoAsync(`${dir}${r.fileName}`);
        if (info.exists && 'size' in info && typeof info.size === 'number') {
          const audioSeconds = Math.max(1, info.size / 16000);
          const minutes = audioSeconds / 60;
          const costUSD = minutes * 0.006;
          await db.runAsync(
            `INSERT INTO api_usage (operation, model, audio_seconds, cost_usd, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            ['whisper', 'whisper-1', audioSeconds, costUSD, createdAt]
          );
          whisperLogged++;
        }
      } catch {
        // arquivo não existe mais — pula
      }
    }

    // Chat backfill: estima tokens pelo length do texto (~4 chars/token)
    if (r.summary && r.transcript) {
      const inputTokens = Math.ceil((r.transcript.length + 200) / 4); // +200 do system prompt
      const outputTokens = Math.ceil(r.summary.length / 4);
      // Assume gpt-4o-mini (padrão histórico do app)
      const costUSD =
        (inputTokens / 1_000_000) * 0.15 +
        (outputTokens / 1_000_000) * 0.6;
      await db.runAsync(
        `INSERT INTO api_usage (operation, model, input_tokens, output_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['chat', 'gpt-4o-mini', inputTokens, outputTokens, costUSD, createdAt]
      );
      chatLogged++;
    }
  }

  logDebug('DB', `Backfill: ${whisperLogged} whisper + ${chatLogged} chat`);
}

async function populatePatientNames(db: SQLite.SQLiteDatabase) {
  const rows = await db.getAllAsync<{ fileName: string; summary: string | null }>(
    'SELECT fileName, summary FROM recordings WHERE summary IS NOT NULL AND patientName IS NULL'
  );
  let count = 0;
  for (const r of rows) {
    if (!r.summary) continue;
    // Descriptografa se necessário (summary pode já estar cifrado pela migração v1)
    const summaryText = await decrypt(r.summary);
    const m = summaryText.match(/^Paciente:\s*(.+?)$/m);
    if (m) {
      const name = m[1].trim();
      if (name.length > 1 && !name.toLowerCase().includes('não informado')) {
        // Armazena o patientName já criptografado
        const encName = await encrypt(name);
        await db.runAsync(
          'UPDATE recordings SET patientName = ? WHERE fileName = ?',
          [encName, r.fileName]
        );
        count++;
      }
    }
  }
  logDebug('DB', `PatientName extraído de ${count} gravações`);
}

export function extractPatientName(summary: string | null): string | null {
  if (!summary) return null;
  const m = summary.match(/^Paciente:\s*(.+?)$/m);
  if (!m) return null;
  const name = m[1].trim();
  if (!name || name.toLowerCase().includes('não informado')) return null;
  return name;
}

async function migrateFromSecureStore(db: SQLite.SQLiteDatabase) {
  const dir = FileSystem.documentDirectory;
  if (!dir) return;

  try {
    const files = await FileSystem.readDirectoryAsync(dir);
    const audioFiles = files.filter((f) => f.endsWith('.m4a'));

    let migrated = 0;
    for (const fileName of audioFiles) {
      const [transcript, summary, customName, templateId] = await Promise.all([
        SecureStore.getItemAsync(`transcript_${fileName}`).catch(() => null),
        SecureStore.getItemAsync(`summary_${fileName}`).catch(() => null),
        SecureStore.getItemAsync(`name_${fileName}`).catch(() => null),
        SecureStore.getItemAsync(`template_${fileName}`).catch(() => null),
      ]);

      if (transcript || summary || customName || templateId) {
        // Criptografa campos sensíveis antes de inserir (migração v1 já produz dados cifrados)
        const [encTranscript, encSummary, encCustomName] = await Promise.all([
          transcript ? encrypt(transcript) : null,
          summary    ? encrypt(summary)    : null,
          customName ? encrypt(customName) : null,
        ]);
        await db.runAsync(
          `INSERT OR REPLACE INTO recordings
            (fileName, customName, transcript, summary, templateId, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            fileName,
            encCustomName,
            encTranscript,
            encSummary,
            templateId,
            new Date().toISOString(),
          ]
        );

        await Promise.all([
          SecureStore.deleteItemAsync(`transcript_${fileName}`).catch(() => {}),
          SecureStore.deleteItemAsync(`summary_${fileName}`).catch(() => {}),
          SecureStore.deleteItemAsync(`name_${fileName}`).catch(() => {}),
          SecureStore.deleteItemAsync(`template_${fileName}`).catch(() => {}),
          SecureStore.deleteItemAsync(`meta_${fileName}`).catch(() => {}),
        ]);
        migrated++;
      }
    }
    logDebug('DB', `Migradas ${migrated} gravações para SQLite`);
  } catch (err) {
    logError('DB', err);
  }
}

export async function getAllRecordingsMeta(): Promise<
  Map<string, RecordingMeta>
> {
  const db = await getDb();
  const rows = await db.getAllAsync<RecordingMeta>(
    'SELECT fileName, customName, transcript, summary, templateId, patientName, durationSecs, updatedAt FROM recordings'
  );
  // Descriptografa campos sensíveis em paralelo
  const decryptedRows = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      transcript:  r.transcript  ? await decrypt(r.transcript)  : null,
      summary:     r.summary     ? await decrypt(r.summary)     : null,
      patientName: r.patientName ? await decrypt(r.patientName) : null,
      customName:  r.customName  ? await decrypt(r.customName)  : null,
    }))
  );
  return new Map(decryptedRows.map((r) => [r.fileName, r]));
}

/**
 * Retorna os metadados de todas as gravações com os campos sensíveis
 * NO FORMATO CIFRADO (sem descriptografar).
 *
 * Utilizado pelo sync para enviar ao Supabase dados já cifrados —
 * assim o servidor nunca recebe PHI em texto puro.
 *
 * Nota: a chave AES é gerada por dispositivo (SecureStore). Dados cifrados
 * com a chave do Dispositivo A NÃO podem ser decifrados pelo Dispositivo B.
 * Para uso single-device (caso principal), o ciclo push→pull no mesmo
 * aparelho funciona perfeitamente. Cenários multi-dispositivo requerem
 * uma chave compartilhada derivada da senha do usuário (roadmap futuro).
 */
export async function getAllRecordingsMetaRaw(): Promise<Map<string, RecordingMeta>> {
  const db = await getDb();
  const rows = await db.getAllAsync<RecordingMeta>(
    'SELECT fileName, customName, transcript, summary, templateId, patientName, durationSecs, updatedAt FROM recordings'
  );
  // Retorna os valores brutos (enc1:... ou texto puro legado) sem decifrar
  return new Map(rows.map((r) => [r.fileName, r]));
}

export async function getField(
  fileName: string,
  field: Field
): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, string | null>>(
    `SELECT ${field} FROM recordings WHERE fileName = ?`,
    [fileName]
  );
  const raw = (row?.[field] ?? null) as string | null;
  if (!raw) return null;
  return SENSITIVE_FIELDS.includes(field) ? decrypt(raw) : raw;
}

export async function setField(
  fileName: string,
  field: Field,
  value: string
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const valueToStore = SENSITIVE_FIELDS.includes(field) ? await encrypt(value) : value;
  await db.runAsync(
    `INSERT INTO recordings (fileName, ${field}, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(fileName) DO UPDATE SET ${field} = excluded.${field}, updatedAt = excluded.updatedAt`,
    [fileName, valueToStore, now]
  );
  notifyChange();
}

export async function clearField(
  fileName: string,
  field: Field
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE recordings SET ${field} = NULL, updatedAt = ? WHERE fileName = ?`,
    [now, fileName]
  );
  const row = await db.getFirstAsync<RecordingMeta>(
    'SELECT customName, transcript, summary, templateId, patientName FROM recordings WHERE fileName = ?',
    [fileName]
  );
  if (
    row &&
    !row.customName &&
    !row.transcript &&
    !row.summary &&
    !row.templateId &&
    !row.patientName
  ) {
    await db.runAsync('DELETE FROM recordings WHERE fileName = ?', [fileName]);
  }
  notifyChange();
}

export async function deleteRecordingMeta(fileName: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM recordings WHERE fileName = ?', [fileName]);
  notifyChange();
}


// ─── Custom templates ─────────────────────────────────────

export interface CustomTemplate {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  createdAt: string;
}

export async function getCustomTemplates(): Promise<CustomTemplate[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CustomTemplate>(
    'SELECT id, name, description, systemPrompt, createdAt FROM custom_templates ORDER BY createdAt DESC'
  );
  // Descriptografa campos sensíveis (name, description, systemPrompt)
  return Promise.all(
    rows.map(async (t) => ({
      ...t,
      name:         t.name         ? await decrypt(t.name)         : '',
      description:  t.description  ? await decrypt(t.description)  : null,
      systemPrompt: t.systemPrompt ? await decrypt(t.systemPrompt) : '',
    }))
  );
}

/**
 * Retorna os templates customizados com os campos sensíveis NO FORMATO CIFRADO
 * (sem descriptografar). Utilizado pelo sync para enviar ao Supabase dados
 * já cifrados — o servidor nunca recebe o conteúdo dos prompts em texto puro.
 */
export async function getCustomTemplatesRaw(): Promise<CustomTemplate[]> {
  const db = await getDb();
  return db.getAllAsync<CustomTemplate>(
    'SELECT id, name, description, systemPrompt, createdAt FROM custom_templates ORDER BY createdAt DESC'
  );
}

export async function createCustomTemplate(
  name: string,
  description: string,
  systemPrompt: string
): Promise<string> {
  const db = await getDb();
  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const [encName, encDescription, encSystemPrompt] = await Promise.all([
    encrypt(name),
    description ? encrypt(description) : Promise.resolve(''),
    encrypt(systemPrompt),
  ]);
  await db.runAsync(
    'INSERT INTO custom_templates (id, name, description, systemPrompt, createdAt) VALUES (?, ?, ?, ?, ?)',
    [id, encName, encDescription || null, encSystemPrompt, createdAt]
  );
  notifyChange();
  return id;
}

export async function updateCustomTemplate(
  id: string,
  name: string,
  description: string,
  systemPrompt: string
): Promise<void> {
  const db = await getDb();
  const [encName, encDescription, encSystemPrompt] = await Promise.all([
    encrypt(name),
    description ? encrypt(description) : Promise.resolve(''),
    encrypt(systemPrompt),
  ]);
  await db.runAsync(
    'UPDATE custom_templates SET name = ?, description = ?, systemPrompt = ? WHERE id = ?',
    [encName, encDescription || null, encSystemPrompt, id]
  );
  notifyChange();
}

export async function deleteCustomTemplate(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM custom_templates WHERE id = ?', [id]);
  notifyChange();
}
