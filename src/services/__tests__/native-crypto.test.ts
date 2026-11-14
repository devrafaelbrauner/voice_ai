// Partes em fluxo do native-crypto: AES-GCM por blocos (mesmo resultado do one-shot e do node:crypto)
// e decodificador UTF-8 estrito que atravessa bordas de bloco. O quick-crypto é node:crypto (jest.setup).
import nodeCrypto from 'node:crypto';
import {
  Utf8StreamDecoder,
  decodeUtf8Strict,
  gcmDecryptStream,
  gcmEncrypt,
  gcmEncryptStream,
  loadNativeCrypto,
} from '../native-crypto';

const key = new Uint8Array(32).map((_, i) => i + 1);
const nonce = new Uint8Array(12).map((_, i) => 200 - i);
const aad = new TextEncoder().encode('cabeçalho autenticado');

function sealInChunks(plain: Uint8Array, sizes: number[]): Buffer {
  const n = loadNativeCrypto();
  const enc = gcmEncryptStream(n, key, nonce, aad);
  const parts: Uint8Array[] = [];
  for (let off = 0, i = 0; off < plain.length; i++) {
    const take = Math.min(sizes[i % sizes.length], plain.length - off);
    parts.push(Uint8Array.from(enc.update(Uint8Array.from(plain.subarray(off, off + take)))));
    off += take;
  }
  parts.push(enc.finish());
  return Buffer.concat(parts);
}

describe('AES-GCM em fluxo', () => {
  const plain = nodeCrypto.randomBytes(100_003);

  test('cifra em blocos de qualquer tamanho = one-shot = node:crypto (ciphertext || tag)', () => {
    const n = loadNativeCrypto();
    const oneShot = gcmEncrypt(n, key, nonce, plain, aad);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(Buffer.from(aad));
    const reference = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    expect(Buffer.from(oneShot).equals(reference)).toBe(true);
    for (const sizes of [[1], [7, 13], [4096], [196_608], [plain.length], [plain.length + 5]]) {
      expect(sealInChunks(plain, sizes).equals(reference)).toBe(true);
    }
  });

  test('decifra em blocos devolve o plaintext e confere a tag só no finish()', () => {
    const n = loadNativeCrypto();
    const sealed = sealInChunks(plain, [5000]);
    const body = sealed.subarray(0, sealed.length - 16);
    const tag = sealed.subarray(sealed.length - 16);
    const dec = gcmDecryptStream(n, key, nonce, aad, Uint8Array.from(tag));
    const out: Buffer[] = [];
    for (let off = 0; off < body.length; off += 777) out.push(Buffer.from(dec.update(Uint8Array.from(body.subarray(off, off + 777)))));
    dec.finish();
    expect(Buffer.concat(out).equals(plain)).toBe(true);
  });

  test.each([
    ['byte do ciphertext alterado', (b: Buffer) => { b[1000] ^= 1; }],
    ['tag alterada', (b: Buffer) => { b[b.length - 1] ^= 1; }],
  ])('%s: finish() lança (o plaintext de update() ainda não é autêntico)', (_name, tamper) => {
    const n = loadNativeCrypto();
    const sealed = Buffer.from(sealInChunks(plain, [5000]));
    tamper(sealed);
    const dec = gcmDecryptStream(n, key, nonce, aad, Uint8Array.from(sealed.subarray(sealed.length - 16)));
    dec.update(Uint8Array.from(sealed.subarray(0, sealed.length - 16)));
    expect(() => dec.finish()).toThrow();
  });

  test('AAD diferente ou chave errada: finish() lança', () => {
    const n = loadNativeCrypto();
    const sealed = sealInChunks(plain.subarray(0, 1000), [300]);
    const body = Uint8Array.from(sealed.subarray(0, sealed.length - 16));
    const tag = Uint8Array.from(sealed.subarray(sealed.length - 16));
    const wrongAad = gcmDecryptStream(n, key, nonce, new TextEncoder().encode('outro'), tag);
    wrongAad.update(body);
    expect(() => wrongAad.finish()).toThrow();
    const wrongKey = gcmDecryptStream(n, new Uint8Array(32), nonce, aad, tag);
    wrongKey.update(body);
    expect(() => wrongKey.finish()).toThrow();
  });
});

describe('Utf8StreamDecoder', () => {
  const n = () => loadNativeCrypto();
  const SAMPLE = 'aé€😀b中文👨‍⚕️\ufeffz\ufffdÿ\u0000x😀';
  const bytes = new TextEncoder().encode(SAMPLE);

  function decodeInPieces(data: Uint8Array, cuts: number[]): string {
    const dec = new Utf8StreamDecoder(n());
    let out = '';
    let prev = 0;
    for (const cut of [...cuts, data.length]) {
      out += dec.push(Uint8Array.from(data.subarray(prev, cut)));
      prev = cut;
    }
    dec.end();
    return out;
  }

  test('qualquer corte em dois pedaços (inclusive no meio de caractere de 2, 3 e 4 bytes) devolve o texto inteiro', () => {
    for (let cut = 0; cut <= bytes.length; cut++) expect(decodeInPieces(bytes, [cut])).toBe(SAMPLE);
  });

  test('todos os cortes em três pedaços e pedaços de 1 byte', () => {
    for (let a = 0; a <= bytes.length; a++) {
      for (let b = a; b <= bytes.length; b++) expect(decodeInPieces(bytes, [a, b])).toBe(SAMPLE);
    }
    expect(decodeInPieces(bytes, Array.from({ length: bytes.length - 1 }, (_, i) => i + 1))).toBe(SAMPLE);
  });

  test('não decodifica sequência cortada: o pedaço devolve só os caracteres completos', () => {
    const dec = new Utf8StreamDecoder(n());
    const euro = new TextEncoder().encode('a€'); // 61 E2 82 AC
    expect(dec.push(Uint8Array.from(euro.subarray(0, 3)))).toBe('a'); // E2 82 pendentes
    expect(dec.push(Uint8Array.from(euro.subarray(3)))).toBe('€');
    dec.end();
  });

  test('texto grande em pedaços aleatórios é igual ao decode de uma vez', () => {
    let text = '';
    for (let i = 0; i < 20_000; i++) text += ['a', 'é', '€', '😀', '中'][i % 5];
    const data = new TextEncoder().encode(text);
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const cuts: number[] = [];
    for (let at = 0; at < data.length; at += 1 + Math.floor(rnd() * 5000)) cuts.push(at);
    expect(decodeInPieces(data, cuts)).toBe(decodeUtf8Strict(n(), data));
    expect(decodeInPieces(data, cuts)).toBe(text);
  });

  test.each([
    ['byte de continuação solto', [0x61, 0x80, 0x62]],
    ['overlong C0 AF', [0x61, 0xc0, 0xaf, 0x62]],
    ['surrogate ED A0 80', [0xed, 0xa0, 0x80]],
    ['0xFF', [0x61, 0xff]],
    ['E0 80 80 (overlong)', [0xe0, 0x80, 0x80]],
    ['F4 90 80 80 (> U+10FFFF)', [0xf4, 0x90, 0x80, 0x80]],
    ['truncado no fim (E2 82)', [0x61, 0xe2, 0x82]],
    ['líder sem continuação seguido de ASCII', [0xe2, 0x82, 0x61]],
  ])('UTF-8 inválido é recusado em qualquer corte: %s', (_name, raw) => {
    const data = Uint8Array.from(raw);
    for (let cut = 0; cut <= data.length; cut++) {
      expect(() => decodeInPieces(data, [cut])).toThrow('UTF-8 inválido');
    }
  });
});
