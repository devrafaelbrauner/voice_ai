// Backup/export utilities — um único arquivo JSON com metadados das gravações
// (nomes, transcrições, resumos, pacientes), perfil profissional e templates.
//
// Áudios NÃO entram no arquivo; permanecem no documentDirectory do aparelho.
//
// Formato v2 ("encrypted-backup-v2") — protegido por passphrase escolhida pelo usuário
// (a chave AES do aparelho NÃO serve: o backup precisa abrir em outro aparelho):
//   - KDF: scrypt, N=2^14 na exportação, r=8, p=1, salt aleatório de 16 bytes.
//     Na importação só são aceitos N ∈ {2^14, 2^16} com r=8 e p=1 (allow-list: um arquivo
//     malicioso não escolhe custo de memória/CPU).
//   - Cifra: AES-256-GCM, nonce aleatório de 12 bytes; `data_b64` = ciphertext || tag(16).
//     Salt/nonce vêm do CSPRNG do sistema via expo-crypto.
//   - O cabeçalho (versão, KDF, salt, nonce, exportedAt, stats) é autenticado como AAD.
//   - Nunca se exporta texto puro: se cifrar falhar, a exportação aborta.
// scrypt, AES-GCM e base64 rodam em código NATIVO (react-native-quick-crypto / OpenSSL e
// react-native-quick-base64): o scrypt corre no thread pool do C++, fora da thread JS (em JS
// puro no Hermes levava ~49 s por senha e travava a UI). Sem fallback para JS puro: se o
// módulo nativo não estiver no binário, o backup falha com mensagem clara. O formato do
// envelope é o mesmo da implementação anterior (@noble): backups antigos abrem e novos também.
// Limite de 50 MB (arquivo/envelope), verificado ANTES de qualquer KDF ou cifra.

import { Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { getRandomValues } from 'expo-crypto';
import { loadNativeCrypto, asBytes, gcmEncrypt, gcmDecrypt, GCM_TAG_BYTES, type NativeCrypto } from './native-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  getDb,
  getAllRecordingsMeta,
  getCustomTemplates,
  getBackupCounts,
  notifyDataChanged,
  type BackupCounts,
  type RecordingMeta,
  type CustomTemplate,
} from './db';
import { getDoctorProfile, setDoctorProfile, type DoctorProfile } from './doctor';
import { encrypt, DECRYPT_FAILED_SENTINEL, isDecryptFailed } from './db-crypto';
import { createExportFile } from './share';

const BACKUP_VERSION = 2;
const FORMAT_ID = 'encrypted-backup-v2';
const LEGACY_FORMAT_ID = 'encrypted-backup-v1';
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

const KDF_R = 8;
const KDF_P = 1;
const KDF_N_EXPORT = 2 ** 14;
const KDF_N_ALLOWED: readonly number[] = [2 ** 14, 2 ** 16];
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
// scrypt N=2^16, r=8 usa 64 MiB (128·r·N); o padrão da lib (32 MiB) recusaria. Folga p/ a allow-list.
const KDF_MAXMEM = 128 * 1024 * 1024;
const FILE_TOO_BIG_MESSAGE = 'O arquivo tem mais de 50 MB e não é um backup válido.';

const MIN_PASSPHRASE_LENGTH = 12;

export interface BackupStats {
  totalRecordings: number;
  transcribed: number;
  processed: number;
  finalized: number;
  uniquePatients: number;
}

/** Envelope gravado em disco. Só o `data_b64` contém dados sensíveis (cifrados). */
export interface EncryptedBackupEnvelope {
  _voiceai: typeof FORMAT_ID;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  stats: BackupStats;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt_b64: string };
  cipher: { name: 'aes-256-gcm'; nonce_b64: string };
  data_b64: string;
}

export interface BackupPayload {
  version: number;
  exportedAt: string;
  app: 'voice-ai-recorder';
  doctor: DoctorProfile | null;
  recordings: (RecordingMeta & { createdAt: string | null })[];
  customTemplates: CustomTemplate[];
  stats: BackupStats;
  /** Itens (gravações + templates) com algum campo que não pôde ser decifrado — cada item conta uma vez. */
  unreadableItems: number;
}

/** Erro de senha/integridade — a UI mantém o modal aberto para nova tentativa. */
export class BackupPassphraseError extends Error {
  constructor() {
    super('Senha incorreta ou arquivo de backup adulterado.');
    this.name = 'BackupPassphraseError';
  }
}

// ─── Passphrase ──────────────────────────────────────────────────────────────

const WEAK_PASSPHRASES = new Set([
  'password', 'password1', 'password123', 'passphrase', 'qwertyuiop', 'qwerty123456', 'qwertyqwerty',
  'asdfghjkl', 'zxcvbnm', 'iloveyou', 'letmein', 'welcome', 'admin', 'administrator', 'abc123',
  'senha', 'senha123', 'senhasecreta', 'minhasenha', 'senhaforte', 'senhasegura', 'mudar123',
  'backup', 'backupvoiceai', 'voiceai', 'voiceairecorder', 'gravador', 'medico', 'doutor', 'prontuario',
  'brasil', 'brasil123', 'flamengo', 'corinthians', 'palmeiras', 'saopaulo', 'santos', 'gremio',
  'dragonball', 'mudaragora', 'trocar123', 'teste123', 'testando', 'exemplo', 'secret', 'secreta',
  '123456789012', '1234567890', '12345678901', '123456789', '12345678', '111111111111', '000000000000',
  '012345678901', 'abcdefghijkl', 'abcdefghijklmnop', 'aaaaaaaaaaaa',
]);

/** Texto para comparação com a blocklist: minúsculas, sem acento, só [a-z0-9]. */
function normalizeForBlocklist(p: string): string {
  return p
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Devolve a mensagem de erro (pt-BR) ou null se a passphrase é aceitável para CRIAR um backup. */
export function validatePassphrase(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use pelo menos ${MIN_PASSPHRASE_LENGTH} caracteres.`;
  }
  const norm = normalizeForBlocklist(passphrase);
  const withoutTrailingDigits = norm.replace(/\d+$/, '');
  if (
    WEAK_PASSPHRASES.has(norm) ||
    (withoutTrailingDigits.length > 0 && WEAK_PASSPHRASES.has(withoutTrailingDigits)) ||
    new Set(norm).size < 6 ||
    /^(.{1,6})\1+$/.test(norm) ||
    /^(.{1,6})\1+$/.test(withoutTrailingDigits)
  ) {
    return 'Senha fraca ou muito comum. Use uma frase longa e difícil de adivinhar.';
  }
  return null;
}

/** NFKC: o mesmo texto digitado em teclados diferentes gera os mesmos bytes. */
const normalizePassphrase = (p: string): string => p.normalize('NFKC');

// ─── base64 nativo + KDF ─────────────────────────────────────────────────────

const BASE64_STRICT_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_STRICT_MAX_CHARS = 1024;

/**
 * base64 -> bytes pelo decodificador nativo (arquivos de dezenas de MB). Comprimento múltiplo de 4
 * sempre; alfabeto/padding estritos conferidos por regex nas strings curtas (salt/nonce) — o
 * ciphertext grande é autenticado pelo GCM, então não precisa varrer 50 MB em JS.
 */
function base64ToBytes(n: NativeCrypto, b64: string): Uint8Array {
  const corrupt = () => new Error('Arquivo de backup corrompido (base64 inválido).');
  if (b64.length % 4 !== 0) throw corrupt();
  if (b64.length <= BASE64_STRICT_MAX_CHARS && !BASE64_STRICT_RE.test(b64)) throw corrupt();
  try {
    return asBytes(n.toByteArray(b64));
  } catch {
    throw corrupt();
  }
}

const UTF8_DECODE_CHUNK = 1 << 20;

/** Decodifica UTF-8 em pedaços de ~1 MB cortados em fronteira de caractere (sem depender de `stream`). */
function decodeUtf8Chunked(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8');
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + UTF8_DECODE_CHUNK, bytes.length);
    // Não corta no meio de uma sequência multibyte (bytes de continuação são 10xxxxxx).
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts.join('');
}

// ─── Cifra do envelope ───────────────────────────────────────────────────────

function buildAad(
  exportedAt: string,
  stats: BackupStats,
  kdf: EncryptedBackupEnvelope['kdf'],
  nonceB64: string
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      'voiceai-backup', BACKUP_VERSION, exportedAt, stats,
      kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt_b64, nonceB64,
    ])
  );
}

/** Deriva a chave com scrypt nativo (thread pool do C++): a thread JS fica livre durante a espera. */
function deriveKey(n: NativeCrypto, passphrase: string, salt: Uint8Array, N: number): Promise<Uint8Array> {
  const password = new TextEncoder().encode(normalizePassphrase(passphrase));
  return new Promise<Uint8Array>((resolve, reject) => {
    n.scrypt(password, salt, KEY_BYTES, { N, r: KDF_R, p: KDF_P, maxmem: KDF_MAXMEM }, (err, key) => {
      password.fill(0);
      if (err || !key) reject(new Error('Falha ao derivar a chave de criptografia (módulo nativo).'));
      else resolve(asBytes(key));
    });
  });
}

/**
 * Serializa e cifra o payload. Lança se qualquer etapa falhar — nunca produz texto puro.
 * O tamanho do envelope é calculado e comparado com o limite de 50 MB ANTES do scrypt e da cifra.
 */
export async function encryptBackupPayload(
  payload: BackupPayload,
  passphrase: string
): Promise<string> {
  const n = loadNativeCrypto();
  const salt = getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = getRandomValues(new Uint8Array(NONCE_BYTES));
  const kdf: EncryptedBackupEnvelope['kdf'] = {
    name: 'scrypt',
    N: KDF_N_EXPORT,
    r: KDF_R,
    p: KDF_P,
    salt_b64: n.fromByteArray(salt),
  };
  const nonceB64 = n.fromByteArray(nonce);
  const { doctor, recordings, customTemplates } = payload;
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      version: payload.version,
      app: payload.app,
      exportedAt: payload.exportedAt,
      doctor,
      recordings,
      customTemplates,
    })
  );

  const header: EncryptedBackupEnvelope = {
    _voiceai: FORMAT_ID,
    version: BACKUP_VERSION,
    exportedAt: payload.exportedAt,
    stats: payload.stats,
    kdf,
    cipher: { name: 'aes-256-gcm', nonce_b64: nonceB64 },
    data_b64: '',
  };
  // Tamanho exato do arquivo final: cabeçalho + base64(ciphertext + tag). Falha aqui, em
  // milissegundos, em vez de depois de gastar scrypt + cifra num arquivo impossível de restaurar.
  const envelopeChars = JSON.stringify(header).length + 4 * Math.ceil((plaintext.length + GCM_TAG_BYTES) / 3);
  if (envelopeChars > MAX_BACKUP_BYTES) {
    plaintext.fill(0);
    throw new Error('O backup passaria de 50 MB e não poderia ser restaurado. Exclua gravações antigas antes de exportar.');
  }

  const key = await deriveKey(n, passphrase, salt, kdf.N);
  let sealed: Uint8Array;
  try {
    sealed = gcmEncrypt(n, key, nonce, plaintext, buildAad(payload.exportedAt, payload.stats, kdf, nonceB64));
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
  return JSON.stringify({ ...header, data_b64: n.fromByteArray(sealed) });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Valida o envelope (estrutura + allow-list do KDF). Não toca em dados sensíveis. */
function parseEnvelope(text: string): EncryptedBackupEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Arquivo inválido: não é um backup do Voice AI.');
  }
  if (!isRecord(raw)) throw new Error('Arquivo inválido: não é um backup do Voice AI.');
  if (raw._voiceai === LEGACY_FORMAT_ID) {
    throw new Error('Este backup usa o formato antigo (v1), sem senha, e não pode ser restaurado. Gere um novo backup no aparelho de origem.');
  }
  if (raw._voiceai !== FORMAT_ID || raw.version !== BACKUP_VERSION) {
    throw new Error('Arquivo inválido: não é um backup do Voice AI (versão 2).');
  }
  const { kdf, cipher, stats } = raw;
  if (
    !isRecord(kdf) || kdf.name !== 'scrypt' ||
    typeof kdf.N !== 'number' || !KDF_N_ALLOWED.includes(kdf.N) ||
    kdf.r !== KDF_R || kdf.p !== KDF_P ||
    typeof kdf.salt_b64 !== 'string' || kdf.salt_b64.length > 64
  ) {
    throw new Error('Backup com parâmetros de criptografia não suportados.');
  }
  if (!isRecord(cipher) || cipher.name !== 'aes-256-gcm' || typeof cipher.nonce_b64 !== 'string' || cipher.nonce_b64.length > 32) {
    throw new Error('Backup com parâmetros de criptografia não suportados.');
  }
  if (typeof raw.exportedAt !== 'string' || !isRecord(stats) || typeof raw.data_b64 !== 'string') {
    throw new Error('Arquivo de backup incompleto ou corrompido.');
  }
  return raw as unknown as EncryptedBackupEnvelope;
}

/**
 * Decifra o envelope e devolve o JSON do payload. Senha errada e arquivo adulterado
 * são indistinguíveis no GCM e resultam em BackupPassphraseError.
 * `env.data_b64` é zerado assim que vira bytes (libera a cópia de dezenas de MB).
 */
export async function decryptBackupText(text: string, passphrase: string): Promise<unknown> {
  if (text.length > MAX_BACKUP_BYTES) throw new Error(FILE_TOO_BIG_MESSAGE); // antes de parsear/derivar
  const env = parseEnvelope(text);
  const n = loadNativeCrypto();
  const salt = base64ToBytes(n, env.kdf.salt_b64);
  const nonce = base64ToBytes(n, env.cipher.nonce_b64);
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES) {
    throw new Error('Arquivo de backup incompleto ou corrompido.');
  }
  const aad = buildAad(env.exportedAt, env.stats, env.kdf, env.cipher.nonce_b64);
  const sealed = base64ToBytes(n, env.data_b64);
  env.data_b64 = '';
  if (sealed.length < GCM_TAG_BYTES) throw new Error('Arquivo de backup incompleto ou corrompido.');

  const key = await deriveKey(n, passphrase, salt, env.kdf.N);
  let plain: Uint8Array;
  try {
    plain = gcmDecrypt(n, key, nonce, sealed, aad);
  } catch {
    throw new BackupPassphraseError();
  } finally {
    key.fill(0);
    sealed.fill(0);
  }
  if (plain.length > MAX_BACKUP_BYTES) {
    plain.fill(0);
    throw new Error('Backup excede o limite de 50 MB.');
  }
  let json: string;
  try {
    json = decodeUtf8Chunked(plain);
  } finally {
    plain.fill(0);
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('Conteúdo do backup corrompido.');
  }
}

// ─── Build / export ──────────────────────────────────────────────────────────

/** Valor legível ou null; marca o item como ilegível (uma vez) quando a decifra falhou. */
function readable(value: string | null, onBad: () => void): string | null {
  if (value === null) return null;
  if (isDecryptFailed(value)) {
    onBad();
    return null;
  }
  return value;
}

/**
 * Monta o payload a partir do armazenamento local (decifrado, em memória).
 * Campos que não decifram não entram; cada item afetado é contado UMA vez em unreadableItems.
 */
export async function buildBackup(): Promise<BackupPayload> {
  const metaMap = await getAllRecordingsMeta();
  const doctor = await getDoctorProfile().catch(() => null);
  const templates = await getCustomTemplates().catch(() => []);

  const unreadable = new Set<string>();
  const recordings: BackupPayload['recordings'] = [];
  const patientSet = new Set<string>();
  let transcribed = 0;
  let processed = 0;
  let finalized = 0;

  for (const [fileName, meta] of metaMap.entries()) {
    const bad = () => { unreadable.add(`r:${fileName}`); };
    const clean = {
      ...meta,
      customName: readable(meta.customName, bad),
      transcript: readable(meta.transcript, bad),
      summary: readable(meta.summary, bad),
      patientName: readable(meta.patientName, bad),
    };
    const match = fileName.match(/recording_(\d+)\.m4a/);
    const createdAt = match ? new Date(parseInt(match[1])).toISOString() : null;
    recordings.push({ ...clean, createdAt });

    if (clean.transcript) transcribed++;
    if (clean.summary) processed++;
    if (clean.summary && clean.transcript) finalized++;
    if (clean.patientName) patientSet.add(clean.patientName);
  }

  recordings.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  const customTemplates: CustomTemplate[] = [];
  for (const t of templates) {
    const bad = () => { unreadable.add(`t:${t.id}`); };
    const name = readable(t.name, bad);
    const systemPrompt = readable(t.systemPrompt, bad);
    const description = readable(t.description, bad);
    if (name === null || systemPrompt === null) continue; // campos obrigatórios ilegíveis
    customTemplates.push({ ...t, name, systemPrompt, description });
  }

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'voice-ai-recorder',
    doctor,
    recordings,
    customTemplates,
    unreadableItems: unreadable.size,
    stats: {
      totalRecordings: recordings.length,
      transcribed,
      processed,
      finalized,
      uniquePatients: patientSet.size,
    },
  };
}

export interface ExportOutcome {
  status: 'empty' | 'shared' | 'saved';
  recordings: number;
  templates: number;
  unreadable: number;
  path?: string;
}

/**
 * Exporta o backup cifrado com a passphrase e abre a folha de compartilhamento.
 * Lança Error (mensagem em pt-BR) em qualquer falha; nunca grava texto puro.
 */
export async function exportBackup(passphrase: string): Promise<ExportOutcome> {
  const weak = validatePassphrase(passphrase);
  if (weak) throw new Error(weak);

  const payload = await buildBackup();
  const outcome = {
    recordings: payload.recordings.length,
    templates: payload.customTemplates.length,
    unreadable: payload.unreadableItems,
  };
  if (outcome.recordings === 0 && outcome.templates === 0) {
    return { status: 'empty', ...outcome };
  }

  const fileContent = await encryptBackupPayload(payload, passphrase);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = createExportFile(`voice-ai-recorder-backup-${stamp}.enc.json`);
  file.write(fileContent);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: `Backup com ${outcome.recordings} gravação(ões) (cifrado com senha)`,
      UTI: 'public.json',
    });
    return { status: 'shared', ...outcome, path: file.uri };
  }
  Alert.alert(
    'Backup cifrado gerado',
    `Arquivo salvo em:\n${file.uri}\n\nNenhum app de compartilhamento disponível.`
  );
  return { status: 'saved', ...outcome, path: file.uri };
}

/** Resumo para a UI a partir de contagens SQL (não decifra nada, não monta o backup). */
export function describeBackupCounts(c: BackupCounts): string {
  const parts: string[] = [`${c.recordings} gravação(ões)`];
  if (c.transcribed > 0) parts.push(`${c.transcribed} transcrita(s)`);
  if (c.finalized > 0) parts.push(`${c.finalized} finalizada(s)`);
  if (c.templates > 0) parts.push(`${c.templates} template(s)`);
  return parts.join(', ');
}

/** Contagens + texto para o resumo da tela de Configurações. */
export async function getBackupSummary(): Promise<string> {
  return describeBackupCounts(await getBackupCounts());
}

// ─── Restore ─────────────────────────────────────────────────────────────────

export interface PickedBackup {
  uri: string;
  name: string;
}

/** Abre o seletor de arquivos. Devolve null se o usuário cancelar. */
export async function pickBackupFile(): Promise<PickedBackup | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: '*/*', // o provedor de arquivos nem sempre rotula .json corretamente; o conteúdo é validado
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.[0]) return null;
  const asset = res.assets[0];
  // A cópia em cache já existe aqui: qualquer falha da checagem de tamanho a apaga.
  // O size do asset pode faltar; o tamanho real da cópia é a fonte de verdade.
  try {
    let size = asset.size;
    if (typeof size !== 'number') size = new File(asset.uri).size;
    if (typeof size === 'number' && size > MAX_BACKUP_BYTES) {
      throw new Error(FILE_TOO_BIG_MESSAGE);
    }
  } catch (err) {
    discardPickedFile(asset.uri);
    throw err;
  }
  return { uri: asset.uri, name: asset.name };
}

/** Apaga a cópia temporária criada pelo seletor (fica no cache; contém dados cifrados). */
export function discardPickedFile(uri: string): void {
  try {
    if (uri.startsWith(Paths.cache.uri)) new File(uri).delete();
  } catch {
    // best-effort
  }
}

export interface RestoreResult {
  restoredRecordings: number;
  restoredTemplates: number;
  /** Itens que já existiam com conteúdo no aparelho (mantidos como estão). */
  alreadyPresent: number;
  /** Itens ilegíveis/inválidos/vazios no arquivo — cada item conta uma vez. */
  unreadable: number;
  doctorRestored: boolean;
}

const FILE_NAME_RE = /^[\w.\-]{1,255}$/;
const TEMPLATE_ID_RE = /^[\w.\-]{1,128}$/;

const optString = (v: unknown): string | null | undefined =>
  v === undefined || v === null ? null : typeof v === 'string' ? v : undefined;

interface RestoreRecording {
  fileName: string;
  customName: string | null;
  transcript: string | null;
  summary: string | null;
  templateId: string | null;
  patientName: string | null;
  durationSecs: number | null;
  updatedAt: string | null;
}

interface RestoreTemplate {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  createdAt: string;
}

/** Linha de backup -> estrutura validada; null se inválida ou sem nenhum conteúdo. */
function sanitizeRecording(v: unknown): RestoreRecording | null {
  if (!isRecord(v) || typeof v.fileName !== 'string' || !FILE_NAME_RE.test(v.fileName)) return null;
  const f = {
    customName: optString(v.customName),
    transcript: optString(v.transcript),
    summary: optString(v.summary),
    templateId: optString(v.templateId),
    patientName: optString(v.patientName),
    updatedAt: optString(v.updatedAt),
  };
  if (Object.values(f).some((x) => x === undefined)) return null;
  const durationSecs =
    typeof v.durationSecs === 'number' && Number.isFinite(v.durationSecs) ? Math.round(v.durationSecs) : null;
  const clean = (s: string | null | undefined) => (s && s !== DECRYPT_FAILED_SENTINEL ? s : null);
  const rec: RestoreRecording = {
    fileName: v.fileName,
    customName: clean(f.customName),
    transcript: clean(f.transcript),
    summary: clean(f.summary),
    templateId: clean(f.templateId),
    patientName: clean(f.patientName),
    durationSecs,
    updatedAt: f.updatedAt ?? null,
  };
  const hasContent = rec.customName || rec.transcript || rec.summary || rec.templateId || rec.patientName;
  return hasContent ? rec : null;
}

function sanitizeTemplate(v: unknown): RestoreTemplate | null {
  if (!isRecord(v) || typeof v.id !== 'string' || !TEMPLATE_ID_RE.test(v.id)) return null;
  if (typeof v.name !== 'string' || !v.name || v.name === DECRYPT_FAILED_SENTINEL) return null;
  if (typeof v.systemPrompt !== 'string' || !v.systemPrompt || v.systemPrompt === DECRYPT_FAILED_SENTINEL) return null;
  const description = optString(v.description);
  if (description === undefined) return null;
  return {
    id: v.id,
    name: v.name,
    description: description && description !== DECRYPT_FAILED_SENTINEL ? description : null,
    systemPrompt: v.systemPrompt,
    createdAt: typeof v.createdAt === 'string' && v.createdAt ? v.createdAt : new Date().toISOString(),
  };
}

function sanitizeDoctor(v: unknown): DoctorProfile | null {
  if (!isRecord(v)) return null;
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    name: s(v.name),
    title: s(v.title),
    crmNumber: s(v.crmNumber),
    crmUF: s(v.crmUF),
    address: s(v.address),
    phone: s(v.phone),
    city: s(v.city),
    professionalEnabled: v.professionalEnabled === true,
  };
}

type TxnLike = Pick<SQLiteDatabase, 'getFirstAsync' | 'runAsync'>;

const nonEmpty = (...vals: (string | null | undefined)[]) => vals.some((v) => typeof v === 'string' && v !== '');

/**
 * Restaura o conteúdo de um arquivo de backup. Itens que já existem COM conteúdo no
 * aparelho são mantidos (nada é sobrescrito); linha existente porém vazia não conta
 * como "já existia". Tudo é aplicado numa transação exclusiva: ou entra tudo ou nada.
 */
export async function restoreBackup(uri: string, passphrase: string): Promise<RestoreResult> {
  let succeeded = false;
  try {
    const file = new File(uri);
    if (!file.exists) throw new Error('Arquivo não encontrado.');
    if (file.size > MAX_BACKUP_BYTES) throw new Error(FILE_TOO_BIG_MESSAGE); // antes de ler/derivar
    const text = await file.text();

    const parsed = await decryptBackupText(text, passphrase);
    if (!isRecord(parsed) || parsed.version !== BACKUP_VERSION || parsed.app !== 'voice-ai-recorder') {
      throw new Error('Conteúdo do backup não reconhecido.');
    }
    const rawRecordings = Array.isArray(parsed.recordings) ? parsed.recordings : [];
    const rawTemplates = Array.isArray(parsed.customTemplates) ? parsed.customTemplates : [];

    let unreadable = 0;
    const recordings: RestoreRecording[] = [];
    for (const r of rawRecordings) {
      const s = sanitizeRecording(r);
      if (s) recordings.push(s);
      else unreadable++;
    }
    const templates: RestoreTemplate[] = [];
    for (const t of rawTemplates) {
      const s = sanitizeTemplate(t);
      if (s) templates.push(s);
      else unreadable++;
    }

    // Recifra com a chave DESTE aparelho ANTES de abrir a transação (encrypt é assíncrono
    // e a transação exclusiva não deve ficar aberta esperando cifra).
    const encOpt = (v: string | null) => (v ? encrypt(v) : Promise.resolve(null));
    const encRecordings: RestoreRecording[] = [];
    for (const r of recordings) {
      const [customName, transcript, summary, patientName] = await Promise.all([
        encOpt(r.customName), encOpt(r.transcript), encOpt(r.summary), encOpt(r.patientName),
      ]);
      encRecordings.push({ ...r, customName, transcript, summary, patientName });
    }
    const encTemplates: RestoreTemplate[] = [];
    for (const t of templates) {
      const [name, description, systemPrompt] = await Promise.all([
        encrypt(t.name), encOpt(t.description), encrypt(t.systemPrompt),
      ]);
      encTemplates.push({ ...t, name, description, systemPrompt });
    }

    let restoredRecordings = 0;
    let restoredTemplates = 0;
    let alreadyPresent = 0;
    const now = new Date().toISOString();

    const apply = async (txn: TxnLike) => {
      restoredRecordings = 0;
      restoredTemplates = 0;
      alreadyPresent = 0;
      for (const r of encRecordings) {
        const existing = await txn.getFirstAsync<{
          customName: string | null; transcript: string | null; summary: string | null;
          templateId: string | null; patientName: string | null;
        }>(
          'SELECT customName, transcript, summary, templateId, patientName FROM recordings WHERE fileName = ?',
          [r.fileName]
        );
        if (existing && nonEmpty(existing.customName, existing.transcript, existing.summary, existing.templateId, existing.patientName)) {
          alreadyPresent++;
          continue;
        }
        await txn.runAsync(
          `INSERT OR REPLACE INTO recordings
             (fileName, customName, transcript, summary, templateId, patientName, durationSecs, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.fileName, r.customName, r.transcript, r.summary, r.templateId, r.patientName, r.durationSecs, r.updatedAt ?? now]
        );
        // Re-criação explícita: o item restaurado não pode ser tratado como excluído.
        await txn.runAsync(`DELETE FROM pending_deletions WHERE kind = 'recording' AND key = ?`, [r.fileName]);
        restoredRecordings++;
      }
      for (const t of encTemplates) {
        const existing = await txn.getFirstAsync<{ name: string | null; description: string | null; systemPrompt: string | null }>(
          'SELECT name, description, systemPrompt FROM custom_templates WHERE id = ?',
          [t.id]
        );
        if (existing && nonEmpty(existing.name, existing.description, existing.systemPrompt)) {
          alreadyPresent++;
          continue;
        }
        await txn.runAsync(
          `INSERT OR REPLACE INTO custom_templates (id, name, description, systemPrompt, createdAt)
           VALUES (?, ?, ?, ?, ?)`,
          [t.id, t.name, t.description, t.systemPrompt, t.createdAt]
        );
        await txn.runAsync(`DELETE FROM pending_deletions WHERE kind = 'template' AND key = ?`, [t.id]);
        restoredTemplates++;
      }
    };

    const db = await getDb();
    if (typeof db.withExclusiveTransactionAsync === 'function') {
      await db.withExclusiveTransactionAsync(async (txn) => { await apply(txn); });
    } else {
      await db.withTransactionAsync(() => apply(db));
    }

    // Perfil profissional: só preenche se o aparelho ainda não tem perfil.
    let doctorRestored = false;
    const doctor = sanitizeDoctor(parsed.doctor);
    if (doctor) {
      const local = await getDoctorProfile();
      const localEmpty = Object.values(local).every((v) => (typeof v === 'boolean' ? !v : v === ''));
      if (localEmpty && Object.values(doctor).some((v) => (typeof v === 'boolean' ? v : v !== ''))) {
        await setDoctorProfile(doctor);
        doctorRestored = true;
      }
    }

    if (restoredRecordings > 0 || restoredTemplates > 0) notifyDataChanged();
    succeeded = true;
    return { restoredRecordings, restoredTemplates, alreadyPresent, unreadable, doctorRestored };
  } finally {
    // Só descarta a cópia temporária no sucesso: em falha (ex.: senha errada) o usuário
    // tenta de novo com o mesmo arquivo; o chamador descarta ao cancelar.
    if (succeeded) discardPickedFile(uri);
  }
}
