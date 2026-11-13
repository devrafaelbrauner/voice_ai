/**
 * EvoPad Integration Service
 *
 * Envia evoluções geradas pelo VoiceAI Recorder para o EvoPad011
 * via POST /api/import/recording com autenticação por API token.
 *
 * Configuração: URL base e token ficam em SecureStore.
 * Padrão local: http://127.0.0.1:4173 (porta padrão do EvoPad).
 */

import * as SecureStore from 'expo-secure-store';
import { logError, logWarn } from './log';
import { secureFetch } from './secure-fetch';

// ─── URL / Token validation ───────────────────────────────────────────────────

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

/**
 * Returns true if the URL host is loopback or a private-range IP literal
 * (HTTP is acceptable there). Strict: only `localhost`, `::1`, and exact
 * dotted-quad IPv4 literals in 127/8, 10/8, 172.16/12, 192.168/16.
 * Hostnames such as `10.evil.com` or `192.168.1.10.evil.com` are NOT local.
 */
export function isLocalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
      return true;
    }
    if (!IPV4_RE.test(hostname)) return false;
    const [a, b] = hostname.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31)
    );
  } catch {
    return false;
  }
}

/**
 * Parses a candidate EvoPad base URL into its normalized origin
 * (`scheme://host[:port]`). Rejects userinfo, backslashes, path, query,
 * fragment and whitespace so the stored/used value is exactly `new URL(x).origin`.
 */
function parseEvoPadBaseUrl(rawUrl: string): { origin: string } | { error: string } {
  const url = rawUrl.trim();
  if (!url) return { error: 'A URL do EvoPad não pode estar vazia.' };

  if (/[\\\s?#@]/.test(url)) {
    return {
      error:
        'URL inválida: não use barras invertidas, espaços, "@", "?" ou "#". ' +
        'Informe apenas o endereço, ex.: http://127.0.0.1:4173 ou https://meu-evopad.com',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'URL inválida. Exemplo: http://127.0.0.1:4173 ou https://meu-evopad.com' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Protocolo inválido. Use http:// ou https://.' };
  }

  if (parsed.username || parsed.password) {
    return { error: 'A URL do EvoPad não pode conter usuário ou senha.' };
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return {
      error: 'A URL do EvoPad deve conter apenas o endereço (sem caminho). Ex.: https://meu-evopad.com',
    };
  }

  const origin = `${parsed.protocol}//${parsed.host}`;

  // Enforce HTTPS for non-local addresses (security requirement)
  if (parsed.protocol === 'http:' && !isLocalUrl(origin)) {
    return {
      error:
        'URLs externas (não locais) devem usar HTTPS. ' +
        'HTTP sem criptografia expõe tokens e dados de saúde em trânsito.',
    };
  }

  return { origin };
}

/**
 * Validates a candidate EvoPad base URL.
 * Returns null if valid, or an error string to show the user.
 */
export function validateEvoPadUrl(rawUrl: string): string | null {
  const parsed = parseEvoPadBaseUrl(rawUrl);
  return 'error' in parsed ? parsed.error : null;
}

/**
 * Validates an EvoPad import token.
 * Returns null if valid, or an error string.
 */
export function validateEvoPadToken(token: string): string | null {
  const t = token.trim();
  if (!t) return null; // token is optional — validated at import time instead
  if (t.length < 8) {
    return 'Token muito curto. Um IMPORT_TOKEN válido tem pelo menos 8 caracteres.';
  }
  // Reject obviously wrong values
  if (t === 'undefined' || t === 'null' || t === 'changeme') {
    return 'Token inválido. Cole o valor real de IMPORT_TOKEN do .env do EvoPad.';
  }
  return null;
}

// ─── SecureStore keys ────────────────────────────────────────────────────────

const KEYS = {
  baseUrl: 'evopad_base_url',
  importToken: 'evopad_import_token',
};

// ─── Config helpers ──────────────────────────────────────────────────────────

export interface EvoPadConfig {
  baseUrl: string;
  importToken: string;
}

export async function getEvoPadConfig(): Promise<EvoPadConfig> {
  const [baseUrl, importToken] = await Promise.all([
    SecureStore.getItemAsync(KEYS.baseUrl),
    SecureStore.getItemAsync(KEYS.importToken),
  ]);
  const rawBase = baseUrl?.trim() || 'http://127.0.0.1:4173';
  const parsedBase = parseEvoPadBaseUrl(rawBase);
  return {
    // Legacy values saved before origin-only validation are normalized when valid;
    // invalid ones are returned as-is so exportToEvoPad rejects them with a message.
    baseUrl: 'origin' in parsedBase ? parsedBase.origin : rawBase,
    importToken: importToken?.trim() || '',
  };
}

/**
 * Persists EvoPad configuration after validation.
 * Throws if the URL fails the HTTPS-for-remote rule.
 * Token warnings are logged but do NOT throw (token is optional at save time).
 */
export async function setEvoPadConfig(config: Partial<EvoPadConfig>): Promise<void> {
  if (config.baseUrl !== undefined) {
    const parsed = parseEvoPadBaseUrl(config.baseUrl);
    if ('error' in parsed) throw new Error(parsed.error);
    // Persist only the normalized origin — requests never concatenate raw user input.
    await SecureStore.setItemAsync(KEYS.baseUrl, parsed.origin);
  }
  if (config.importToken !== undefined) {
    const tokenWarning = validateEvoPadToken(config.importToken);
    if (tokenWarning) logWarn('evopad', tokenWarning);
    await SecureStore.setItemAsync(KEYS.importToken, config.importToken.trim());
  }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Testa se o EvoPad está respondendo na URL configurada.
 * Retorna a URL se disponível, null caso contrário.
 */
export async function discoverEvoPadServer(): Promise<string | null> {
  const config = await getEvoPadConfig();

  // Always test the configured URL first
  const candidates = [config.baseUrl];

  // Probe common local addresses ONLY when the configured URL is itself local.
  // If a remote HTTPS URL is configured, never fall back to localhost and never
  // send requests (or, later, PHI) to a host other than the configured one.
  if (isLocalUrl(config.baseUrl)) {
    const fallbacks = [
      'http://127.0.0.1:4173',
      'http://localhost:4173',
    ].filter((u) => u !== config.baseUrl);
    candidates.push(...fallbacks);
  }

  for (const url of candidates) {
    try {
      const response = await secureFetch(`${url}/api/bootstrap-status`, {
        method: 'GET',
        timeoutMs: 2500,
        expectContentType: null, // bootstrap may return text/html
        skipDomainCheck: true,   // EvoPad is on localhost/LAN — not in global whitelist
      });
      if (response.ok) return url;
    } catch {
      // try next candidate
    }
  }

  return null;
}

export async function isEvoPadAvailable(): Promise<boolean> {
  try {
    return (await discoverEvoPadServer()) !== null;
  } catch {
    return false;
  }
}

// ─── Payload type ────────────────────────────────────────────────────────────

export interface EvoPadImportPayload {
  /** Nome do paciente (obrigatório — será criado no EvoPad se não existir) */
  patientName: string;
  /** Conteúdo da evolução em texto plano (obrigatório) */
  content: string;
  /** Conteúdo em Markdown, se disponível */
  markdown?: string;
  /** CID-10 */
  cid10?: string;
  /** Data de internação (ISO string) */
  admissionDate?: string;
  /** Data de nascimento do paciente */
  patientBirthDate?: string;
  /** Plano de saúde */
  healthPlan?: string;
  /** Nome do médico */
  doctorName?: string;
  /** CRM do médico */
  doctorCrm?: string;
  /** Template usado para gerar a evolução */
  templateUsed?: string;
}

export interface EvoPadImportResult {
  success: boolean;
  patientId?: string;
  evolutionId?: string;
  patientCreated?: boolean;
  evoPadUrl?: string;
  error?: string;
}

// ─── Main export function ────────────────────────────────────────────────────

/**
 * Envia uma evolução para o EvoPad via API de importação.
 *
 * Requer:
 * - EvoPad rodando localmente (padrão: http://127.0.0.1:4173)
 * - IMPORT_TOKEN configurado no .env do EvoPad e no app (via setEvoPadConfig)
 */
export async function exportToEvoPad(
  payload: EvoPadImportPayload
): Promise<EvoPadImportResult> {
  try {
    const config = await getEvoPadConfig();

    if (!config.importToken) {
      return {
        success: false,
        error:
          'Token de importação não configurado. Acesse Configurações > EvoPad e insira o token.',
      };
    }

    // Runtime HTTPS enforcement for non-local URLs
    const urlValidationError = validateEvoPadUrl(config.baseUrl);
    if (urlValidationError) {
      return { success: false, error: urlValidationError };
    }

    const tokenValidationError = validateEvoPadToken(config.importToken);
    if (tokenValidationError) {
      return { success: false, error: tokenValidationError };
    }

    const evoPadUrl = await discoverEvoPadServer();
    if (!evoPadUrl) {
      return {
        success: false,
        error:
          'EvoPad não encontrado. Verifique se ele está rodando e se a URL está correta nas configurações.',
      };
    }

    const response = await secureFetch(`${evoPadUrl}/api/import/recording`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.importToken}`,
      },
      body: JSON.stringify(payload),
      timeoutMs: 15_000,
      expectContentType: 'application/json',
      skipDomainCheck: true, // EvoPad is on localhost/LAN
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        success: false,
        evoPadUrl,
        error:
          (data as any)?.error ||
          `Erro HTTP ${response.status} ao importar para o EvoPad.`,
      };
    }

    return {
      success: true,
      evoPadUrl,
      patientId: (data as any).patientId,
      evolutionId: (data as any).evolutionId,
      patientCreated: (data as any).patientCreated,
    };
  } catch (err) {
    logError('exportToEvoPad', err);
    return {
      success: false,
      error: `Erro ao conectar ao EvoPad: ${String(err)}`,
    };
  }
}
