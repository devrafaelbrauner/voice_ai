// Cripto NATIVA compartilhada (backup.ts e db-crypto.ts): scrypt, AES-256-GCM e base64 vêm de
// react-native-quick-crypto (OpenSSL via JSI/Nitro) e react-native-quick-base64 — nunca de JS
// puro no Hermes (em JS o scrypt levava ~49 s e o AES-GCM ~0,7 MB/s, parando a thread JS).
//
// Carregamento sob demanda e SEM fallback: sem o módulo no binário (dev build/EAS build antigo,
// Expo Go) o erro é claro e imediato. As chamadas de cifra são síncronas via JSI (sem ponte
// assíncrona por campo); só o scrypt é assíncrono (thread pool do C++).

import type * as QuickCryptoModule from 'react-native-quick-crypto';
import type * as QuickBase64Module from 'react-native-quick-base64';
import { logWarn } from './log';

export type NativeCrypto = Pick<
  typeof QuickCryptoModule,
  'scrypt' | 'createCipheriv' | 'createDecipheriv' | 'Buffer' | 'bufferToString' | 'stringToBuffer' | 'timingSafeEqual'
> &
  Pick<typeof QuickBase64Module, 'toByteArray' | 'fromByteArray'>;

export const GCM_TAG_BYTES = 16;

let nativeCrypto: NativeCrypto | null = null;

/**
 * Carrega o módulo nativo na primeira necessidade (não no import do app: um import estático
 * derrubaria o app inteiro num binário sem o módulo). Lança Error em pt-BR se faltar.
 */
export function loadNativeCrypto(): NativeCrypto {
  if (nativeCrypto) return nativeCrypto;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const qc = require('react-native-quick-crypto') as typeof QuickCryptoModule;
    const b64 = require('react-native-quick-base64') as typeof QuickBase64Module;
    /* eslint-enable @typescript-eslint/no-require-imports */
    // Cria já o objeto nativo de cifra: sem o módulo no binário, falha aqui e não no meio da operação.
    qc.createCipheriv('aes-256-gcm', new Uint8Array(32), new Uint8Array(12));
    nativeCrypto = {
      scrypt: qc.scrypt,
      createCipheriv: qc.createCipheriv,
      createDecipheriv: qc.createDecipheriv,
      Buffer: qc.Buffer,
      bufferToString: qc.bufferToString,
      stringToBuffer: qc.stringToBuffer,
      timingSafeEqual: qc.timingSafeEqual,
      toByteArray: b64.toByteArray,
      fromByteArray: b64.fromByteArray,
    };
    // Sonda do conversor UTF-8 nativo (Utils do quick-crypto): falha aqui, e não no meio de uma restauração.
    decodeUtf8Strict(nativeCrypto, new Uint8Array([0x61, 0xc3, 0xa9]));
    return nativeCrypto;
  } catch (err) {
    nativeCrypto = null;
    // Só o nome do erro (a mensagem pode ecoar caminhos/dados); sem isso o diagnóstico some.
    logWarn('native-crypto', `módulo nativo indisponível (${err instanceof Error ? err.name : typeof err}).`);
    throw new Error(
      'A criptografia nativa não está disponível neste aplicativo. Instale a versão mais recente do app (é preciso um novo build nativo com react-native-quick-crypto).'
    );
  }
}

/** Visão Uint8Array pura (sem cópia) sobre o buffer nativo devolvido pela lib. */
export const asBytes = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength);

/** AES-256-GCM nativo (OpenSSL). Devolve ciphertext || tag(16), o mesmo layout do @noble/ciphers e do WebCrypto. */
export function gcmEncrypt(
  n: NativeCrypto,
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  const cipher = n.createCipheriv('aes-256-gcm', key, nonce);
  if (aad) cipher.setAAD(n.Buffer.from(aad));
  const body = cipher.update(plaintext);
  const rest = cipher.final();
  const tag = cipher.getAuthTag();
  const sealed = new Uint8Array(body.length + rest.length + tag.length);
  sealed.set(body, 0);
  sealed.set(rest, body.length);
  sealed.set(tag, body.length + rest.length);
  return sealed;
}

/** Decifra ciphertext || tag(16). Lança se a tag não confere (chave errada ou dado adulterado). */
export function gcmDecrypt(
  n: NativeCrypto,
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  if (sealed.length < GCM_TAG_BYTES) throw new Error('ciphertext curto demais');
  const split = sealed.length - GCM_TAG_BYTES;
  const decipher = n.createDecipheriv('aes-256-gcm', key, nonce);
  if (aad) decipher.setAAD(n.Buffer.from(aad));
  decipher.setAuthTag(n.Buffer.from(sealed.subarray(split)));
  const body = decipher.update(sealed.subarray(0, split));
  const rest = decipher.final();
  if (rest.length === 0) return asBytes(body);
  const plain = new Uint8Array(body.length + rest.length);
  plain.set(body, 0);
  plain.set(rest, body.length);
  return plain;
}

const UTF8_DECODE_CHUNK = 1 << 20;

const invalidUtf8 = () => new Error('UTF-8 inválido');

/** Um pedaço [from, to) de `buf`: decodifica no nativo e confere por ida e volta (ver decodeUtf8Strict). */
function decodeUtf8Piece(n: NativeCrypto, buf: ArrayBuffer, from: number, to: number): string {
  const text = n.bufferToString(buf, 'utf8', from, to);
  const back = new Uint8Array(n.stringToBuffer(text, 'utf8'));
  if (back.length !== to - from || !n.timingSafeEqual(back, new Uint8Array(buf, from, to - from))) throw invalidUtf8();
  return text;
}

/**
 * bytes UTF-8 -> string SEM o TextDecoder do Expo (polyfill em JS: ~1,6 ms por campo de 4,5 KB no
 * Hermes). Usa o conversor nativo do quick-crypto (`bufferToString`, JSI/C++), que é permissivo:
 * troca bytes inválidos por U+FFFD. Para manter a validação ESTRITA (`fatal`), recodifica a string
 * no nativo e exige bytes idênticos aos de entrada: o recodificador só emite UTF-8 bem formado
 * (surrogate solto vira U+FFFD), então bytes inválidos, sobrepostos (overlong), surrogates em UTF-8
 * e truncados nunca voltam iguais. Texto válido volta idêntico (inclusive U+FFFD legítimo e BOM:
 * ao contrário do TextDecoder, o BOM inicial NÃO é descartado). Lança Error se inválido.
 * Em pedaços de ~1 MB cortados em fronteira de caractere: a conferência não precisa de um
 * segundo buffer do tamanho do backup inteiro.
 */
export function decodeUtf8Strict(n: NativeCrypto, bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const buf = bytes.buffer as ArrayBuffer;
  const base = bytes.byteOffset;
  const total = bytes.length;
  if (total <= UTF8_DECODE_CHUNK) return decodeUtf8Piece(n, buf, base, base + total);
  const parts: string[] = [];
  let start = 0;
  while (start < total) {
    let end = Math.min(start + UTF8_DECODE_CHUNK, total);
    // Não corta no meio de uma sequência multibyte (continuação = 10xxxxxx; no máximo 3 bytes).
    for (let back = 0; end < total && back < 3 && (bytes[end] & 0xc0) === 0x80; back++) end--;
    parts.push(decodeUtf8Piece(n, buf, base + start, base + end));
    start = end;
  }
  return parts.join('');
}
