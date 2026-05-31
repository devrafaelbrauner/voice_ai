/**
 * db-crypto.ts — Criptografia AES-256-GCM para campos sensíveis do SQLite
 *
 * Estratégia:
 *   - Usa Web Crypto API (crypto.subtle) quando disponível no runtime.
 *   - Em ambientes sem suporte (Hermes antigo / Android sem polyfill),
 *     faz graceful fallback: dados são armazenados/lidos em texto puro,
 *     sem crash. Instale react-native-quick-crypto para ativar criptografia.
 *   - A chave AES é gerada uma vez e armazenada no expo-secure-store
 *     (iOS Keychain / Android Keystore — hardware-backed em dispositivos modernos).
 *   - Cada campo sensível é cifrado individualmente com IV único (12 bytes).
 *   - Formato no banco: "enc1:<iv_base64>:<ciphertext_base64>"
 *   - Valores sem prefixo "enc1:" são tratados como legado (pré-criptografia)
 *     e retornados como texto puro sem erro — compatível com migração v7.
 *
 * Campos protegidos: transcript, summary, patientName, customName
 * Campos NÃO protegidos (metadados): fileName, templateId, durationSecs, updatedAt
 */

import * as SecureStore from 'expo-secure-store';
import { logDebug, logWarn } from './log';

// ─── Constantes ───────────────────────────────────────────────────────────────

const KEY_STORE_KEY = 'db_aes_key_v1';
const ENC_PREFIX = 'enc1:';

// ─── Detecção de suporte ao Web Crypto API ────────────────────────────────────

/**
 * Retorna true se crypto.subtle estiver disponível neste runtime.
 * Hermes antigo (RN < 0.71) e alguns builds Android não têm crypto.subtle.
 * Nesse caso o módulo opera em modo "sem criptografia" sem lançar exceções.
 */
function hasCryptoSubtle(): boolean {
  try {
    return (
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as any).crypto !== 'undefined' &&
      typeof (globalThis as any).crypto.subtle !== 'undefined'
    );
  } catch {
    return false;
  }
}

function getCrypto(): Crypto {
  return (globalThis as any).crypto as Crypto;
}

// ─── Cache em memória da CryptoKey (evita round-trip ao SecureStore a cada op) ─

let cachedKey: CryptoKey | null = null;
let cryptoAvailable: boolean | null = null; // cached após primeira verificação

function isCryptoAvailable(): boolean {
  if (cryptoAvailable === null) {
    cryptoAvailable = hasCryptoSubtle();
    if (!cryptoAvailable) {
      logWarn(
        'db-crypto',
        'crypto.subtle não disponível neste runtime. ' +
        'Dados serão armazenados sem criptografia. ' +
        'Instale react-native-quick-crypto para habilitar AES-256-GCM.'
      );
    }
  }
  return cryptoAvailable;
}

// ─── Helpers base64 ──────────────────────────────────────────────────────────

function uint8ToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}

// ─── Gerenciamento de chave ───────────────────────────────────────────────────

/**
 * Obtém (ou gera) a chave AES-256-GCM do SecureStore.
 * A chave é cacheada em memória para evitar I/O repetitivo.
 * Lança erro se crypto.subtle não estiver disponível.
 */
export async function getOrCreateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const subtle = getCrypto().subtle;
  let keyB64 = await SecureStore.getItemAsync(KEY_STORE_KEY);

  if (!keyB64) {
    // Primeira execução: gera chave nova
    const key = await subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const exported = await subtle.exportKey('raw', key);
    keyB64 = uint8ToBase64(new Uint8Array(exported));
    await SecureStore.setItemAsync(KEY_STORE_KEY, keyB64);
    cachedKey = key;
    return key;
  }

  const keyBytes = base64ToUint8(keyB64);
  // Slice cria um ArrayBuffer puro (sem SharedArrayBuffer) — necessário para crypto.subtle
  const keyBuffer = keyBytes.buffer.slice(
    keyBytes.byteOffset,
    keyBytes.byteOffset + keyBytes.byteLength
  ) as ArrayBuffer;
  const key = await subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  cachedKey = key;
  return key;
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Cifra uma string com AES-256-GCM.
 * Retorna "enc1:<iv_b64>:<ciphertext_b64>".
 * Se crypto.subtle não estiver disponível, retorna o texto puro sem cifrar.
 */
export async function encrypt(plaintext: string): Promise<string> {
  if (!isCryptoAvailable()) {
    // Fallback: armazena texto puro. Sem crash, sem perda de dados.
    return plaintext;
  }

  // Protege todo o caminho — se qualquer API de crypto falhar no runtime,
  // armazena texto puro em vez de propagar exceção (que poderia crashar a UI).
  try {
    const subtle = getCrypto().subtle;
    const key = await getOrCreateKey();
    const iv = getCrypto().getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

    const ivB64 = uint8ToBase64(iv);
    const ctB64 = uint8ToBase64(new Uint8Array(ciphertext));
    logDebug('db-crypto', 'encrypt OK, iv.len=12, ct.len=', new Uint8Array(ciphertext).length);
    return `${ENC_PREFIX}${ivB64}:${ctB64}`;
  } catch {
    logWarn('db-crypto', 'encrypt: falha de crypto no runtime — armazenando texto puro.');
    return plaintext;
  }
}

/**
 * Decifra um valor armazenado.
 * - Se o valor começa com "enc1:" → decifra com AES-GCM.
 * - Caso contrário → retorna como texto puro (legado pré-migração v7).
 * - Se crypto.subtle não estiver disponível e o valor for cifrado, retorna vazio.
 * - Se a chave for diferente da que cifrou o dado (ex.: sync cross-device),
 *   retorna vazio com log — evita crash e não expõe ciphertext.
 */
export async function decrypt(stored: string): Promise<string> {
  if (!stored.startsWith(ENC_PREFIX)) {
    // Valor legado / texto puro — retorna sem erro
    return stored;
  }

  if (!isCryptoAvailable()) {
    // Não consegue decifrar sem crypto.subtle.
    // Retorna string vazia para não expor dados cifrados ilegíveis.
    logWarn('db-crypto', 'decrypt: crypto.subtle indisponível, retornando vazio');
    return '';
  }

  // Corpo inteiro protegido — NENHUM caminho pode lançar (atob, importKey,
  // decode, etc.). Uma exceção aqui propagaria pela leitura do DB e poderia
  // crashar a tela; preferimos retornar vazio e logar.
  try {
    const subtle = getCrypto().subtle;
    const rest = stored.slice(ENC_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) {
      // Formato inesperado — retorna bruto para não perder dados
      return stored;
    }

    const ivB64 = rest.slice(0, colonIdx);
    const ctB64 = rest.slice(colonIdx + 1);
    const ivRaw = base64ToUint8(ivB64);
    const ctRaw = base64ToUint8(ctB64);

    // Slice cria ArrayBuffer puro para compatibilidade com crypto.subtle
    const iv = ivRaw.buffer.slice(ivRaw.byteOffset, ivRaw.byteOffset + ivRaw.byteLength) as ArrayBuffer;
    const ct = ctRaw.buffer.slice(ctRaw.byteOffset, ctRaw.byteOffset + ctRaw.byteLength) as ArrayBuffer;

    const key = await getOrCreateKey();
    const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(decrypted);
  } catch {
    // Seg #1: falha de decriptação — chave errada (dado cifrado em outro dispositivo),
    // dado corrompido, ou API de crypto indisponível/parcial no runtime.
    // Retorna sentinel visível em vez de string vazia silenciosa, para que a
    // UI possa exibir um aviso ao médico em vez de mostrar campo em branco.
    logWarn(
      'db-crypto',
      'decrypt: falha (chave de outro dispositivo, dado corrompido ou crypto indisponível).'
    );
    return DECRYPT_FAILED_SENTINEL;
  }
}

/**
 * Sentinel retornado por `decrypt()` quando a decriptação falha.
 * Use `isDecryptFailed()` para detectar este caso na UI.
 */
export const DECRYPT_FAILED_SENTINEL = '__DECRYPT_FAILED__';

/** Retorna true se o valor é o sentinel de falha de decriptação. */
export function isDecryptFailed(value: string): boolean {
  return value === DECRYPT_FAILED_SENTINEL;
}

/**
 * Verifica se um valor já está cifrado.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/**
 * Cifra apenas se ainda não estiver cifrado (idempotente — seguro para migrações).
 */
export async function encryptIfNeeded(value: string): Promise<string> {
  if (isEncrypted(value)) return value;
  return encrypt(value);
}
