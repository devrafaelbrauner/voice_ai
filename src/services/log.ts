// Sanitized logger. In production, never log raw error objects — they can carry
// payloads with PII (patient names, transcripts, doctor data) that end up in
// crash reporters and remote log aggregators.
//
// Use logError(tag, err) everywhere instead of console.error('[tag]', err).

declare const __DEV__: boolean;
const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

function safeMessage(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return truncate(err);
  if (err instanceof Error) return truncate(err.message || err.name);
  if (typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    const msg = anyErr.message ?? anyErr.error ?? anyErr.code ?? anyErr.statusText;
    if (typeof msg === 'string') return truncate(msg);
    if (typeof anyErr.status === 'number') return `status ${anyErr.status}`;
  }
  return 'unknown error';
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

export function logError(tag: string, err: unknown): void {
  if (isDev) {
    // In dev, keep full object for debugging.
    console.error(`[${tag}]`, err);
    return;
  }
  // In prod, only emit the sanitized message.
  console.error(`[${tag}] ${safeMessage(err)}`);
}

export function logWarn(tag: string, err: unknown): void {
  if (isDev) {
    console.warn(`[${tag}]`, err);
    return;
  }
  console.warn(`[${tag}] ${safeMessage(err)}`);
}

/**
 * Diagnostic log — só emite em __DEV__. Nunca chega a produção.
 * Use no lugar de console.log para mensagens de status e migrações.
 */
export function logDebug(tag: string, ...args: unknown[]): void {
  if (!isDev) return;
  console.log(`[${tag}]`, ...args);
}
