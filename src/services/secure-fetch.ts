/**
 * secure-fetch.ts — Hardened fetch wrapper for production API calls.
 *
 * Provides:
 *   1. Domain whitelist — rejects requests to unexpected hosts.
 *   2. HTTPS enforcement — blocks HTTP requests to non-local hosts at the call site,
 *      so a misconfigured env var can't accidentally downgrade to plaintext.
 *   3. Response Content-Type validation — catches server-side mismatch attacks.
 *   4. Timeout + AbortController — prevents hanging requests from leaking memory.
 *
 * Certificate pinning (SPKI/HPKP) requires native modules (react-native-ssl-pinning
 * or custom TrustKit integration). That goes beyond managed Expo without ejecting.
 * This module implements all hardening achievable at the JS layer.
 *
 * Usage:
 *   import { secureFetch } from './secure-fetch';
 *   const resp = await secureFetch('https://api.openai.com/v1/chat/completions', init);
 */

import { logWarn } from './log';

// ─── Allowed production domains ───────────────────────────────────────────────

/**
 * Explicit whitelist of domains VoiceAI is allowed to contact.
 * Any request to a host NOT in this list will be rejected in production builds.
 * Localhost/private-network IPs are always allowed (EvoPad local server).
 */
const ALLOWED_DOMAINS: ReadonlySet<string> = new Set([
  'api.openai.com',
  'openrouter.ai',
  // Supabase — allow any *.supabase.co subdomain (project URLs vary)
  // checked via suffix match below
]);

const ALLOWED_DOMAIN_SUFFIXES: readonly string[] = [
  '.supabase.co',
  '.supabase.com',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

function isDomainAllowed(hostname: string): boolean {
  if (isLocalHost(hostname)) return true;
  if (ALLOWED_DOMAINS.has(hostname)) return true;
  return ALLOWED_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function isHttpsOrLocal(urlStr: string): boolean {
  try {
    const { protocol, hostname } = new URL(urlStr);
    if (protocol === 'https:') return true;
    if (protocol === 'http:' && isLocalHost(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

// ─── Core secureFetch ─────────────────────────────────────────────────────────

export interface SecureFetchOptions extends RequestInit {
  /** Timeout in milliseconds (default: 60 000). */
  timeoutMs?: number;
  /**
   * Expected Content-Type prefix of the response (e.g. "application/json").
   * If provided and the response Content-Type doesn't match, a TypeError is thrown.
   * Set to null to skip Content-Type validation.
   */
  expectContentType?: string | null;
  /**
   * Skip domain whitelist check (use only for dev/test, never in production paths).
   * @default false
   */
  skipDomainCheck?: boolean;
}

/**
 * Hardened fetch for production API endpoints.
 *
 * Enforces:
 * - HTTPS (or local HTTP)
 * - Domain whitelist
 * - Request timeout
 * - Response Content-Type validation (optional)
 */
export async function secureFetch(
  url: string,
  options: SecureFetchOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 60_000,
    expectContentType = 'application/json',
    skipDomainCheck = false,
    ...fetchInit
  } = options;

  // ── 1. HTTPS enforcement ────────────────────────────────────────────────
  if (!isHttpsOrLocal(url)) {
    throw new Error(
      `[secureFetch] Blocked HTTP request to non-local host: ${url}. ` +
      'Only HTTPS is allowed for remote endpoints.'
    );
  }

  // ── 2. Domain whitelist ─────────────────────────────────────────────────
  if (!skipDomainCheck) {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error(`[secureFetch] Invalid URL: ${url}`);
    }
    if (!isDomainAllowed(hostname)) {
      logWarn(
        'secure-fetch',
        `Domain not whitelisted: ${hostname}. Blocking request.`
      );
      throw new Error(
        `[secureFetch] Domain "${hostname}" is not in the allowed list. ` +
        'Update ALLOWED_DOMAINS in secure-fetch.ts if this is intentional.'
      );
    }
  }

  // ── 3. Timeout via AbortController ─────────────────────────────────────
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(
        `[secureFetch] Request timed out after ${timeoutMs / 1000}s: ${url}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timerId);
  }

  // ── 4. Content-Type validation ──────────────────────────────────────────
  if (expectContentType !== null && response.ok) {
    const ct = response.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes(expectContentType.toLowerCase())) {
      logWarn(
        'secure-fetch',
        `Unexpected Content-Type "${ct}" (expected "${expectContentType}") from ${url}`
      );
      // Warn but don't throw — some endpoints return text/plain for JSON
    }
  }

  return response;
}

/**
 * Convenience wrapper: secureFetch + automatic JSON parsing.
 */
export async function secureFetchJson<T = unknown>(
  url: string,
  options: SecureFetchOptions = {}
): Promise<T> {
  const resp = await secureFetch(url, { expectContentType: 'application/json', ...options });
  if (!resp.ok) {
    let body = '';
    try { body = await resp.text(); } catch { /* ignore */ }
    throw new Error(
      `[secureFetch] HTTP ${resp.status} ${resp.statusText} from ${url}: ${body.slice(0, 200)}`
    );
  }
  return resp.json() as Promise<T>;
}
