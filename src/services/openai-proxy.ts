// Client wrapper for the Supabase Edge Function proxies.
// See supabase/README.md for the backend.

import { supabase } from './supabase';
import { logError } from './log';
import { secureFetch } from './secure-fetch';
import {
  isReasoningModel,
  needsCompletionTokens,
} from './openai-shared';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';

const CHAT_TIMEOUT_MS = 60_000;        // 1 min

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
