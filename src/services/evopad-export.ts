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

/**
 * Returns true if the URL is a local/loopback address (HTTP is acceptable there).
 */
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Validates a candidate EvoPad base URL.
 * Returns null if valid, or an error string to show the user.
 */
export function validateEvoPadUrl(rawUrl: string): string | null {
  const url = rawUrl.trim();
  if (!url) return 'A URL do EvoPad não pode estar vazia.';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'URL inválida. Exemplo: http://127.0.0.1:4173 ou https://meu-evopad.com';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Protocolo inválido. Use http:// ou https://.';
  }

  // Enforce HTTPS for non-local addresses (security requirement)
  if (parsed.protocol === 'http:' && !isLocalUrl(url)) {
    return (
      'URLs externas (não locais) devem usar HTTPS. ' +
      'HTTP sem criptografia expõe tokens e dados de saúde em trânsito.'
    );
  }

  return null; // valid
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
  return {
    baseUrl: baseUrl?.trim() || 'http://127.0.0.1:4173',
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
    const urlError = validateEvoPadUrl(config.baseUrl);
    if (urlError) throw new Error(urlError);
    await SecureStore.setItemAsync(KEYS.baseUrl, config.baseUrl.trim());
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

  // Also probe common local addresses if the configured one fails
  const fallbacks = [
    'http://127.0.0.1:4173',
    'http://localhost:4173',
  ].filter((u) => u !== config.baseUrl);

  candidates.push(...fallbacks);

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
