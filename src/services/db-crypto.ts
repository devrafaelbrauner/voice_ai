/**
 * db-crypto.ts — Criptografia AES-256-GCM para campos sensíveis do SQLite
 *
 * Estratégia:
 *   - AES-256-GCM NATIVO (OpenSSL via react-native-quick-crypto, chamada síncrona por JSI,
 *     sem ponte assíncrona por campo) e base64 nativo: em JS puro (@noble) o Hermes fazia
 *     ~0,7 MB/s e parava a thread JS ao ler/gravar dezenas de MB. Sem fallback para JS: sem o
 *     módulo no binário, encrypt/decrypt lançam erro claro (ver native-crypto.ts).
 *     O texto decifrado vira string pelo conversor UTF-8 nativo (decodeUtf8Strict), nunca pelo
 *     TextDecoder em JS (~1,6 ms por campo de 4,5 KB no Hermes).
 *     Hermes/React Native não expõe crypto.subtle, então WebCrypto não é usado.
 *   - Aleatoriedade (chave de 32 bytes, IV de 12 bytes) vem de expo-crypto
 *     (CSPRNG do sistema operacional) — nunca Math.random.
 *   - A chave AES é gerada uma vez e armazenada no expo-secure-store
 *     (iOS Keychain / Android Keystore — hardware-backed em dispositivos modernos)
 *     como base64 de 32 bytes brutos.
 *   - Cada campo sensível é cifrado individualmente com IV único (12 bytes).
 *   - Formato no banco: "enc1:<iv_base64>:<ciphertext||tag_base64>"
 *     (mesmo layout do WebCrypto AES-GCM: tag de 16 bytes ao final).
 *   - Valores sem prefixo "enc1:" são tratados como legado (pré-criptografia)
 *     e retornados como texto puro sem erro — compatível com migração v7.
 *   - FAIL CLOSED: encrypt() lança erro se a chave, o RNG ou a cifra falharem;
 *     nunca devolve o texto puro como se estivesse cifrado.
 *
 * Campos protegidos: transcript, summary, patientName, customName
 * Campos NÃO protegidos (metadados): fileName, templateId, durationSecs, updatedAt
 */

import * as SecureStore from 'expo-secure-store';
import { getRandomValues } from 'expo-crypto';
import { loadNativeCrypto, gcmEncrypt, gcmDecrypt, decodeUtf8Strict } from './native-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logWarn } from './log';

// ─── Constantes ───────────────────────────────────────────────────────────────

const KEY_STORE_KEY = 'db_aes_key_v1';
const ENC_PREFIX = 'enc1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_MARKER_KEY = 'db_aes_key_created_v1';

// ─── Helpers base64 (só a chave de 32 bytes; o conteúdo usa o base64 nativo) ──
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

/** Promise compartilhada (single-flight) — evita gerar duas chaves em chamadas concorrentes. */
let keyPromise: Promise<Uint8Array> | null = null;

/**
 * A chave AES foi criada anteriormente neste dispositivo (marcador presente),
 * mas o SecureStore não a devolve mais (backup restaurado, Keystore resetado...).
 * Gerar outra chave orfanaria todos os dados cifrados, então nunca regeneramos.
 */
export class KeyLostError extends Error {
  constructor() {
    super(
      'A chave de criptografia deste dispositivo foi perdida. ' +
      'Os dados armazenados neste dispositivo e já sincronizados não podem mais ser lidos. ' +
      'Novas gravações não podem ser salvas até que os dados do app sejam apagados (reinstalar o app ou limpar os dados).'
    );
    this.name = 'KeyLostError';
    Object.setPrototypeOf(this, KeyLostError.prototype);
  }
}

async function loadOrCreateKey(): Promise<Uint8Array> {
  const keyB64 = await SecureStore.getItemAsync(KEY_STORE_KEY);

  if (keyB64) {
    const keyBytes = base64ToUint8(keyB64);
    if (keyBytes.length !== KEY_BYTES) {
      // Nunca regenerar silenciosamente: isso orfanaria todos os dados já cifrados.
      throw new Error(
        `Chave de criptografia armazenada inválida (${keyBytes.length} bytes, esperado ${KEY_BYTES}).`
      );
    }
    // Instalações anteriores ao marcador: registra (best-effort) que a chave existe.
    AsyncStorage.setItem(KEY_MARKER_KEY, '1').catch(() => {});
    return keyBytes;
  }

  // Sem chave no SecureStore: só é legítimo criar se nunca criamos antes.
  // Se a leitura do marcador falhar, propaga (fail closed).
  if ((await AsyncStorage.getItem(KEY_MARKER_KEY)) !== null) {
    throw new KeyLostError();
  }

  // Primeira execução: gera chave nova e persiste antes de usá-la.
  const key = getRandomValues(new Uint8Array(KEY_BYTES));
  await SecureStore.setItemAsync(KEY_STORE_KEY, uint8ToBase64(key));
  // Marcador só após a chave estar persistida. Se falhar, propaga: a chave já
  // persistida será reutilizada na próxima chamada (nenhum dado foi cifrado com ela).
  await AsyncStorage.setItem(KEY_MARKER_KEY, '1');
  return key;
}

/**
 * Obtém (ou gera) a chave AES-256 do SecureStore.
 * A chave é cacheada em memória (via promise) para evitar I/O repetitivo e
 * garantir uma única geração mesmo com chamadas concorrentes.
 * Em caso de falha a promise é descartada e a próxima chamada tenta de novo.
 */
function getKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    keyPromise = loadOrCreateKey().catch((err) => {
      keyPromise = null;
      throw err;
    });
  }
  return keyPromise;
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Cifra uma string com AES-256-GCM.
 * Retorna "enc1:<iv_b64>:<ciphertext||tag_b64>".
 * Lança erro (fail closed) se chave, RNG ou cifra falharem — nunca retorna texto puro.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const n = loadNativeCrypto();
  const key = await getKey();
  const iv = getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = gcmEncrypt(n, key, iv, new TextEncoder().encode(plaintext));
  return `${ENC_PREFIX}${n.fromByteArray(iv)}:${n.fromByteArray(sealed)}`;
}

/**
 * Decifra um valor armazenado.
 * - Se o valor começa com "enc1:" → decifra com AES-GCM.
 * - Caso contrário → retorna como texto puro (legado pré-migração v7).
 * - Se a chave for diferente da que cifrou o dado (ex.: sync cross-device),
 *   ou o dado estiver corrompido, retorna DECRYPT_FAILED_SENTINEL com log —
 *   evita crash e não expõe ciphertext.
 */
export async function decrypt(stored: string): Promise<string> {
  if (!stored.startsWith(ENC_PREFIX)) {
    // Valor legado / texto puro — retorna sem erro
    return stored;
  }

  // Módulo nativo ausente é erro de binário, não "dado corrompido": propaga (nunca vira sentinel).
  const n = loadNativeCrypto();

  // Corpo inteiro protegido — falhas de dado/chave nunca lançam (base64, tag GCM, decode).
  // Uma exceção aqui propagaria pela leitura do DB e poderia crashar a tela.
  try {
    const rest = stored.slice(ENC_PREFIX.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) {
      // Formato inesperado — retorna bruto para não perder dados
      return stored;
    }

    const iv = n.toByteArray(rest.slice(0, colonIdx));
    const sealed = n.toByteArray(rest.slice(colonIdx + 1));

    const key = await getKey();
    // UTF-8 estrito pelo conversor nativo (o TextDecoder do Hermes/Expo é JS e domina o custo por campo).
    return decodeUtf8Strict(n, gcmDecrypt(n, key, iv, sealed));
  } catch {
    // Seg #1: falha de decriptação — chave errada (dado cifrado em outro dispositivo),
    // dado corrompido ou chave local indisponível/inválida.
    // Retorna sentinel visível em vez de string vazia silenciosa, para que a
    // UI possa exibir um aviso ao médico em vez de mostrar campo em branco.
    logWarn(
      'db-crypto',
      'decrypt: falha (chave de outro dispositivo, dado corrompido ou chave indisponível).'
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
