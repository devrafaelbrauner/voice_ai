// Leitor incremental de um objeto JSON grande (o payload do backup, até 50 MB) SEM `JSON.parse` do
// documento inteiro: o texto chega em pedaços; os arrays "de registros" (chaves em `streamedKeys`)
// são entregues elemento a elemento e qualquer outra chave de primeiro nível é entregue como um
// valor. Memória ∝ maior elemento (um registro de poucos KB), não ao arquivo.
//
// Como funciona: um autômato mínimo só procura FRONTEIRAS (aspas com escape, colchetes/chaves,
// vírgulas, dois-pontos) e entrega cada fatia ao `JSON.parse` NATIVO — o parse e a validação do
// conteúdo continuam do motor. Texto dentro de strings é pulado com `indexOf` (nativo), então o
// custo em JS é proporcional ao número de tokens, não de caracteres. Estrito como o JSON.parse:
// vírgula sobrando, lixo depois do objeto, valor truncado e espaço que não seja JSON são recusados
// (fuzz contra o JSON.parse nos testes). Diferença deliberada: chave repetida de um array
// "streamed" é recusada (o JSON.parse ficaria com a última; aqui o primeiro já teria sido entregue).

export class JsonSliceError extends Error {
  constructor(message: string, readonly reason: 'syntax' | 'duplicate' | 'limit' = 'syntax') {
    super(message);
    this.name = 'JsonSliceError';
    Object.setPrototypeOf(this, JsonSliceError.prototype);
  }
}

/** O documento é JSON válido, mas não é um objeto. */
export class JsonNotObjectError extends Error {
  constructor() {
    super('O JSON não é um objeto.');
    this.name = 'JsonNotObjectError';
    Object.setPrototypeOf(this, JsonNotObjectError.prototype);
  }
}

export interface JsonItem {
  key: string;
  value: unknown;
  /** true: elemento de um array de `streamedKeys`; false: valor inteiro de uma chave de primeiro nível. */
  element: boolean;
}

const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const COLON = 58;
const LBRACKET = 91;
const RBRACKET = 93;
const LBRACE = 123;
const RBRACE = 125;

/** Quantos caracteres, no mínimo, cada recarga do buffer traz (e nunca menos que o pendente: custo amortizado linear). */
export const DEFAULT_MIN_READ_CHARS = 64 * 1024;

/** Teto de itens por array "streamed" (um backup legítimo tem milhares de gravações). */
export const MAX_ARRAY_ITEMS = 200_000;
/** Teto, em caracteres, de um valor de primeiro nível que não é elemento de array "streamed". */
export const MAX_FIELD_CHARS = 1024 * 1024;

export interface JsonLimits {
  maxElements: number;
  maxFieldChars: number;
}

const syntax = (what: string) => new JsonSliceError(`JSON inválido (${what}).`);
const limit = (what: string) => new JsonSliceError(`JSON acima do limite (${what}).`, 'limit');

/** Fim (exclusivo) da string que abre em `buf[i]`, ou -1 se ainda não fechou. */
function skipString(buf: string, i: number): number {
  let from = i + 1;
  for (;;) {
    const q = buf.indexOf('"', from);
    if (q < 0) return -1;
    let backslashes = 0;
    for (let k = q - 1; k > i && buf.charCodeAt(k) === BACKSLASH; k--) backslashes++;
    if ((backslashes & 1) === 0) return q + 1;
    from = q + 1;
  }
}

/**
 * Fim (exclusivo) do valor JSON que começa em `buf[start]`, ou -1 se o buffer acabou antes.
 * Só acha a fronteira: a validade da fatia é do JSON.parse. `atEof`: o buffer é o fim do texto
 * (um número solto no fim do documento está completo).
 */
function scanValue(buf: string, start: number, atEof: boolean): number {
  const len = buf.length;
  let depth = 0;
  let i = start;
  while (i < len) {
    const c = buf.charCodeAt(i);
    if (c === QUOTE) {
      const end = skipString(buf, i);
      if (end < 0) return -1;
      if (depth === 0) return end;
      i = end;
    } else if (c === LBRACE || c === LBRACKET) {
      depth++;
      i++;
    } else if (c === RBRACE || c === RBRACKET) {
      if (--depth < 0) throw syntax('fechamento inesperado');
      i++;
      if (depth === 0) return i;
    } else if (depth === 0) {
      // número, true, false, null: vai até um delimitador
      if (c === COMMA || c === COLON) throw syntax('valor ausente');
      let j = i;
      while (j < len) {
        const d = buf.charCodeAt(j);
        if (d === COMMA || d === RBRACKET || d === RBRACE || d === 32 || d === 10 || d === 13 || d === 9) return j;
        j++;
      }
      return atEof ? j : -1;
    } else {
      i++;
    }
  }
  return -1;
}

function parseSlice(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw syntax('valor malformado');
  }
}

class Cursor {
  buf = '';
  pos = 0;
  private done = false;

  constructor(
    private readonly pull: () => string | null,
    private readonly minRead: number
  ) {}

  /** Descarta o consumido e anexa mais texto (≥ max(minRead, pendente) caracteres). false: acabou. */
  private more(): boolean {
    if (this.done) return false;
    const pending = this.buf.length - this.pos;
    const want = Math.max(1, this.minRead, pending);
    const parts: string[] = [this.pos < this.buf.length ? this.buf.slice(this.pos) : ''];
    let got = 0;
    while (got < want) {
      const piece = this.pull();
      if (piece === null) {
        this.done = true;
        break;
      }
      parts.push(piece);
      got += piece.length;
    }
    this.buf = parts.join('');
    this.pos = 0;
    return got > 0;
  }

  /** Pula o espaço JSON (só ␠ \t \n \r) e devolve o código do caractere atual, ou -1 no fim do texto. */
  peek(): number {
    for (;;) {
      const buf = this.buf;
      while (this.pos < buf.length) {
        const c = buf.charCodeAt(this.pos);
        if (c === 32 || c === 10 || c === 13 || c === 9) this.pos++;
        else return c;
      }
      if (!this.more()) return -1;
    }
  }

  /** Texto do valor JSON que começa na posição atual (sem espaços à frente); avança para depois dele. */
  takeValue(): string {
    for (;;) {
      const end = scanValue(this.buf, this.pos, this.done);
      if (end >= 0) {
        const text = this.buf.slice(this.pos, end);
        this.pos = end;
        return text;
      }
      if (this.done) throw syntax('texto truncado');
      this.more();
    }
  }
}

/**
 * Lê o objeto JSON de `pull` (pedaços de texto; null = fim) e chama `onItem` na ordem do
 * documento. Em chave de `streamedKeys` cujo valor é array, cada elemento vira um `onItem`
 * (`element: true`); qualquer outro valor de primeiro nível vira um `onItem` com `element: false`
 * (chave repetida: um item por ocorrência, o consumidor fica com o último). Aguarda o retorno de
 * `onItem` quando for uma Promise (contrapressão: o consumidor grava o lote antes do próximo).
 * Lança JsonSliceError (JSON malformado/truncado, ou acima dos tetos de `limits`) ou JsonNotObjectError
 * (JSON válido que não é objeto). Tetos: itens por array "streamed" e tamanho de valor de primeiro nível
 * que não é array "streamed" (doctor, version…): ficam acima de qualquer backup legítimo e impedem que
 * um arquivo hostil (milhões de `1,`; um campo de dezenas de MB) prenda a thread JS e a transação.
 */
export async function readJsonObject(
  pull: () => string | null,
  streamedKeys: ReadonlySet<string>,
  onItem: (item: JsonItem) => void | Promise<void>,
  minReadChars: number = DEFAULT_MIN_READ_CHARS,
  limitOverrides: Partial<JsonLimits> = {}
): Promise<void> {
  const limits: JsonLimits = { maxElements: MAX_ARRAY_ITEMS, maxFieldChars: MAX_FIELD_CHARS, ...limitOverrides };
  const cur = new Cursor(pull, minReadChars);
  const emit = async (item: JsonItem) => {
    const r = onItem(item);
    if (r) await r;
  };

  let c = cur.peek();
  if (c === -1) throw syntax('vazio');
  if (c !== LBRACE) {
    const text = cur.takeValue();
    if (text.length > limits.maxFieldChars) throw limit('valor grande demais');
    parseSlice(text);
    if (cur.peek() !== -1) throw syntax('texto depois do valor');
    throw new JsonNotObjectError();
  }
  cur.pos++;

  const seenStreamed = new Set<string>();
  c = cur.peek();
  if (c === RBRACE) {
    cur.pos++;
  } else {
    for (;;) {
      if (c !== QUOTE) throw syntax('chave esperada');
      const key = parseSlice(cur.takeValue()) as string;
      if (cur.peek() !== COLON) throw syntax('dois-pontos esperado');
      cur.pos++;
      c = cur.peek();
      if (c === -1) throw syntax('texto truncado');

      if (streamedKeys.has(key)) {
        if (seenStreamed.has(key)) throw new JsonSliceError(`JSON com a chave "${key}" repetida.`, 'duplicate');
        seenStreamed.add(key);
      }
      if (c === LBRACKET && streamedKeys.has(key)) {
        cur.pos++;
        c = cur.peek();
        if (c === RBRACKET) {
          cur.pos++;
        } else {
          for (let count = 0; ; ) {
            if (++count > limits.maxElements) throw limit(`mais de ${limits.maxElements} itens em "${key}"`);
            await emit({ key, value: parseSlice(cur.takeValue()), element: true });
            c = cur.peek();
            if (c === COMMA) {
              cur.pos++;
              cur.peek(); // takeValue recusa `,]` (fechamento no lugar do valor)
              continue;
            }
            if (c === RBRACKET) {
              cur.pos++;
              break;
            }
            throw syntax('vírgula ou colchete esperado');
          }
        }
      } else {
        const text = cur.takeValue();
        if (text.length > limits.maxFieldChars) throw limit('valor de primeiro nível grande demais');
        await emit({ key, value: parseSlice(text), element: false });
      }

      c = cur.peek();
      if (c === COMMA) {
        cur.pos++;
        c = cur.peek();
        continue;
      }
      if (c === RBRACE) {
        cur.pos++;
        break;
      }
      throw syntax('vírgula ou chave esperada');
    }
  }
  if (cur.peek() !== -1) throw syntax('texto depois do objeto');
}
