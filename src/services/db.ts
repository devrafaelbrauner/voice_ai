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
      try {
        await db.execAsync(`
          PRAGMA journal_mode = WAL;
          PRAGMA secure_delete = ON;
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
      } catch (err) {
        await db.closeAsync().catch(() => {});
        throw err;
      }
    })().catch((err) => {
      // Não cacheia a rejeição: a próxima chamada de getDb() tenta de novo.
      dbPromise = null;
      throw err;
    });
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
    try {
      await populatePatientNames(db);
    } catch (err) {
      // Sem dados clínicos no log; user_version NÃO avança. As migrações seguintes
      // dependem do esquema, então getDb() rejeita e tenta de novo na próxima chamada.
      logError('DB', `Migration v3 falhou (${err instanceof Error ? err.name : 'erro'})`);
      throw err;
    }
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
  // v7/v8/v9 cifram dados já existentes. v9 repete v7+v8 porque builds anteriores
  // sem crypto.subtle gravaram texto puro e mesmo assim avançaram user_version.
  // Se uma falhar, as seguintes não rodam (versões são sequenciais) e o app segue.
  const steps: [number, ((db: SQLite.SQLiteDatabase) => Promise<PendingUpdate[]>)[]][] = [
    [7, [collectRecordingEncryptions]],
    [8, [collectTemplateEncryptions]],
    [9, [collectRecordingEncryptions, collectTemplateEncryptions]],
  ];
  let changed = 0;
  let encryptionOk = true;
  for (const [version, collectors] of steps) {
    if (currentVersion >= version) continue;
    const n = await runEncryptionMigration(db, version, collectors);
    if (n === null) {
      encryptionOk = false;
      break;
    }
    changed += n;
  }
  // v10: tombstones de exclusão. Só avança user_version se as migrações de cifra
  // concluíram (a versão é sequencial). Se elas falharam, o esquema idempotente
  // é criado mesmo assim: exclusões feitas nesta sessão não podem se perder.
  if (encryptionOk && currentVersion < 10) {
    await db.withTransactionAsync(async () => {
      await db.execAsync(TOMBSTONE_SCHEMA_SQL);
      await db.execAsync('PRAGMA user_version = 10');
    });
    logDebug('DB', 'Tabela pending_deletions + triggers de tombstone criados (v10)');
  } else {
    await db.execAsync(TOMBSTONE_SCHEMA_SQL);
  }
  // Só nesta execução em que linhas realmente mudaram: remove o texto puro residual.
  if (changed > 0) await scrubFreedPlaintext(db);
}

// ─── Tombstones de exclusão (v10) ────────────────────────────────────────────
//
// Cada DELETE em recordings/custom_templates grava um tombstone em pending_deletions
// (trigger AFTER DELETE). O sync envia a exclusão ao Supabase ANTES do pull e só
// apaga o tombstone depois de confirmar que o remoto não tem mais o item.
// NÃO existe trigger AFTER INSERT que apague tombstone (apagaria às cegas um tombstone
// recém-criado — SC-01): re-criação legítima limpa o tombstone explicitamente no código
// (restore de backup). INSERT OR REPLACE não dispara triggers de DELETE
// (recursive_triggers é OFF por padrão), então o pull não gera tombstones.
const TOMBSTONE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pending_deletions (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    deletedAt TEXT NOT NULL,
    PRIMARY KEY (kind, key)
  );
  CREATE TRIGGER IF NOT EXISTS recordings_tombstone_ad
  AFTER DELETE ON recordings
  BEGIN
    INSERT OR REPLACE INTO pending_deletions (kind, key, deletedAt)
    VALUES ('recording', OLD.fileName, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER IF NOT EXISTS custom_templates_tombstone_ad
  AFTER DELETE ON custom_templates
  BEGIN
    INSERT OR REPLACE INTO pending_deletions (kind, key, deletedAt)
    VALUES ('template', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
`;

export type TombstoneKind = 'recording' | 'template';

export interface PendingDeletion {
  kind: TombstoneKind;
  key: string;
  deletedAt: string;
}

export async function getPendingDeletions(): Promise<PendingDeletion[]> {
  const db = await getDb();
  return db.getAllAsync<PendingDeletion>(
    'SELECT kind, key, deletedAt FROM pending_deletions ORDER BY deletedAt'
  );
}

/**
 * Remove tombstones já confirmados no remoto. Casa também deletedAt: se o item foi
 * re-excluído depois (tombstone mais novo), o novo tombstone sobrevive.
 */
export async function confirmPendingDeletions(items: PendingDeletion[]): Promise<void> {
  if (items.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const it of items) {
      await db.runAsync(
        'DELETE FROM pending_deletions WHERE kind = ? AND key = ? AND deletedAt = ?',
        [it.kind, it.key, it.deletedAt]
      );
    }
  });
}

/** Descarta todos os tombstones (troca de conta: eles pertenciam ao remoto da conta anterior). */
export async function clearAllPendingDeletions(): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM pending_deletions');
}

/**
 * Dos `keys` informados, devolve os que AINDA existem localmente e NÃO têm tombstone.
 * Usado imediatamente antes de um upsert remoto: um sync que passou do watchdog (ou
 * que leu o snapshot antes de uma exclusão) não pode ressuscitar o item.
 */
export async function filterLiveKeys(kind: TombstoneKind, keys: string[]): Promise<Set<string>> {
  const db = await getDb();
  const table = kind === 'recording' ? 'recordings' : 'custom_templates';
  const col = kind === 'recording' ? 'fileName' : 'id';
  const live = new Set<string>();
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ k: string }>(
      `SELECT ${col} AS k FROM ${table}
        WHERE ${col} IN (${ph})
          AND NOT EXISTS (SELECT 1 FROM pending_deletions p WHERE p.kind = ? AND p.key = ${table}.${col})`,
      [...chunk, kind]
    );
    for (const r of rows) live.add(r.k);
  }
  return live;
}

/** Contagens para o resumo de backup — SQL puro, sem decifrar nada. */
export interface BackupCounts {
  recordings: number;
  transcribed: number;
  finalized: number;
  templates: number;
}

export async function getBackupCounts(): Promise<BackupCounts> {
  const db = await getDb();
  const r = await db.getFirstAsync<{
    total: number;
    transcribed: number;
    finalized: number;
  }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN transcript IS NOT NULL AND transcript <> '' THEN 1 ELSE 0 END), 0) AS transcribed,
            COALESCE(SUM(CASE WHEN transcript IS NOT NULL AND transcript <> ''
                               AND summary IS NOT NULL AND summary <> '' THEN 1 ELSE 0 END), 0) AS finalized
       FROM recordings`
  );
  const t = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM custom_templates');
  return {
    recordings: r?.total ?? 0,
    transcribed: r?.transcribed ?? 0,
    finalized: r?.finalized ?? 0,
    templates: t?.n ?? 0,
  };
}

/** Para o restore de backup disparar o auto-sync. */
export function notifyDataChanged() {
  notifyChange();
}

// ─── Migrações de criptografia (v7/v8/v9) ────────────────────────────────────

interface PendingUpdate {
  sql: string;
  params: (string | null)[];
}

// Valores vazios/nulos ficam como estão; os demais são cifrados se ainda não tiverem "enc1:".
const encIfPresent = (v: string | null): Promise<string | null> =>
  v ? encryptIfNeeded(v) : Promise.resolve(v);

async function collectRecordingEncryptions(db: SQLite.SQLiteDatabase): Promise<PendingUpdate[]> {
  const rows = await db.getAllAsync<{
    fileName: string;
    transcript: string | null;
    summary: string | null;
    patientName: string | null;
    customName: string | null;
  }>('SELECT fileName, transcript, summary, patientName, customName FROM recordings');

  const updates: PendingUpdate[] = [];
  for (const r of rows) {
    const [transcript, summary, patientName, customName] = await Promise.all([
      encIfPresent(r.transcript),
      encIfPresent(r.summary),
      encIfPresent(r.patientName),
      encIfPresent(r.customName),
    ]);
    if (
      transcript === r.transcript &&
      summary === r.summary &&
      patientName === r.patientName &&
      customName === r.customName
    ) {
      continue; // já cifrada — intocada
    }
    updates.push({
      sql: `UPDATE recordings
              SET transcript = ?, summary = ?, patientName = ?, customName = ?
            WHERE fileName = ?`,
      params: [transcript, summary, patientName, customName, r.fileName],
    });
  }
  return updates;
}

async function collectTemplateEncryptions(db: SQLite.SQLiteDatabase): Promise<PendingUpdate[]> {
  const rows = await db.getAllAsync<{
    id: string;
    name: string | null;
    description: string | null;
    systemPrompt: string | null;
  }>('SELECT id, name, description, systemPrompt FROM custom_templates');

  const updates: PendingUpdate[] = [];
  for (const t of rows) {
    const [name, description, systemPrompt] = await Promise.all([
      encIfPresent(t.name),
      encIfPresent(t.description),
      encIfPresent(t.systemPrompt),
    ]);
    if (name === t.name && description === t.description && systemPrompt === t.systemPrompt) {
      continue;
    }
    updates.push({
      sql: 'UPDATE custom_templates SET name = ?, description = ?, systemPrompt = ? WHERE id = ?',
      params: [name, description, systemPrompt, t.id],
    });
  }
  return updates;
}

/**
 * Executa uma migração de criptografia de forma atômica: cifra tudo em memória
 * primeiro (qualquer falha de encrypt aborta antes de tocar no banco) e então
 * aplica os UPDATEs + `PRAGMA user_version` numa única transação.
 * Em falha: loga SEM dados clínicos, NÃO avança user_version (repete no próximo
 * launch) e retorna false — o app continua com os valores atuais (texto puro
 * legado continua legível por decrypt()).
 *
 * Retorna quantas linhas foram alteradas, ou null se a migração falhou.
 */
async function runEncryptionMigration(
  db: SQLite.SQLiteDatabase,
  version: number,
  collectors: ((db: SQLite.SQLiteDatabase) => Promise<PendingUpdate[]>)[]
): Promise<number | null> {
  try {
    const pending: PendingUpdate[] = [];
    for (const collect of collectors) pending.push(...(await collect(db)));

    await db.withTransactionAsync(async () => {
      for (const u of pending) await db.runAsync(u.sql, u.params);
      await db.execAsync(`PRAGMA user_version = ${version}`);
    });
    logDebug('DB', `Migration v${version}: ${pending.length} linhas cifradas com AES-256-GCM`);
    return pending.length;
  } catch (err) {
    logError(
      'DB',
      `Migration v${version} falhou e será repetida na próxima abertura (${
        err instanceof Error ? err.name : 'erro'
      })`
    );
    return null;
  }
}

/**
 * Best-effort, fora da transação de migração: o texto puro antigo ainda existe
 * em páginas livres/WAL. checkpoint(TRUNCATE) + VACUUM reescrevem o arquivo
 * (secure_delete=ON já zera páginas liberadas). Erros são logados sem PHI e
 * nunca falham getDb().
 */
async function scrubFreedPlaintext(db: SQLite.SQLiteDatabase): Promise<void> {
  try {
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    await db.execAsync('VACUUM');
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    logDebug('DB', 'Texto puro legado removido do arquivo (checkpoint + VACUUM)');
  } catch (err) {
    logError('DB', `Limpeza pós-migração (VACUUM) falhou (${err instanceof Error ? err.name : 'erro'})`);
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

const RECORDING_META_COLUMNS =
  'fileName, customName, transcript, summary, templateId, patientName, durationSecs, updatedAt';

/** Decifra (em paralelo) os campos sensíveis de linhas lidas do SQL. */
function decryptRecordingRows(rows: RecordingMeta[]): Promise<RecordingMeta[]> {
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      transcript:  r.transcript  ? await decrypt(r.transcript)  : null,
      summary:     r.summary     ? await decrypt(r.summary)     : null,
      patientName: r.patientName ? await decrypt(r.patientName) : null,
      customName:  r.customName  ? await decrypt(r.customName)  : null,
    }))
  );
}

export async function getAllRecordingsMeta(): Promise<
  Map<string, RecordingMeta>
> {
  const db = await getDb();
  const rows = await db.getAllAsync<RecordingMeta>(`SELECT ${RECORDING_META_COLUMNS} FROM recordings`);
  const decryptedRows = await decryptRecordingRows(rows);
  return new Map(decryptedRows.map((r) => [r.fileName, r]));
}

/** fileNames de todas as gravações, em ordem de rowid (a de inserção) — só a coluna-chave, sem decifrar nada. */
export async function getRecordingFileNames(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ fileName: string }>('SELECT fileName FROM recordings ORDER BY rowid');
  return rows.map((r) => r.fileName);
}

/**
 * Metadados DECIFRADOS de um lote de gravações (backup em blocos: a memória cresce com o lote, não
 * com o banco). Devolve na ordem de `fileNames`; nomes que não existem mais são omitidos.
 * Use lotes pequenos (≤ 200): vira um `IN (?, …)` com um parâmetro por nome.
 */
export async function getRecordingsMetaByNames(fileNames: string[]): Promise<RecordingMeta[]> {
  if (fileNames.length === 0) return [];
  const db = await getDb();
  const rows = await db.getAllAsync<RecordingMeta>(
    `SELECT ${RECORDING_META_COLUMNS} FROM recordings WHERE fileName IN (${fileNames.map(() => '?').join(',')})`,
    fileNames
  );
  const byName = new Map((await decryptRecordingRows(rows)).map((r) => [r.fileName, r]));
  const out: RecordingMeta[] = [];
  for (const name of fileNames) {
    const meta = byName.get(name);
    if (meta) out.push(meta);
  }
  return out;
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

/**
 * Grava um campo. NÃO recria linha de gravação excluída: se há tombstone do fileName,
 * nada é gravado e retorna false (escrita tardia após exclusão — transcrição em voo,
 * drain em curso — não pode ressuscitar PHI nem reenviá-lo ao Supabase). Nomes de
 * arquivo são únicos, então setField nunca precisa limpar tombstone; o restore de
 * backup limpa o seu. Para linha já existente (sem tombstone) é um UPDATE normal.
 * O NOT EXISTS está no próprio INSERT (atômico, sem janela entre checar e gravar).
 */
export async function setField(
  fileName: string,
  field: Field,
  value: string
): Promise<boolean> {
  const db = await getDb();
  const now = new Date().toISOString();
  const valueToStore = SENSITIVE_FIELDS.includes(field) ? await encrypt(value) : value;
  const res = await db.runAsync(
    `INSERT INTO recordings (fileName, ${field}, updatedAt)
     SELECT ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM pending_deletions WHERE kind = 'recording' AND key = ?
     )
     ON CONFLICT(fileName) DO UPDATE SET ${field} = excluded.${field}, updatedAt = excluded.updatedAt`,
    [fileName, valueToStore, now, fileName]
  );
  if (res.changes === 0) return false;
  notifyChange();
  return true;
}

/**
 * Variante só-UPDATE de setField, para tudo que NÃO é a primeira gravação do registro
 * (resumo, templateId, patientName, edição de transcrição). Só grava se a linha ainda
 * existe E não há tombstone: se a gravação foi excluída durante um processamento em voo
 * (o tombstone some depois que o sync confirma a exclusão), nada é recriado — sem
 * linha-fantasma com PHI e sem reenvio ao Supabase. Atômico (um único UPDATE).
 * Retorna false quando nada foi gravado.
 */
export async function updateFieldIfExists(
  fileName: string,
  field: Field,
  value: string
): Promise<boolean> {
  const db = await getDb();
  const now = new Date().toISOString();
  const valueToStore = SENSITIVE_FIELDS.includes(field) ? await encrypt(value) : value;
  const res = await db.runAsync(
    `UPDATE recordings SET ${field} = ?, updatedAt = ?
     WHERE fileName = ?
       AND NOT EXISTS (
         SELECT 1 FROM pending_deletions WHERE kind = 'recording' AND key = ?
       )`,
    [valueToStore, now, fileName, fileName]
  );
  if (res.changes === 0) return false;
  notifyChange();
  return true;
}

/** A linha da gravação existe e não há tombstone dela? (para abortar trabalho em voo) */
export async function recordingRowLive(fileName: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ one: number }>(
    `SELECT 1 AS one FROM recordings r
      WHERE r.fileName = ?
        AND NOT EXISTS (
          SELECT 1 FROM pending_deletions p WHERE p.kind = 'recording' AND p.key = r.fileName
        )`,
    [fileName]
  );
  return row != null;
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
