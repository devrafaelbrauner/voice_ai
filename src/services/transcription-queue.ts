// Offline transcription queue.
//
// Why: a doctor may record audio without internet (rural hospital, basement,
// during travel). We must NEVER lose the recording — instead, queue the
// transcription request and process it when the failure is recoverable.
//
// Strategy:
//   1. Recording flow tries transcription immediately. On a transient failure
//      (TranscriptionError.transient), enqueueTranscription() persists the
//      audio reference.
//   2. processQueue() drains pending items one at a time. It is NOT reentrant
//      (a second call while one runs is a no-op) and honours a per-item
//      cooldown (`nextAttemptAt`), so calling it often is cheap and safe.
//   3. Failures are classified by TranscriptionError.kind/transient — never by
//      message text:
//        - network / rate_limit: stop the whole drain (every item would fail
//          the same way). Not counted towards MAX_ATTEMPTS.
//        - invalid_key / forbidden / quota: configuration errors (key, permission,
//          provider credit). Stop the drain, do NOT spend the item's attempts and
//          pause automatic drains (CONFIG_BLOCK_MS).
//        - other transient (server/timeout): cooldown, next item. Not counted.
//        - permanent (bad_response, file, unknown): counted; after MAX_ATTEMPTS
//          the item is marked permanentlyFailed. The audio file is never deleted
//          here.
//
// Items are identified by `fileName` only (never by array index or uri).
//
// Persistence: AsyncStorage holds the queue as JSON. Audio files themselves
// stay in FileSystem.documentDirectory — only their paths are queued.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { logWarn, logDebug } from './log';
import { isTranscriptionError, TranscriptionError, type TranscriptionErrorKind } from './openai';

const QUEUE_KEY = '@voice_ai_recorder/transcription_queue/v1';

/** After this many counted (permanent) failures the item is marked failed. */
const MAX_ATTEMPTS = 5;

const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 15 * 60_000;
/** Network errors stop the drain anyway; keep the retry window short for when the link returns. */
const NETWORK_COOLDOWN_MS = 10_000;

export interface QueuedTranscription {
  /** Local file name (e.g. recording_1700000000.m4a). Stable ID. */
  fileName: string;
  /** Absolute file URI for the audio file. */
  uri: string;
  /** ISO timestamp when the recording was made. */
  createdAt: string;
  /** When this item was added to the queue. */
  enqueuedAt: string;
  /** How many times we tried to process this item (all failures). */
  attempts: number;
  /** Failures that count towards MAX_ATTEMPTS (permanent kinds only). */
  countedFailures?: number;
  /** Last error message, for UI display. Never contains credentials. */
  lastError?: string;
  /** Kind of the last failure, when it was a TranscriptionError. */
  lastErrorKind?: TranscriptionErrorKind;
  /** Epoch ms before which the item must not be retried automatically. */
  nextAttemptAt?: number;
  /** Optional: template id to auto-summarize after transcription succeeds. */
  templateId?: string;
  /**
   * True when the item has exceeded MAX_ATTEMPTS or the audio file is gone.
   * Permanently failed items are never retried automatically — the user must
   * explicitly clear them.
   */
  permanentlyFailed?: boolean;
}

/** Why a drain stopped before going through every due item. */
export type DrainStopReason = 'network' | 'rate_limit' | 'invalid_key' | 'forbidden' | 'quota';

export interface QueueSummary {
  processed: number;
  failed: number;
  permanentlyFailed: number;
  remaining: number;
  /** Items skipped because their cooldown has not elapsed. */
  deferred: number;
  /** True when another drain was already running (this call did nothing). */
  alreadyRunning: boolean;
  /** Set when the drain stopped on a network/rate-limit/config error (or is paused by one). */
  stoppedBy?: DrainStopReason;
}

/**
 * Should a failed transcription be queued for a later automatic retry?
 * Transient TranscriptionErrors only; permanent ones need user action first.
 */
export function isRetryableTranscriptionError(err: unknown): boolean {
  return isTranscriptionError(err) && err.transient;
}

// ── Storage ──────────────────────────────────────────────────────────────────

async function readQueue(): Promise<QueuedTranscription[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logWarn('queue', err);
    return [];
  }
}

async function writeQueue(items: QueuedTranscription[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

// Serialises read-modify-write cycles (store enqueue vs. drain vs. UI clear).
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

/** Applies `update` to the entry with this fileName (no-op if it is gone). */
function updateItem(
  fileName: string,
  update: (item: QueuedTranscription) => QueuedTranscription
): Promise<QueuedTranscription | undefined> {
  return withLock(async () => {
    const queue = await readQueue();
    const idx = queue.findIndex((q) => q.fileName === fileName);
    if (idx < 0) return undefined;
    queue[idx] = update(queue[idx]);
    await writeQueue(queue);
    return queue[idx];
  });
}

// ── Failure bookkeeping ──────────────────────────────────────────────────────

function cooldownFor(attempts: number, kind: TranscriptionErrorKind | undefined, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, COOLDOWN_MAX_MS);
  if (kind === 'network') return NETWORK_COOLDOWN_MS;
  const exp = Math.min(COOLDOWN_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 16)), COOLDOWN_MAX_MS);
  return Math.floor(exp / 2 + (exp * Math.random()) / 2);
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** invalid_key/forbidden/quota: erro de configuração (chave/permissão/crédito), não do item. */
function isConfigError(err: unknown): boolean {
  return (
    isTranscriptionError(err) &&
    (err.kind === 'invalid_key' || err.kind === 'forbidden' || err.kind === 'quota')
  );
}

function applyFailure(item: QueuedTranscription, err: unknown, now: number): QueuedTranscription {
  const typed = isTranscriptionError(err) ? err : undefined;
  if (isConfigError(err)) {
    // Não gasta tentativa nem define cooldown do item: ao corrigir a chave, a
    // próxima drenagem o processa. Só registra o motivo.
    return { ...item, lastError: errorMessage(err), lastErrorKind: typed?.kind };
  }
  // Unknown errors (not TranscriptionError) are treated as permanent.
  const counted = !typed?.transient;
  const attempts = item.attempts + 1;
  const countedFailures = (item.countedFailures ?? 0) + (counted ? 1 : 0);
  const permanent = counted && countedFailures >= MAX_ATTEMPTS;
  return {
    ...item,
    attempts,
    countedFailures,
    lastError: errorMessage(err),
    lastErrorKind: typed?.kind,
    nextAttemptAt: permanent ? undefined : now + cooldownFor(attempts, typed?.kind, typed?.retryAfterMs),
    ...(permanent ? { permanentlyFailed: true } : {}),
  };
}

/**
 * Add a recording to the queue. Idempotent by fileName — if already queued,
 * records the new failure (attempts/cooldown) instead of duplicating.
 */
export async function enqueueTranscription(item: {
  fileName: string;
  uri: string;
  createdAt: string;
  templateId?: string;
  /** The failure that caused the enqueue; drives cooldown and attempt accounting. */
  error?: unknown;
}): Promise<void> {
  await withLock(async () => {
    const queue = await readQueue();
    const idx = queue.findIndex((q) => q.fileName === item.fileName);
    const base: QueuedTranscription =
      idx >= 0
        ? queue[idx]
        : {
            fileName: item.fileName,
            uri: item.uri,
            createdAt: item.createdAt,
            templateId: item.templateId,
            enqueuedAt: new Date().toISOString(),
            attempts: 0,
          };
    const next = item.error === undefined ? base : applyFailure(base, item.error, Date.now());
    if (idx >= 0) queue[idx] = next;
    else queue.push(next);
    await writeQueue(queue);
  });
}

/**
 * Remove an item from the queue (call after successful processing).
 */
export async function dequeueTranscription(fileName: string): Promise<void> {
  await withLock(async () => {
    const queue = await readQueue();
    await writeQueue(queue.filter((q) => q.fileName !== fileName));
  });
}

/**
 * Read current queue (for UI display).
 */
export async function getQueue(): Promise<QueuedTranscription[]> {
  return readQueue();
}

/**
 * Returns the count of pending (retryable) items.
 */
export async function getQueueCount(): Promise<number> {
  const q = await readQueue();
  return q.filter((i) => !i.permanentlyFailed).length;
}

/**
 * Returns the count of permanently failed items (exceeded max attempts or
 * audio file is missing).
 */
export async function getFailedCount(): Promise<number> {
  const q = await readQueue();
  return q.filter((i) => i.permanentlyFailed).length;
}

/**
 * Returns all permanently failed items for display in the UI.
 */
export async function getFailedItems(): Promise<QueuedTranscription[]> {
  const q = await readQueue();
  return q.filter((i) => i.permanentlyFailed);
}

/**
 * Remove all permanently failed items from the queue.
 */
export async function clearFailedItems(): Promise<void> {
  await withLock(async () => {
    const q = await readQueue();
    await writeQueue(q.filter((i) => !i.permanentlyFailed));
  });
}

// ── Drain ────────────────────────────────────────────────────────────────────

let draining = false;
/** Após um erro de configuração, drenagens automáticas ficam suspensas até aqui. */
let configBlockedUntil = 0;
/** Tipo do erro de configuração que originou a pausa (para devolver `stoppedBy`). */
let configBlockedKind: DrainStopReason = 'invalid_key';
const CONFIG_BLOCK_MS = 60_000;

async function summaryNow(partial: Omit<QueueSummary, 'remaining'>): Promise<QueueSummary> {
  const queue = await readQueue();
  return { ...partial, remaining: queue.filter((i) => !i.permanentlyFailed).length };
}

/**
 * Process the queue: tries to transcribe each due item sequentially.
 *
 * - Not reentrant: if a drain is already running, returns immediately with
 *   `alreadyRunning: true` and zero counters (callers show no feedback).
 * - Skips items still in cooldown (`nextAttemptAt`) unless `ignoreCooldown`
 *   (explicit user action).
 * - Stops at the first network / rate_limit / invalid_key / forbidden / quota
 *   error (`stoppedBy` says which). invalid_key/forbidden/quota are
 *   configuration errors: they do NOT spend the item's attempts, and automatic
 *   drains pause for 60 s (ignoreCooldown overrides, e.g. right after the user
 *   fixes the key).
 * - Checks the audio file exists first; if not, marks the item permanently
 *   failed immediately (audio is never deleted by the queue).
 * - Permanent item errors count towards MAX_ATTEMPTS; transient ones do not.
 * - `onItemError` is called for every item failure (including a missing audio
 *   file) so the caller can surface it per fileName.
 */
export async function processQueue(
  transcribeFn: (uri: string, item: QueuedTranscription) => Promise<{ text: string }>,
  onItemSuccess?: (item: QueuedTranscription, transcript: string) => Promise<void>,
  options: {
    ignoreCooldown?: boolean;
    skip?: (item: QueuedTranscription) => boolean;
    onItemError?: (item: QueuedTranscription, err: unknown) => void;
  } = {}
): Promise<QueueSummary> {
  if (draining) {
    return summaryNow({ processed: 0, failed: 0, permanentlyFailed: 0, deferred: 0, alreadyRunning: true });
  }
  if (!options.ignoreCooldown && Date.now() < configBlockedUntil) {
    const pending = (await readQueue()).filter((i) => !i.permanentlyFailed).length;
    return {
      ...(await summaryNow({ processed: 0, failed: 0, permanentlyFailed: 0, deferred: pending, alreadyRunning: false })),
      stoppedBy: configBlockedKind,
    };
  }
  draining = true;
  try {
    let processed = 0;
    let failed = 0;
    let permanentlyFailed = 0;
    let deferred = 0;
    let stoppedBy: DrainStopReason | undefined;

    // Snapshot of fileNames only; every step re-reads the live entry by fileName.
    const fileNames = (await readQueue()).filter((i) => !i.permanentlyFailed).map((i) => i.fileName);

    for (const fileName of fileNames) {
      const item = (await readQueue()).find((q) => q.fileName === fileName);
      if (!item || item.permanentlyFailed) continue; // dequeued/changed meanwhile

      if (!options.ignoreCooldown && item.nextAttemptAt !== undefined && item.nextAttemptAt > Date.now()) {
        deferred++;
        continue;
      }
      // Caller says this item is busy elsewhere (e.g. being transcribed by hand).
      if (options.skip?.(item)) {
        deferred++;
        continue;
      }

      // ── 1. Check that the audio file still exists ────────────────────
      let fileExists = false;
      try {
        const info = await FileSystem.getInfoAsync(item.uri);
        fileExists = info.exists;
      } catch {
        fileExists = false;
      }
      if (!fileExists) {
        logWarn('queue', `[queue] audio file missing, marking permanently failed: ${item.fileName}`);
        await updateItem(fileName, (q) => ({
          ...q,
          permanentlyFailed: true,
          nextAttemptAt: undefined,
          lastError: 'Arquivo de áudio não encontrado no dispositivo.',
        }));
        options.onItemError?.(
          item,
          new TranscriptionError('bad_response', 'Arquivo de áudio não encontrado no dispositivo.', { code: 'file' })
        );
        permanentlyFailed++;
        continue;
      }

      // ── 2. Attempt transcription ─────────────────────────────────────
      try {
        const { text } = await transcribeFn(item.uri, item);
        if (onItemSuccess) await onItemSuccess(item, text);
        await dequeueTranscription(fileName);
        processed++;
      } catch (err) {
        const updated = await updateItem(fileName, (q) => applyFailure(q, err, Date.now()));
        if (updated?.permanentlyFailed) {
          logWarn('queue', `[queue] max attempts reached, marking permanently failed: ${fileName}`);
          permanentlyFailed++;
        } else {
          failed++;
        }
        options.onItemError?.(item, err);

        const kind = isTranscriptionError(err) ? err.kind : undefined;
        if (kind === 'invalid_key' || kind === 'forbidden' || kind === 'quota') {
          configBlockedUntil = Date.now() + CONFIG_BLOCK_MS;
          configBlockedKind = kind;
          stoppedBy = kind;
          logDebug('queue', `${kind} config error, stopping queue processing`);
          break;
        }
        if (kind === 'network' || kind === 'rate_limit') {
          stoppedBy = kind;
          logDebug('queue', `${kind} error, stopping queue processing`);
          break;
        }
        // Otherwise keep going; this item failed for item-specific reasons.
      }
    }

    return { ...(await summaryNow({ processed, failed, permanentlyFailed, deferred, alreadyRunning: false })), stoppedBy };
  } finally {
    draining = false;
  }
}

/**
 * Clear the entire queue. Use with caution — typically only on logout or
 * explicit user request.
 */
export async function clearQueue(): Promise<void> {
  await withLock(() => AsyncStorage.removeItem(QUEUE_KEY));
}
