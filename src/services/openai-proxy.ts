// Client wrapper for the Supabase Edge Function proxies.
// See supabase/README.md for the backend.

import { supabase } from './supabase';
import { logError } from './log';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { secureFetch } from './secure-fetch';
import {
  WHISPER_MEDICAL_PROMPT,
  isReasoningModel,
  needsCompletionTokens,
} from './openai-shared';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';

const CHAT_TIMEOUT_MS = 60_000;        // 1 min
const TRANSCRIBE_TIMEOUT_MS = 120_000; // 2 min

interface TranscribeProxyResult {
  text: string;
  audioSeconds: number;
  costUSD: number;
}

interface ChatProxyResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// expoFetch + timeout — necessário para uploads multipart (File nativo do Expo).
// Chamadas JSON usam secureFetch (domain whitelist + HTTPS enforcement).
async function expoFetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await expoFetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Tempo esgotado (${timeoutMs / 1000}s). Verifique sua conexão e tente novamente.`);
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

function createTranscriptionFormData(audioUri: string): FormData {
  const file = new File(audioUri);
  const formData = new FormData();
  formData.append('file', file as unknown as Blob, file.name || 'recording.m4a');
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt');
  formData.append('response_format', 'json');
  formData.append('prompt', WHISPER_MEDICAL_PROMPT);
  return formData;
}

export async function transcribeViaProxy(
  audioUri: string,
  audioBytes: number
): Promise<TranscribeProxyResult> {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessão Supabase necessária para usar o proxy.');

  const response = await expoFetchWithTimeout(
    `${SUPABASE_URL}/functions/v1/openai-transcribe`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-audio-bytes': String(audioBytes),
      },
      body: createTranscriptionFormData(audioUri),
    },
    TRANSCRIBE_TIMEOUT_MS
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Proxy transcribe ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = JSON.parse(body);
  return {
    text: json.text,
    audioSeconds: json.audio_seconds ?? 0,
    costUSD: json.cost_usd ?? 0,
  };
}

export async function chatViaProxy(args: {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
}): Promise<ChatProxyResult> {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessão Supabase necessária para usar o proxy.');

  const reasoning = isReasoningModel(args.model);
  const completionTokens = needsCompletionTokens(args.model);
  const maxT = args.maxTokens ?? 1500;

  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    ...(reasoning ? {} : { temperature: args.temperature ?? 0.3 }),
    ...(completionTokens
      ? { max_completion_tokens: maxT }
      : { max_tokens: maxT }),
  };

  const response = await secureFetch(
    `${SUPABASE_URL}/functions/v1/openai-chat`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: CHAT_TIMEOUT_MS,
      expectContentType: 'application/json',
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Proxy chat ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = await response.json();
  return {
    content: json.content,
    inputTokens: json.input_tokens ?? 0,
    outputTokens: json.output_tokens ?? 0,
    costUSD: json.cost_usd ?? 0,
  };
}

/**
 * Whether the user has a Supabase session (i.e., proxy mode is available).
 * Resolves quickly; safe to call before every request.
 */
export async function isProxyAvailable(): Promise<boolean> {
  try {
    const token = await getAccessToken();
    return !!token && !!SUPABASE_URL;
  } catch (err) {
    logError('isProxyAvailable', err);
    return false;
  }
}
