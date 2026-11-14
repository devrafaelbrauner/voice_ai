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
//
// Memória (QA em aparelho: pico de ~1,3–1,4 GB com 36 MB): nada aqui mantém o arquivo, o
// base64, os bytes e o texto ao mesmo tempo. A exportação lê o banco em lotes, serializa por
// gravação, cifra com AES-GCM em fluxo (a tag só sai no fim: formato idêntico ao one-shot) e
// grava o base64 por blocos num handle do expo-file-system. A restauração lê o arquivo em blocos,
// decifra em fluxo, fatia o JSON por registro (json-slices.ts) e grava em lotes na transação
// exclusiva. Só arquivos fora do layout do exportador usam o caminho em memória (decryptBackupText).

import { Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths, type FileHandle } from 'expo-file-system';
import { getRandomValues } from 'expo-crypto';
import {
  loadNativeCrypto,
  asBytes,
  gcmEncryptStream,
  gcmDecryptStream,
  gcmDecrypt,
  decodeUtf8Strict,
  Utf8StreamDecoder,
  GCM_TAG_BYTES,
  type GcmEncryptStream,
  type GcmDecryptStream,
  type NativeCrypto,
} from './native-crypto';
import { readJsonObject, JsonSliceError, JsonNotObjectError, type JsonItem } from './json-slices';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  getDb,
  getRecordingFileNames,
  getRecordingsMetaByNames,
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

// Blocos do fluxo. Plaintext em múltiplos de 3 bytes: o base64 de cada bloco se concatena sem preenchimento.
const PLAIN_CHUNK_BYTES = 3 * 65536; // 192 KiB
const B64_CHUNK_CHARS = 4 * 65536; // 256 KiB de base64 = 192 KiB de bytes
/** Bytes lidos do início do arquivo para achar o cabeçalho do envelope. */
const HEADER_PROBE_BYTES = 4096;
/** Gravações lidas/decifradas por lote na exportação; registros validados/gravados por lote na restauração. */
const EXPORT_BATCH = 100;
const RESTORE_BATCH = 100;

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

// ─── Cifra do envelope ───────────────────────────────────────────────────────

/** Final do JSON do cabeçalho (`data_b64` vazio é a última chave): onde entra o ciphertext em base64. */
const DATA_B64_EMPTY_TAIL = '"data_b64":""}';

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

// ─── Exportação em blocos ────────────────────────────────────────────────────

/** Destino do envelope: arquivo (handle) ou, nos testes/API em memória, uma lista de pedaços. */
interface TextSink {
  write(text: string): void;
  close(): void;
}

/**
 * O que `sealBackup` precisa saber do payload sem tê-lo na memória: metadados do cabeçalho (stats
 * entram no AAD, então precisam existir ANTES da primeira cifra), o tamanho exato do JSON em bytes
 * UTF-8 (limite de 50 MB antes do KDF) e um produtor que emite esse JSON em pedaços concatenáveis.
 */
interface ExportSource {
  exportedAt: string;
  stats: BackupStats;
  jsonBytes: number;
  emit(push: (piece: string) => void): Promise<void>;
}

const DATA_CHANGED_MESSAGE = 'Os dados mudaram durante a exportação. Tente novamente.';
/** Pedaço de texto codificado de cada vez (um array de milhões de caracteres nunca vira um único buffer). */
const ENCODE_SLICE_CHARS = 256 * 1024;

let textEncoder: TextEncoder | null = null;
const encodeUtf8 = (s: string): Uint8Array => (textEncoder ??= new TextEncoder()).encode(s);

/** Percorre `text` em fatias que não cortam um par substituto UTF-16 ao meio. */
function forEachSlice(text: string, fn: (slice: string) => void): void {
  if (text.length <= ENCODE_SLICE_CHARS) {
    fn(text);
    return;
  }
  for (let from = 0; from < text.length; ) {
    let to = Math.min(from + ENCODE_SLICE_CHARS, text.length);
    const last = text.charCodeAt(to - 1);
    if (to < text.length && last >= 0xd800 && last <= 0xdbff) to--; // alto sem o baixo: leva junto no próximo
    fn(text.slice(from, to));
    from = to;
  }
}

function utf8Length(text: string): number {
  let bytes = 0;
  forEachSlice(text, (s) => { bytes += encodeUtf8(s).length; });
  return bytes;
}

/**
 * Cifra o JSON recebido aos pedaços (AES-GCM em fluxo) e entrega o ciphertext em base64 ao destino
 * a cada PLAIN_CHUNK_BYTES. Os blocos têm múltiplo de 3 bytes, então o base64 de cada um se
 * concatena sem preenchimento e o resultado é idêntico ao base64 do ciphertext inteiro.
 */
class SealedWriter {
  private readonly cipher: GcmEncryptStream;
  private readonly stage = new Uint8Array(PLAIN_CHUNK_BYTES);
  private filled = 0;
  plainBytes = 0;

  constructor(
    private readonly n: NativeCrypto,
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    private readonly sink: TextSink
  ) {
    this.cipher = gcmEncryptStream(n, key, nonce, aad);
  }

  push(text: string): void {
    forEachSlice(text, (slice) => {
      const bytes = encodeUtf8(slice);
      this.plainBytes += bytes.length;
      if (this.plainBytes > MAX_BACKUP_BYTES) throw new Error(DATA_CHANGED_MESSAGE);
      for (let off = 0; off < bytes.length; ) {
        const take = Math.min(bytes.length - off, this.stage.length - this.filled);
        this.stage.set(bytes.subarray(off, off + take), this.filled);
        this.filled += take;
        off += take;
        if (this.filled === this.stage.length) {
          this.sink.write(this.n.fromByteArray(this.cipher.update(this.stage)));
          this.filled = 0;
        }
      }
      bytes.fill(0);
    });
  }

  /** Fecha o GCM; o último pedaço (resto do ciphertext + tag) é o único que pode ter preenchimento base64. */
  finish(expectedBytes: number): void {
    if (this.plainBytes !== expectedBytes) throw new Error(DATA_CHANGED_MESSAGE);
    const last = this.filled > 0 ? this.cipher.update(this.stage.subarray(0, this.filled)) : new Uint8Array(0);
    const tail = this.cipher.finish();
    const out = new Uint8Array(last.length + tail.length);
    out.set(last, 0);
    out.set(tail, last.length);
    this.sink.write(this.n.fromByteArray(out));
    this.stage.fill(0);
  }
}

/**
 * Monta e grava o envelope v2 em fluxo: cabeçalho, ciphertext em base64 por blocos, fecha o JSON.
 * Lança se qualquer etapa falhar — nunca produz texto puro. O tamanho do envelope é calculado e
 * comparado com o limite de 50 MB ANTES do scrypt e da cifra; `openSink` só roda depois do KDF
 * (falha antes disso não deixa arquivo). Formato idêntico ao da versão em memória (@noble).
 */
async function sealBackup(
  source: ExportSource,
  passphrase: string,
  openSink: (n: NativeCrypto) => TextSink
): Promise<void> {
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
  const header: EncryptedBackupEnvelope = {
    _voiceai: FORMAT_ID,
    version: BACKUP_VERSION,
    exportedAt: source.exportedAt,
    stats: source.stats,
    kdf,
    cipher: { name: 'aes-256-gcm', nonce_b64: nonceB64 },
    data_b64: '',
  };
  // Tamanho exato do arquivo final: cabeçalho + base64(ciphertext + tag). Falha aqui, em
  // milissegundos, em vez de depois de gastar scrypt + cifra num arquivo impossível de restaurar.
  const headerJson = JSON.stringify(header);
  const envelopeChars = headerJson.length + 4 * Math.ceil((source.jsonBytes + GCM_TAG_BYTES) / 3);
  if (envelopeChars > MAX_BACKUP_BYTES) {
    throw new Error('O backup passaria de 50 MB e não poderia ser restaurado. Exclua gravações antigas antes de exportar.');
  }

  const key = await deriveKey(n, passphrase, salt, kdf.N);
  let sink: TextSink | null = null;
  try {
    sink = openSink(n);
    // `data_b64` é a última chave do cabeçalho (vazia) e o base64 nunca precisa de escape JSON: o
    // arquivo é cabeçalho + base64 em blocos + `"}`, idêntico a JSON.stringify({ ...header, data_b64 }).
    sink.write(`${headerJson.slice(0, -DATA_B64_EMPTY_TAIL.length)}"data_b64":"`);
    const writer = new SealedWriter(n, key, nonce, buildAad(source.exportedAt, source.stats, kdf, nonceB64), sink);
    await source.emit((piece) => writer.push(piece));
    writer.finish(source.jsonBytes);
    sink.write('"}');
  } finally {
    key.fill(0);
    sink?.close();
  }
}

/** `{"version":…,"recordings":[` — mesma ordem de chaves e mesmo texto de JSON.stringify do payload inteiro. */
const payloadHead = (version: number, app: string, exportedAt: string, doctor: DoctorProfile | null): string =>
  `{"version":${JSON.stringify(version)},"app":${JSON.stringify(app)},"exportedAt":${JSON.stringify(exportedAt)},` +
  `"doctor":${JSON.stringify(doctor ?? null)},"recordings":[`;
const payloadTail = (customTemplates: CustomTemplate[]): string =>
  `],"customTemplates":${JSON.stringify(customTemplates)}}`;

/**
 * Cifra um payload JÁ montado em memória e devolve o arquivo como string (dados pequenos e
 * testes). O app exporta por `exportBackup`, que lê o banco em lotes e escreve em blocos; os dois
 * usam o mesmo núcleo (`sealBackup`) e geram o mesmo formato.
 */
export async function encryptBackupPayload(
  payload: BackupPayload,
  passphrase: string
): Promise<string> {
  const { doctor, recordings, customTemplates } = payload;
  const head = payloadHead(payload.version, payload.app, payload.exportedAt, doctor);
  const tail = payloadTail(customTemplates);
  let jsonBytes = utf8Length(head) + utf8Length(tail) + Math.max(0, recordings.length - 1);
  for (const r of recordings) jsonBytes += utf8Length(JSON.stringify(r));
  const source: ExportSource = {
    exportedAt: payload.exportedAt,
    stats: payload.stats,
    jsonBytes,
    emit: async (push) => {
      push(head);
      recordings.forEach((r, i) => push(i === 0 ? JSON.stringify(r) : `,${JSON.stringify(r)}`));
      push(tail);
    },
  };
  const pieces: string[] = [];
  await sealBackup(source, passphrase, () => ({ write: (text) => { pieces.push(text); }, close: () => {} }));
  return pieces.join('');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Valida o envelope já parseado (estrutura + allow-list do KDF). Não toca em dados sensíveis. */
function validateEnvelope(raw: unknown): EncryptedBackupEnvelope {
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

function parseEnvelope(text: string): EncryptedBackupEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Arquivo inválido: não é um backup do Voice AI.');
  }
  return validateEnvelope(raw);
}

/** Salt, nonce e AAD do cabeçalho; recusa base64/tamanhos inválidos ANTES do KDF. */
function envelopeParams(n: NativeCrypto, env: EncryptedBackupEnvelope) {
  const salt = base64ToBytes(n, env.kdf.salt_b64);
  const nonce = base64ToBytes(n, env.cipher.nonce_b64);
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES) {
    throw new Error('Arquivo de backup incompleto ou corrompido.');
  }
  return { salt, nonce, aad: buildAad(env.exportedAt, env.stats, env.kdf, env.cipher.nonce_b64) };
}

const CORRUPT_CONTENT_MESSAGE = 'Conteúdo do backup corrompido.';

/**
 * Decifra o envelope (texto inteiro) e devolve o payload parseado. Senha errada e arquivo adulterado
 * são indistinguíveis no GCM e resultam em BackupPassphraseError. Caminho em memória: o restore
 * usa o fluxo em blocos (`restoreBackup`) e só cai aqui para arquivo fora do layout do exportador.
 * `env.data_b64` é zerado assim que vira bytes (libera a cópia de dezenas de MB).
 */
export async function decryptBackupText(text: string, passphrase: string): Promise<unknown> {
  if (text.length > MAX_BACKUP_BYTES) throw new Error(FILE_TOO_BIG_MESSAGE); // antes de parsear/derivar
  const env = parseEnvelope(text);
  const n = loadNativeCrypto();
  const { salt, nonce, aad } = envelopeParams(n, env);
  // `sealed`/`plain` (dezenas de MB cada) são soltos assim que deixam de ser usados: a referência
  // some antes do JSON.parse, que é onde o pico de memória acontece.
  let sealed: Uint8Array | null = base64ToBytes(n, env.data_b64);
  env.data_b64 = '';
  if (sealed.length < GCM_TAG_BYTES) throw new Error('Arquivo de backup incompleto ou corrompido.');

  const key = await deriveKey(n, passphrase, salt, env.kdf.N);
  let plain: Uint8Array | null;
  try {
    plain = gcmDecrypt(n, key, nonce, sealed, aad);
  } catch {
    throw new BackupPassphraseError();
  } finally {
    key.fill(0);
    sealed.fill(0);
    sealed = null;
  }
  if (plain.length > MAX_BACKUP_BYTES) {
    plain.fill(0);
    throw new Error('Backup excede o limite de 50 MB.');
  }
  let json: string;
  try {
    json = decodeUtf8Strict(n, plain); // UTF-8 estrito, nativo (sem TextDecoder em JS)
  } catch {
    throw new Error(CORRUPT_CONTENT_MESSAGE);
  } finally {
    plain.fill(0);
    plain = null;
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(CORRUPT_CONTENT_MESSAGE);
  }
}

// ─── Arquivo cifrado lido em blocos (restore) ────────────────────────────────

/** Abertura do campo no arquivo gerado pelo exportador (cabeçalho compacto, `data_b64` por último). */
const DATA_B64_OPEN = '"data_b64":"';

interface SealedFile {
  env: EncryptedBackupEnvelope;
  handle: FileHandle;
  /** Byte onde começa o base64 do ciphertext||tag. */
  dataStart: number;
  /** Quantos caracteres base64 há até as aspas finais. */
  dataChars: number;
}

const isJsonWhitespace = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Abre o arquivo e localiza o base64 SEM ler o conteúdo: cabeçalho nos primeiros KB (até
 * `"data_b64":"`) e as aspas finais no fim. Devolve null se o arquivo não tem o layout do
 * exportador (cabeçalho grande/reformatado, outras chaves depois do dado, não é JSON): o chamador
 * usa o caminho em memória, que aceita qualquer JSON válido. Erros de VALIDAÇÃO (v1, allow-list do
 * KDF…) lançam daqui, antes de qualquer KDF. Quem recebe o SealedFile fecha o handle.
 */
function openSealedFile(file: File): SealedFile | null {
  const handle = file.open();
  let keep = false;
  try {
    const size = handle.size ?? 0;
    handle.offset = 0;
    const head = latin1(handle.readBytes(Math.min(size, HEADER_PROBE_BYTES)));
    const at = head.indexOf(DATA_B64_OPEN);
    if (at < 0 || /[^\x00-\x7f]/.test(head.slice(0, at))) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(`${head.slice(0, at)}"data_b64":""}`);
    } catch {
      return null;
    }
    const dataStart = at + DATA_B64_OPEN.length;
    const tailLen = Math.min(size - dataStart, 64);
    if (tailLen < 2) return null;
    handle.offset = size - tailLen;
    const tail = handle.readBytes(tailLen);
    let i = tail.length - 1;
    while (i >= 0 && isJsonWhitespace(tail[i])) i--;
    if (i < 0 || tail[i] !== 0x7d) return null; // }
    i--;
    while (i >= 0 && isJsonWhitespace(tail[i])) i--;
    if (i < 0 || tail[i] !== 0x22) return null; // "
    const env = validateEnvelope(raw);
    keep = true;
    return { env, handle, dataStart, dataChars: size - tailLen + i - dataStart };
  } finally {
    if (!keep) handle.close();
  }
}

/** Lê `chars` caracteres base64 da posição atual do handle e decodifica (nativo, estrito). */
function readBase64Bytes(n: NativeCrypto, handle: FileHandle, chars: number): Uint8Array {
  const raw = handle.readBytes(chars);
  if (raw.length !== chars) throw new Error('Arquivo de backup incompleto ou corrompido.');
  return base64ToBytes(n, n.bufferToString(raw.buffer as ArrayBuffer, 'utf8', raw.byteOffset, raw.byteOffset + raw.length));
}

/**
 * A tag GCM (últimos 16 bytes do ciphertext||tag) e o tamanho do ciphertext, lidos das últimas
 * 32 colunas base64 — a tag é conhecida antes do primeiro bloco, como no `setAuthTag` do one-shot.
 * Recusa antes do KDF base64 torto e arquivo curto demais para conter a tag.
 */
function readSealedTail(n: NativeCrypto, sealed: SealedFile): { tag: Uint8Array; cipherBytes: number } {
  const { handle, dataStart, dataChars } = sealed;
  if (dataChars % 4 !== 0) throw new Error('Arquivo de backup corrompido (base64 inválido).');
  if (dataChars < 24) throw new Error('Arquivo de backup incompleto ou corrompido.'); // < 16 bytes
  const window = Math.min(32, dataChars);
  handle.offset = dataStart + dataChars - window;
  const bytes = readBase64Bytes(n, handle, window);
  if (bytes.length < GCM_TAG_BYTES) throw new Error('Arquivo de backup incompleto ou corrompido.');
  const padding = (window / 4) * 3 - bytes.length;
  return { tag: bytes.slice(bytes.length - GCM_TAG_BYTES), cipherBytes: (dataChars / 4) * 3 - padding - GCM_TAG_BYTES };
}

/** Decifra o ciphertext do arquivo em blocos de B64_CHUNK_CHARS; só uma janela do arquivo na memória por vez. */
class SealedReader {
  private readonly decipher: GcmDecryptStream;
  private charsLeft: number;
  private bytesLeft: number;
  private finished = false;

  constructor(
    private readonly n: NativeCrypto,
    private readonly sealed: SealedFile,
    key: Uint8Array,
    nonce: Uint8Array,
    aad: Uint8Array,
    tag: Uint8Array,
    cipherBytes: number
  ) {
    this.decipher = gcmDecryptStream(n, key, nonce, aad, tag);
    this.charsLeft = sealed.dataChars;
    this.bytesLeft = cipherBytes;
    sealed.handle.offset = sealed.dataStart;
  }

  /**
   * Próximo bloco de plaintext (não vazio), ou null depois de CONFIRMAR a tag: tag errada = senha
   * errada ou arquivo adulterado (BackupPassphraseError). O plaintext devolvido antes do null ainda
   * não é autêntico — ver GcmDecryptStream.
   */
  next(): Uint8Array | null {
    for (;;) {
      if (this.charsLeft === 0) {
        if (!this.finished) {
          this.finished = true;
          try {
            this.decipher.finish();
          } catch {
            throw new BackupPassphraseError();
          }
        }
        return null;
      }
      const chars = Math.min(B64_CHUNK_CHARS, this.charsLeft);
      const bytes = readBase64Bytes(this.n, this.sealed.handle, chars);
      this.charsLeft -= chars;
      const take = Math.min(bytes.length, this.bytesLeft); // o último bloco traz também a tag
      if (take === 0) continue;
      this.bytesLeft -= take;
      const plain = this.decipher.update(take === bytes.length ? bytes : bytes.subarray(0, take));
      if (plain.length > 0) return plain;
    }
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

type ExportRecording = BackupPayload['recordings'][number];

const createdAtOf = (fileName: string): string | null => {
  const match = fileName.match(/recording_(\d+)\.m4a/);
  return match ? new Date(parseInt(match[1])).toISOString() : null;
};

/** Gravação pronta para o arquivo: campo que não decifrou vira null e marca o item como ilegível (uma vez). */
function cleanRecording(meta: RecordingMeta): { rec: ExportRecording; unreadable: boolean } {
  let unreadable = false;
  const bad = () => { unreadable = true; };
  const rec = {
    ...meta,
    customName: readable(meta.customName, bad),
    transcript: readable(meta.transcript, bad),
    summary: readable(meta.summary, bad),
    patientName: readable(meta.patientName, bad),
    createdAt: createdAtOf(meta.fileName),
  };
  return { rec, unreadable };
}

/** Contagens do cabeçalho (stats) e do tamanho do JSON, acumuladas gravação a gravação. */
interface Tally {
  recordings: number;
  transcribed: number;
  processed: number;
  finalized: number;
  unreadable: number;
  bytes: number;
  patients: Set<string>;
}

const newTally = (): Tally => ({
  recordings: 0, transcribed: 0, processed: 0, finalized: 0, unreadable: 0, bytes: 0, patients: new Set(),
});

/** Contabiliza a gravação e devolve o JSON dela (com a vírgula separadora, exceto a primeira). */
function tallyRecording(t: Tally, rec: ExportRecording, unreadable: boolean): string {
  t.recordings++;
  if (rec.transcript) t.transcribed++;
  if (rec.summary) t.processed++;
  if (rec.summary && rec.transcript) t.finalized++;
  if (rec.patientName) t.patients.add(rec.patientName);
  if (unreadable) t.unreadable++;
  const json = (t.recordings > 1 ? ',' : '') + JSON.stringify(rec);
  t.bytes += utf8Length(json);
  return json;
}

const statsOf = (t: Tally): BackupStats => ({
  totalRecordings: t.recordings,
  transcribed: t.transcribed,
  processed: t.processed,
  finalized: t.finalized,
  uniquePatients: t.patients.size,
});

const sameTally = (a: Tally, b: Tally): boolean =>
  a.recordings === b.recordings && a.transcribed === b.transcribed && a.processed === b.processed &&
  a.finalized === b.finalized && a.unreadable === b.unreadable && a.bytes === b.bytes &&
  a.patients.size === b.patients.size;

/** Lê e decifra as gravações em lotes de EXPORT_BATCH: a memória cresce com o lote, não com o banco. */
async function scanRecordings(
  fileNames: string[],
  visit: (rec: ExportRecording, unreadable: boolean) => void
): Promise<void> {
  for (let i = 0; i < fileNames.length; i += EXPORT_BATCH) {
    for (const meta of await getRecordingsMetaByNames(fileNames.slice(i, i + EXPORT_BATCH))) {
      const { rec, unreadable } = cleanRecording(meta);
      visit(rec, unreadable);
    }
  }
}

interface ExportPlan {
  source: ExportSource;
  recordings: number;
  templates: number;
  /** Itens (gravações + templates) com algum campo ilegível — cada item conta uma vez. */
  unreadable: number;
}

/**
 * Prepara a exportação SEM montar o payload: passe 1 sobre o banco (em lotes) só para contar —
 * stats e tamanho exato do JSON têm de estar no cabeçalho autenticado antes da primeira cifra e o
 * limite de 50 MB vale antes do KDF. O passe 2 (`source.emit`) relê o banco, serializa e cifra
 * aos pedaços; se os dados mudaram entre os passes, a exportação é abortada (cabeçalho e
 * conteúdo precisam ser coerentes). Gravações que não decifram não entram; templates idem.
 */
async function planExport(): Promise<ExportPlan> {
  const exportedAt = new Date().toISOString();
  const doctor = await getDoctorProfile().catch(() => null);
  const rawTemplates = await getCustomTemplates().catch(() => []);

  let unreadableTemplates = 0;
  const customTemplates: CustomTemplate[] = [];
  for (const t of rawTemplates) {
    let bad = false;
    const mark = () => { bad = true; };
    const name = readable(t.name, mark);
    const systemPrompt = readable(t.systemPrompt, mark);
    const description = readable(t.description, mark);
    if (bad) unreadableTemplates++;
    if (name === null || systemPrompt === null) continue; // campos obrigatórios ilegíveis
    customTemplates.push({ ...t, name, systemPrompt, description });
  }

  // Mais recentes primeiro (empate: ordem de inserção; o sort do motor é estável).
  const fileNames = (await getRecordingFileNames())
    .map((name) => {
      const createdAt = createdAtOf(name);
      return { name, time: createdAt ? Date.parse(createdAt) : 0 };
    })
    .sort((a, b) => b.time - a.time)
    .map((x) => x.name);

  const first = newTally();
  await scanRecordings(fileNames, (rec, unreadable) => { tallyRecording(first, rec, unreadable); });

  const head = payloadHead(BACKUP_VERSION, 'voice-ai-recorder', exportedAt, doctor);
  const tail = payloadTail(customTemplates);
  const source: ExportSource = {
    exportedAt,
    stats: statsOf(first),
    jsonBytes: utf8Length(head) + utf8Length(tail) + first.bytes,
    emit: async (push) => {
      push(head);
      const second = newTally();
      await scanRecordings(fileNames, (rec, unreadable) => { push(tallyRecording(second, rec, unreadable)); });
      if (!sameTally(first, second)) throw new Error(DATA_CHANGED_MESSAGE);
      push(tail);
    },
  };
  return {
    source,
    recordings: first.recordings,
    templates: customTemplates.length,
    unreadable: first.unreadable + unreadableTemplates,
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
 * Lança Error (mensagem em pt-BR) em qualquer falha; nunca grava texto puro. O arquivo é
 * escrito em blocos (handle do expo-file-system): nunca existe a string/bytes do arquivo inteiro.
 */
export async function exportBackup(passphrase: string): Promise<ExportOutcome> {
  const weak = validatePassphrase(passphrase);
  if (weak) throw new Error(weak);

  const plan = await planExport();
  const outcome = { recordings: plan.recordings, templates: plan.templates, unreadable: plan.unreadable };
  if (outcome.recordings === 0 && outcome.templates === 0) {
    return { status: 'empty', ...outcome };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const created: File[] = [];
  try {
    await sealBackup(plan.source, passphrase, (n) => {
      const target = createExportFile(`voice-ai-recorder-backup-${stamp}.enc.json`);
      created.push(target);
      const handle = target.open();
      return {
        write: (text) => handle.writeBytes(new Uint8Array(n.stringToBuffer(text, 'utf8'))),
        close: () => handle.close(),
      };
    });
  } catch (err) {
    try {
      created[0]?.delete(); // não deixa no cache um arquivo parcial
    } catch {
      // best-effort
    }
    throw err;
  }
  const file = created[0];

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

const NOT_RECOGNIZED_MESSAGE = 'Conteúdo do backup não reconhecido.';
const STREAMED_KEYS: ReadonlySet<string> = new Set(['recordings', 'customTemplates']);

/** Entrega os itens do payload (campos e elementos dos arrays de registros) na ordem do documento. */
type RestoreSource = (onItem: (item: JsonItem) => void | Promise<void>) => Promise<void>;

/** Plaintext do envelope como texto, em pedaços: UTF-8 estrito sem partir caracteres na borda do bloco. */
class PlainTextReader {
  private readonly decoder: Utf8StreamDecoder;
  private ended = false;

  constructor(n: NativeCrypto, private readonly reader: SealedReader) {
    this.decoder = new Utf8StreamDecoder(n);
  }

  pull(): string | null {
    while (!this.ended) {
      const chunk = this.reader.next();
      if (chunk === null) {
        this.ended = true;
        try {
          this.decoder.end();
        } catch {
          throw new Error(CORRUPT_CONTENT_MESSAGE);
        }
        return null;
      }
      let text: string;
      try {
        text = this.decoder.push(chunk);
      } catch {
        throw new Error(CORRUPT_CONTENT_MESSAGE);
      } finally {
        chunk.fill(0);
      }
      if (text.length > 0) return text;
    }
    return null;
  }
}

/** Fonte em fluxo: decifra, decodifica e fatia o JSON por registro (memória ∝ um registro + um bloco). */
function streamedSource(n: NativeCrypto, reader: SealedReader): RestoreSource {
  return async (onItem) => {
    const text = new PlainTextReader(n, reader);
    try {
      await readJsonObject(() => text.pull(), STREAMED_KEYS, onItem);
    } catch (err) {
      if (err instanceof JsonSliceError) throw new Error(CORRUPT_CONTENT_MESSAGE);
      if (err instanceof JsonNotObjectError) throw new Error(NOT_RECOGNIZED_MESSAGE);
      throw err;
    }
  };
}

/** Fonte sobre um payload já parseado em memória (arquivo fora do layout do exportador). */
function parsedSource(parsed: Record<string, unknown>): RestoreSource {
  return async (onItem) => {
    for (const [key, value] of Object.entries(parsed)) {
      if (STREAMED_KEYS.has(key) && Array.isArray(value)) {
        for (const element of value) await onItem({ key, value: element, element: true });
      } else {
        await onItem({ key, value, element: false });
      }
    }
  };
}

/**
 * Aplica os itens numa transação exclusiva, em lotes de RESTORE_BATCH registros: cada lote é
 * validado, só então recifrado com a chave deste aparelho e gravado, e solto antes do próximo.
 * Ou entra tudo ou nada: qualquer falha (inclusive JSON ou tag ruim no meio do fluxo) desfaz o que
 * os lotes anteriores já gravaram.
 */
async function applyBackupItems(source: RestoreSource): Promise<RestoreResult> {
  let restoredRecordings = 0;
  let restoredTemplates = 0;
  let alreadyPresent = 0;
  let unreadable = 0;
  let version: unknown;
  let app: unknown;
  let doctorRaw: unknown;
  const now = new Date().toISOString();

  // Carrega a chave do aparelho (SecureStore) fora da transação exclusiva: dentro dela o encrypt
  // só faz cifra nativa síncrona (promessas já resolvidas).
  await encrypt('');

  const encOpt = (v: string | null) => (v ? encrypt(v) : Promise.resolve(null));

  const apply = async (txn: TxnLike) => {
    restoredRecordings = 0;
    restoredTemplates = 0;
    alreadyPresent = 0;
    unreadable = 0;
    version = app = doctorRaw = undefined;
    let recordings: RestoreRecording[] = [];
    let templates: RestoreTemplate[] = [];

    const flushRecordings = async () => {
      const batch = recordings;
      recordings = [];
      for (const r of batch) {
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
        const [customName, transcript, summary, patientName] = await Promise.all([
          encOpt(r.customName), encOpt(r.transcript), encOpt(r.summary), encOpt(r.patientName),
        ]);
        await txn.runAsync(
          `INSERT OR REPLACE INTO recordings
             (fileName, customName, transcript, summary, templateId, patientName, durationSecs, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.fileName, customName, transcript, summary, r.templateId, patientName, r.durationSecs, r.updatedAt ?? now]
        );
        // Re-criação explícita: o item restaurado não pode ser tratado como excluído.
        await txn.runAsync(`DELETE FROM pending_deletions WHERE kind = 'recording' AND key = ?`, [r.fileName]);
        restoredRecordings++;
      }
    };

    const flushTemplates = async () => {
      const batch = templates;
      templates = [];
      for (const t of batch) {
        const existing = await txn.getFirstAsync<{ name: string | null; description: string | null; systemPrompt: string | null }>(
          'SELECT name, description, systemPrompt FROM custom_templates WHERE id = ?',
          [t.id]
        );
        if (existing && nonEmpty(existing.name, existing.description, existing.systemPrompt)) {
          alreadyPresent++;
          continue;
        }
        const [name, description, systemPrompt] = await Promise.all([
          encrypt(t.name), encOpt(t.description), encrypt(t.systemPrompt),
        ]);
        await txn.runAsync(
          `INSERT OR REPLACE INTO custom_templates (id, name, description, systemPrompt, createdAt)
           VALUES (?, ?, ?, ?, ?)`,
          [t.id, name, description, systemPrompt, t.createdAt]
        );
        await txn.runAsync(`DELETE FROM pending_deletions WHERE kind = 'template' AND key = ?`, [t.id]);
        restoredTemplates++;
      }
    };

    await source(async (item) => {
      if (item.element && item.key === 'recordings') {
        const rec = sanitizeRecording(item.value);
        if (!rec) unreadable++;
        else if (recordings.push(rec) >= RESTORE_BATCH) await flushRecordings();
      } else if (item.element && item.key === 'customTemplates') {
        const tpl = sanitizeTemplate(item.value);
        if (!tpl) unreadable++;
        else if (templates.push(tpl) >= RESTORE_BATCH) await flushTemplates();
      } else if (item.key === 'version') {
        version = item.value;
      } else if (item.key === 'app') {
        app = item.value;
      } else if (item.key === 'doctor') {
        doctorRaw = item.value;
      }
    });
    await flushRecordings();
    await flushTemplates();
    // Só depois do documento inteiro (erro de sintaxe tem precedência); lança dentro da
    // transação: nada do que os lotes gravaram sobrevive a um arquivo que não é um backup nosso.
    if (version !== BACKUP_VERSION || app !== 'voice-ai-recorder') throw new Error(NOT_RECOGNIZED_MESSAGE);
  };

  const db = await getDb();
  if (typeof db.withExclusiveTransactionAsync === 'function') {
    await db.withExclusiveTransactionAsync(async (txn) => { await apply(txn); });
  } else {
    await db.withTransactionAsync(() => apply(db));
  }

  // Perfil profissional: só preenche se o aparelho ainda não tem perfil.
  let doctorRestored = false;
  const doctor = sanitizeDoctor(doctorRaw);
  if (doctor) {
    const local = await getDoctorProfile();
    const localEmpty = Object.values(local).every((v) => (typeof v === 'boolean' ? !v : v === ''));
    if (localEmpty && Object.values(doctor).some((v) => (typeof v === 'boolean' ? v : v !== ''))) {
      await setDoctorProfile(doctor);
      doctorRestored = true;
    }
  }

  if (restoredRecordings > 0 || restoredTemplates > 0) notifyDataChanged();
  return { restoredRecordings, restoredTemplates, alreadyPresent, unreadable, doctorRestored };
}

/**
 * Lê o arquivo em blocos (nunca o texto inteiro): o ciphertext é decifrado por pedaços de ~192 KB e o
 * JSON é fatiado por registro. Como o GCM só autentica no fim, há DOIS passes de decifra: o 1º só
 * confirma a tag (senha errada/adulteração viram BackupPassphraseError sem tocar no banco; AES nativo
 * custa poucos ms por MB); o 2º alimenta o parser e a transação, que só faz commit depois de o
 * 2º passe fechar a tag de novo.
 */
async function restoreFile(file: File, passphrase: string): Promise<RestoreResult> {
  const sealed = openSealedFile(file);
  if (!sealed) {
    // Fora do layout do exportador (ex.: JSON reformatado): caminho em memória, aceita qualquer JSON válido.
    const parsed = await decryptBackupText(await file.text(), passphrase);
    if (!isRecord(parsed)) throw new Error(NOT_RECOGNIZED_MESSAGE);
    return applyBackupItems(parsedSource(parsed));
  }
  try {
    const n = loadNativeCrypto();
    const { salt, nonce, aad } = envelopeParams(n, sealed.env);
    const { tag, cipherBytes } = readSealedTail(n, sealed);
    const key = await deriveKey(n, passphrase, salt, sealed.env.kdf.N);
    try {
      const open = () => new SealedReader(n, sealed, key, nonce, aad, tag, cipherBytes);
      const verify = open();
      for (let chunk = verify.next(); chunk !== null; chunk = verify.next()) chunk.fill(0);
      return await applyBackupItems(streamedSource(n, open()));
    } finally {
      key.fill(0);
    }
  } finally {
    sealed.handle.close();
  }
}

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
    const result = await restoreFile(file, passphrase);
    succeeded = true;
    return result;
  } finally {
    // Só descarta a cópia temporária no sucesso: em falha (ex.: senha errada) o usuário
    // tenta de novo com o mesmo arquivo; o chamador descarta ao cancelar.
    if (succeeded) discardPickedFile(uri);
  }
}
