// Offline transcription queue.
//
// Why: a doctor may record audio without internet (rural hospital, basement,
// during travel). We must NEVER lose the recording — instead, queue the
// transcription request and process it when network returns.
//
// Strategy:
//   1. Recording flow tries transcription immediately. On network error,
//      enqueueTranscription() persists the audio reference.
//   2. Whenever app comes to foreground OR a successful network call happens,
//      processQueue() runs in the background to drain pending items.
//   3. Each item is processed once at a time to avoid hammering the API and
//      to respect rate limits.
//
// Persistence: AsyncStorage holds the queue as JSON. Audio files themselves
// stay in FileSystem.documentDirectory — only their paths are queued.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { logWarn, logDebug } from './log';

const QUEUE_KEY = '@voice_ai_recorder/transcription_queue/v1';

/** After this many failed attempts the item is marked permanently failed. */
const MAX_ATTEMPTS = 5;

export interface QueuedTranscription {
  /** Local file name (e.g. recording_1700000000.m4a). Stable ID. */
  fileName: string;
  /** Absolute file URI for the audio file. */
  uri: string;
  /** ISO timestamp when the recording was made. */
  createdAt: string;
  /** When this item was added to the queue. */
  enqueuedAt: string;
  /** How many times we tried to process this item. */
  attempts: number;
  /** Last error message, for UI display. */
  lastError?: string;
  /** Optional: template id to auto-summarize after transcription succeeds. */
  templateId?: string;
  /**
   * True when the item has exceeded MAX_ATTEMPTS or the audio file is gone.
   * Permanently failed items are never retried automatically — the user must
   * explicitly clear them.
   */
  permanentlyFailed?: boolean;
}

/**
 * Detects if an error is likely a network error (vs OpenAI server error).
 * Network errors are recoverable by retry; other errors should not be queued.
 */
export function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.toLowerCase();
  return (
    m.includes('network') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('tempo esgotado') ||
    m.includes('failed to fetch') ||
    m.includes('aborted') ||
    m.includes('econnrefused') ||
    m.includes('enotfound') ||
    m.includes('socket hang up') ||
    m.includes('offline')
  );
}

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

/**
 * Add a recording to the queue. Idempotent — if already queued, updates
 * the attempts count and lastError instead of duplicating.
 */
export async function enqueueTranscription(
  item: Omit<QueuedTranscription, 'enqueuedAt' | 'attempts'> & {
    lastError?: string;
  }
): Promise<void> {
  const queue = await readQueue();
  const existing = queue.findIndex((q) => q.fileName === item.fileName);
  if (existing >= 0) {
    queue[existing] = {
      ...queue[existing],
      attempts: queue[existing].attempts + 1,
      lastError: item.lastError ?? queue[existing].lastError,
    };
  } else {
    queue.push({
      ...item,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    });
  }
  await writeQueue(queue);
}

/**
 * Remove an item from the queue (call after successful processing).
 */
export async function dequeueTranscription(fileName: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((q) => q.fileName !== fileName));
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
  const q = await readQueue();
  await writeQueue(q.filter((i) => !i.permanentlyFailed));
}

/**
 * Process the queue: tries to transcribe each pending item sequentially.
 * Stops at the first network error (to avoid hammering an offline endpoint).
 *
 * Before calling the transcription function, checks that the audio file
 * still exists — if not, marks the item as permanently failed immediately.
 *
 * After MAX_ATTEMPTS non-network failures, marks the item permanently failed
 * so it is no longer retried automatically.
 *
 * Returns { processed, failed, permanentlyFailed, remaining } summary.
 */
export async function processQueue(
  transcribeFn: (uri: string) => Promise<{ text: string }>,
  onItemSuccess?: (item: QueuedTranscription, transcript: string) => Promise<void>
): Promise<{ processed: number; failed: number; permanentlyFailed: number; remaining: number }> {
  let queue = await readQueue();
  // Only process items that are not already permanently failed
  const pending = queue.filter((i) => !i.permanentlyFailed);
  if (pending.length === 0) {
    const remaining = queue.filter((i) => !i.permanentlyFailed).length;
    return { processed: 0, failed: 0, permanentlyFailed: 0, remaining };
  }

  let processed = 0;
  let failed = 0;
  let permanentlyFailed = 0;

  for (const item of pending) {
    // ── 1. Check that the audio file still exists ──────────────────────
    let fileExists = false;
    try {
      const info = await FileSystem.getInfoAsync(item.uri);
      fileExists = info.exists;
    } catch {
      fileExists = false;
    }

    if (!fileExists) {
      logWarn("queue", `[queue] audio file missing, marking permanently failed: ${item.fileName}`);
      // Mark permanently failed — file is gone, no point retrying
      const currentQueue = await readQueue();
      const idx = currentQueue.findIndex((q) => q.fileName === item.fileName);
      if (idx >= 0) {
        currentQueue[idx] = {
          ...currentQueue[idx],
          permanentlyFailed: true,
          lastError: 'Arquivo de áudio não encontrado no dispositivo.',
        };
        await writeQueue(currentQueue);
      }
      permanentlyFailed++;
      continue;
    }

    // ── 2. Attempt transcription ───────────────────────────────────────
    try {
      const { text } = await transcribeFn(item.uri);
      // Success — let caller persist the transcript
      if (onItemSuccess) {
        await onItemSuccess(item, text);
      }
      await dequeueTranscription(item.fileName);
      processed++;
    } catch (err) {
      const netErr = isNetworkError(err);
      const msg = err instanceof Error ? err.message : String(err);
      const newAttempts = item.attempts + 1;
      const isPermanent = !netErr && newAttempts >= MAX_ATTEMPTS;

      // Update attempts/lastError in queue
      const currentQueue = await readQueue();
      const idx = currentQueue.findIndex((q) => q.fileName === item.fileName);
      if (idx >= 0) {
        currentQueue[idx] = {
          ...currentQueue[idx],
          attempts: newAttempts,
          lastError: msg,
          ...(isPermanent ? { permanentlyFailed: true } : {}),
        };
        await writeQueue(currentQueue);
      } else {
        // Item was not in queue yet (first failure from handleTranscribe path)
        await enqueueTranscription({
          fileName: item.fileName,
          uri: item.uri,
          createdAt: item.createdAt,
          templateId: item.templateId,
          lastError: msg,
        });
      }

      if (isPermanent) {
        logWarn("queue", `[queue] max attempts reached, marking permanently failed: ${item.fileName}`);
        permanentlyFailed++;
      } else {
        failed++;
      }

      if (netErr) {
        // Network is down — stop trying the rest now
        logDebug('queue', 'network error, stopping queue processing');
        break;
      }
      // Otherwise: keep going; this item failed for non-network reasons
    }
  }

  queue = await readQueue();
  const remaining = queue.filter((i) => !i.permanentlyFailed).length;
  return { processed, failed, permanentlyFailed, remaining };
}

/**
 * Clear the entire queue. Use with caution — typically only on logout or
 * explicit user request.
 */
export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
}
