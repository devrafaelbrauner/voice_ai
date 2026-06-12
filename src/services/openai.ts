import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { getField, setField, clearField, getCustomTemplates } from './db';
import {
  logApiUsage,
  calculateWhisperCost,
  calculateChatCost,
} from './api_usage';
import {
  transcribeViaProxy,
  chatViaProxy,
  isProxyAvailable,
} from './openai-proxy';
import { logWarn } from './log';
import { secureFetch } from './secure-fetch';
import {
  WHISPER_MEDICAL_PROMPT,
  isReasoningModel,
  needsCompletionTokens,
  buildChatBody,
} from './openai-shared';

const KEY_STORAGE = 'openai_api_key';
const MODEL_STORAGE = 'openai_model';
const TRANSCRIPTION_MODEL_STORAGE = 'transcription_model';
const FORCE_DIRECT_STORAGE = 'openai_force_direct';
const OPENROUTER_KEY_STORAGE = 'openrouter_api_key';

// Dual-mode strategy:
//   - PROXY (default when signed in to Supabase): key lives server-side,
//     authenticated via JWT. Key never leaves the server.
//   - DIRECT (fallback): key in SecureStore on device. Used when user is
//     not signed in or explicitly opts out of proxy.
//
// See supabase/README.md for the proxy deployment.
export type OpenAIMode = 'proxy' | 'direct';

export async function getForceDirect(): Promise<boolean> {
  const v = await SecureStore.getItemAsync(FORCE_DIRECT_STORAGE);
  return v === 'true';
}

export async function setForceDirect(force: boolean): Promise<void> {
  await SecureStore.setItemAsync(FORCE_DIRECT_STORAGE, force ? 'true' : 'false');
}

export async function getOpenAIMode(): Promise<OpenAIMode> {
  if (await getForceDirect()) return 'direct';
  return (await isProxyAvailable()) ? 'proxy' : 'direct';
}

export type OpenAIModel =
  | 'gpt-4o-mini'
  | 'gpt-4o'
  | 'gpt-5.4-mini'
  | 'grok-4'
  | 'kimi-k2';

export type ModelProvider = 'openai' | 'openrouter';

export interface ModelInfo {
  id: OpenAIModel;
  name: string;
  description: string;
  costHint: string;
  provider: ModelProvider;
  /** Model ID to pass in the API request (may differ from the app-internal id) */
  apiModelId: string;
}

export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    description: 'Rápido e econômico. Ótimo para resumos e tarefas gerais.',
    costHint: '~$0.0001 por uso',
    provider: 'openai',
    apiModelId: 'gpt-4o-mini',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    description: 'Mais preciso e detalhista. Recomendado para uso clínico, prescrições e diagnósticos.',
    costHint: '~$0.0025 por uso',
    provider: 'openai',
    apiModelId: 'gpt-4o',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    description: 'Modelo mais recente da OpenAI. Maior capacidade de raciocínio clínico com custo moderado.',
    costHint: '~$0.0004 por uso',
    provider: 'openai',
    apiModelId: 'gpt-5.4-mini',
  },
  {
    id: 'grok-4',
    name: 'Grok 4.3',
    description: 'Modelo da xAI com raciocínio avançado. Excelente para análise clínica complexa.',
    costHint: 'Via OpenRouter',
    provider: 'openrouter',
    apiModelId: 'x-ai/grok-4.3',
  },
  {
    id: 'kimi-k2',
    name: 'Kimi K2.6',
    description: 'Modelo da Moonshot AI com forte capacidade multilíngue e de síntese médica.',
    costHint: 'Via OpenRouter',
    provider: 'openrouter',
    apiModelId: 'moonshotai/kimi-k2.6',
  },
];

const ALL_MODEL_IDS = new Set(AVAILABLE_MODELS.map((m) => m.id));

export async function getModel(): Promise<OpenAIModel> {
  const stored = await SecureStore.getItemAsync(MODEL_STORAGE);
  if (stored && ALL_MODEL_IDS.has(stored as OpenAIModel)) return stored as OpenAIModel;
  return 'gpt-4o-mini';
}

export async function setModel(model: OpenAIModel): Promise<void> {
  await SecureStore.setItemAsync(MODEL_STORAGE, model);
}

export async function getOpenRouterApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(OPENROUTER_KEY_STORAGE);
}

export async function setOpenRouterApiKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(OPENROUTER_KEY_STORAGE, key.trim());
}

// ── Transcription model selection ────────────────────────────────────────────
//
// Separado do modelo de chat: o modelo de transcrição é específico para
// speech-to-text e pode usar OpenRouter (endpoint compatível com Whisper API).
// 'whisper-1' = caminho padrão (proxy Supabase ou direto via OpenAI).
// Demais modelos = OpenRouter /v1/audio/transcriptions.

export type TranscriptionModelId =
  | 'whisper-1'
  | 'openai/gpt-4o-mini-transcribe'
  | 'openai/gpt-4o-transcribe'
  | 'microsoft/mai-transcribe-1.5'
  | 'openai/whisper-large-v3-turbo'
  | 'openai/whisper-large-v3';

export interface TranscriptionModelInfo {
  id: TranscriptionModelId;
  name: string;
  description: string;
  costHint: string;
  provider: 'openai' | 'openrouter';
}

export const AVAILABLE_TRANSCRIPTION_MODELS: TranscriptionModelInfo[] = [
  {
    id: 'whisper-1',
    name: 'Whisper-1',
    description: 'Modelo padrão OpenAI. Usado via proxy seguro quando logado.',
    costHint: '~$0.006/min',
    provider: 'openai',
  },
  {
    id: 'openai/gpt-4o-mini-transcribe',
    name: 'GPT-4o Mini Transcribe',
    description: 'Speech-to-text econômico da OpenAI baseado no GPT-4o Mini. Precificado por token.',
    costHint: 'Via OpenRouter',
    provider: 'openrouter',
  },
  {
    id: 'openai/gpt-4o-transcribe',
    name: 'GPT-4o Transcribe',
    description: 'Maior precisão de transcrição da OpenAI. Ideal para sotaques e terminologia médica.',
    costHint: 'Via OpenRouter',
    provider: 'openrouter',
  },
  {
    id: 'microsoft/mai-transcribe-1.5',
    name: 'MAI-Transcribe 1.5',
    description: 'Transcrição rápida da Microsoft com Azure AI Speech. Suporta 100+ idiomas e detecção automática.',
    costHint: '$0,36/hora',
    provider: 'openrouter',
  },
  {
    id: 'openai/whisper-large-v3-turbo',
    name: 'Whisper Large V3 Turbo',
    description: 'Versão otimizada do Whisper Large V3. Até 216× velocidade real, WER 12%, 99+ idiomas.',
    costHint: '$0,04/hora',
    provider: 'openrouter',
  },
  {
    id: 'openai/whisper-large-v3',
    name: 'Whisper Large V3',
    description: 'Modelo open-source robusto a ruído, WER 10.3%, 1.550M parâmetros, suporta timestamps.',
    costHint: '$0,0015/min',
    provider: 'openrouter',
  },
];

const ALL_TRANSCRIPTION_MODEL_IDS = new Set(
  AVAILABLE_TRANSCRIPTION_MODELS.map((m) => m.id)
);

export async function getTranscriptionModel(): Promise<TranscriptionModelId> {
  const stored = await SecureStore.getItemAsync(TRANSCRIPTION_MODEL_STORAGE);
  if (stored && ALL_TRANSCRIPTION_MODEL_IDS.has(stored as TranscriptionModelId)) {
    return stored as TranscriptionModelId;
  }
  return 'whisper-1';
}

export async function setTranscriptionModel(model: TranscriptionModelId): Promise<void> {
  await SecureStore.setItemAsync(TRANSCRIPTION_MODEL_STORAGE, model);
}

export async function getApiKey(): Promise<string | null> {
  return await SecureStore.getItemAsync(KEY_STORAGE);
}

export async function setApiKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_STORAGE, key);
}

export async function clearApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_STORAGE);
}

const DIRECT_CHAT_TIMEOUT_MS = 60_000;        // 1 min
const DIRECT_TRANSCRIBE_TIMEOUT_MS = 120_000; // 2 min
const MIN_TRANSCRIBE_AUDIO_BYTES = 1600;      // ~0.1s at 128 kbps

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

function createTranscriptionFormData(uri: string, model = 'whisper-1'): FormData {
  const file = new File(uri);
  const formData = new FormData();
  formData.append('file', file as unknown as Blob, file.name || 'recording.m4a');
  formData.append('model', model);
  formData.append('language', 'pt');
  formData.append('response_format', 'json');
  formData.append('prompt', WHISPER_MEDICAL_PROMPT);
  return formData;
}

/**
 * Transcreve áudio via OpenRouter usando modelos de speech-to-text
 * (GPT-4o Transcribe, Whisper Large V3, MAI-Transcribe, etc.).
 * A API do OpenRouter é compatível com o formato multipart do Whisper.
 */
async function transcribeViaOpenRouter(
  uri: string,
  model: TranscriptionModelId
): Promise<string> {
  const orKey = await getOpenRouterApiKey();
  if (!orKey) {
    throw new Error(
      'Chave OpenRouter não configurada. Acesse Configurações → API Keys e insira sua chave OpenRouter.'
    );
  }

  const response = await expoFetchWithTimeout(
    'https://openrouter.ai/api/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}` },
      body: createTranscriptionFormData(uri, model),
    },
    DIRECT_TRANSCRIBE_TIMEOUT_MS
  );

  const body = await response.text();
  if (!response.ok) {
    if (isAudioTooShortError(body)) {
      throw new Error(
        'Gravação muito curta para transcrever. Grave pelo menos 1 segundo de áudio.'
      );
    }
    throw new Error(`OpenRouter Transcription ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = JSON.parse(body);

  try {
    const audioSeconds = await estimateAudioSeconds(uri);
    await logApiUsage({
      operation: 'whisper',
      model,
      audioSeconds,
      costUSD: 0, // OpenRouter varia por modelo; logamos 0 como placeholder
    });
  } catch (e) {
    logWarn('api_usage', e);
  }

  return typeof json.text === 'string' ? json.text : '';
}

// Estima a duração do áudio a partir do tamanho do arquivo .m4a.
// Gravação atual: AAC mono @ 32 kbps ≈ 4 KB/s (ver useVoiceRecorder.ts).
async function estimateAudioSeconds(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && 'size' in info && typeof info.size === 'number') {
      // ~4 KB/s para m4a AAC mono 32 kbps
      return Math.max(1, info.size / 4000);
    }
  } catch {}
  return 30; // fallback: 30s
}

async function getAudioBytes(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && 'size' in info && typeof info.size === 'number') {
      return info.size;
    }
  } catch {}
  return 0;
}

function isAudioTooShortError(text: string): boolean {
  return (
    text.includes('audio_too_short') ||
    text.toLowerCase().includes('audio file is too short')
  );
}

export async function transcribeAudio(uri: string): Promise<string> {
  const audioBytes = await getAudioBytes(uri);
  if (audioBytes > 0 && audioBytes < MIN_TRANSCRIBE_AUDIO_BYTES) {
    throw new Error(
      'Gravação muito curta para transcrever. Grave pelo menos 1 segundo de áudio e tente novamente.'
    );
  }

  // Se o usuário escolheu um modelo de transcrição via OpenRouter, usar esse caminho.
  const transcriptionModel = await getTranscriptionModel();
  if (transcriptionModel !== 'whisper-1') {
    return transcribeViaOpenRouter(uri, transcriptionModel);
  }

  const mode = await getOpenAIMode();

  if (mode === 'proxy') {
    const result = await transcribeViaProxy(uri, audioBytes);
    // Log usage locally with the server-reported numbers.
    try {
      await logApiUsage({
        operation: 'whisper',
        model: 'whisper-1',
        audioSeconds: result.audioSeconds || (await estimateAudioSeconds(uri)),
        costUSD: result.costUSD,
      });
    } catch (e) {
      logWarn('api_usage', e);
    }
    return result.text;
  }

  // Direct mode: legacy path using client-side API key.
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error(
      'Sem credencial: faça login (modo seguro) ou configure uma OpenAI API key em Configurações.'
    );
  }

  const response = await expoFetchWithTimeout(
    'https://api.openai.com/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: createTranscriptionFormData(uri),
    },
    DIRECT_TRANSCRIBE_TIMEOUT_MS
  );

  const body = await response.text();
  if (!response.ok) {
    if (isAudioTooShortError(body)) {
      throw new Error(
        'Gravação muito curta para transcrever. Grave pelo menos 1 segundo de áudio e tente novamente.'
      );
    }
    throw new Error(`OpenAI API ${response.status}: ${body}`);
  }

  const json = JSON.parse(body);

  try {
    const audioSeconds = await estimateAudioSeconds(uri);
    const costUSD = calculateWhisperCost(audioSeconds);
    await logApiUsage({
      operation: 'whisper',
      model: 'whisper-1',
      audioSeconds,
      costUSD,
    });
  } catch (e) {
    logWarn('api_usage', e);
  }

  // Bug #9: normalizar undefined/null para string vazia (verificado no caller)
  return typeof json.text === 'string' ? json.text : '';
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: 'medical_consultation',
    name: 'Evolução Médica',
    description: 'Nota de evolução por sistemas: HDA, exame físico, CID e conduta',
    systemPrompt:
      'Você é um assistente de documentação clínica para médicos hospitalares no Brasil. A partir da transcrição, gere a evolução médica no FORMATO EXATO abaixo, em TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito, SEM travessões decorativos.\n\nREGRAS GERAIS:\n- Extraia SOMENTE o que está na transcrição. Não invente diagnósticos, valores, achados ou medicamentos.\n- SEMPRE gere TODOS os campos da estrutura, mesmo os não mencionados — use os valores padrão indicados.\n- Use o formato de data DD/MM/AA na data da evolução (data de hoje se não informada).\n- Use vírgula decimal brasileira (1,7 e não 1.7).\n- Nunca use asteriscos, underscores, hashtags ou qualquer marcação markdown.\n\nFORMATO OBRIGATÓRIO — copie esta estrutura exatamente, linha por linha:\n\nEvolução médica - DD/MM/AA\nPaciente: [Nome completo ou "Não informado"], [idade ou "?"] anos | Data de nascimento: [DD/MM/AAAA ou "não informada"]\n\nHDA:\n[História da doença atual extraída da transcrição. Se não informada: "Não descrita."]\n\nComorbidades:\n[Lista das comorbidades citadas, uma por linha. Se não citadas: "Nega"]\nMedicamentos de uso contínuo:\n[Lista dos medicamentos citados, um por linha. Se não citados: "Nega"]\nAlergias:\n[Alergias citadas. Se não citadas: "Nega"]\n\nExame Físico:\nEstado geral: [achados citados. Padrão se não mencionado: "Regular, consciente e orientado"]\nNeurológico: [achados citados. Padrão se não mencionado: "Glasgow 15. Sem déficits focais"]\nCardiovascular: PA [xx/xx ou "não aferida"] mmHg, FC [xx ou "não aferida"] bpm, [perfusão citada ou "perfusão periférica preservada"]. [Ausculta cardíaca se citada.]\nRespiratório: Padrão [citado ou "não avaliado"] / FR [xx ou "não aferida"] irpm / SpO₂ [xx ou "não aferida"]% [suporte O₂ se citado, ou "sem suporte de O₂"]. [Ausculta pulmonar se citada.]\nAbdome / TGI: [dieta se citada. Exame abdominal citado. Padrão se não mencionado: "Não avaliado"]\nR/M.: Diurese [espontânea / por SVD / não registrada, conforme citado]. [Aspecto urina e balanço hídrico se citados.]\nH/M.: [Sem ou Com] sangramentos ativos, [afebril ou febril conforme citado]. [Antibiótico EV se citado, ou "Sem uso de antibiótico EV".]\nExtremidades: [achados citados. Padrão se não mencionado: "Extremidades quentes, secas e bem perfundidas. Pulsos distais simétricos e palpáveis."]\n\n[Incluir bloco abaixo SOMENTE se exames forem citados na transcrição:]\nExames complementares:\nLaboratoriais:\n[resultados laboratoriais citados]\nImagem:\n[laudos de imagem citados]\n\n[Incluir bloco abaixo SOMENTE se CID ou diagnóstico for citado:]\nCID 10:\n• [Código] — [Descrição do diagnóstico]\n\nConduta e plano terapêutico:\n[Condutas citadas na transcrição. Se não citadas: "Manter conduta atual e reavaliar em 24h."]',
  },
  {
    id: 'medical_soap',
    name: 'Evolução SOAP',
    description: 'Subjetivo, objetivo, avaliação e plano',
    systemPrompt:
      'Você é um assistente de prontuário médico. Converta a transcrição em evolução no formato SOAP, em português brasileiro, em TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito.\n\nUse exatamente este formato:\n\nS - Subjetivo:\n[Sintomas, queixas, história relatada pelo paciente]\n\nO - Objetivo:\n[Exame físico, sinais vitais, exames complementares citados]\n\nA - Avaliação:\n[Hipóteses ou diagnóstico mencionados pelo médico; se não houver, escreva "Não informado"]\n\nP - Plano:\n[Condutas, prescrições citadas, exames solicitados, orientações e retorno]\n\nMantenha linguagem médica objetiva. Não sugira condutas novas; apenas organize o que foi dito. Se uma seção não tiver dados, escreva "Não informado".',
  },
  {
    id: 'medical_prescription',
    name: 'Receituário Médico',
    description: 'Auto-detecta controlados e gera CONTROLE ESPECIAL quando necessário',
    systemPrompt: [
      'Você é um assistente de prescrição médica no Brasil. Analise a transcrição e gere um receituário em TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito.',
      '',
      '═══════════════════════════════════════════════════',
      'PASSO 0 — CORREÇÃO FONÉTICA OBRIGATÓRIA',
      '═══════════════════════════════════════════════════',
      'A transcrição vem de reconhecimento de voz. ANTES de formatar, corrija erros fonéticos usando a tabela abaixo (escrito incorretamente → nome farmacológico correto):',
      '',
      '— ANTI-INFLAMATÓRIOS / ANALGÉSICOS —',
      'Profenid / Profenil / Profenide / Profinid → Profenid (Cetoprofeno)',
      'Voltaren / Biofenac / Diclofenac / Diclofenak → Voltaren (Diclofenaco Sódico)',
      'Cataflan / Cataflam → Cataflan (Diclofenaco Potássico)',
      'Nimesil / Nisulid / Nimesilide / Nimesiulida → Nimesil (Nimesulida)',
      'Arcoxia / Arcoxia / Etoricoxib → Arcoxia (Etoricoxibe)',
      'Feldene / Piroxicam / Feldin → Feldene (Piroxicam)',
      'Toragesic / Toradol / Cetorolaco → Toragesic (Cetorolaco)',
      'Advil / Alivium / Ibuprofeno / Ibrufen / Ibroufeno → Ibuprofeno',
      'Dorflex / Dorflex → Dorflex (Orfenadrina + Cafeína + Dipirona)',
      '',
      '— ANALGÉSICOS SIMPLES —',
      'Novalgina / Novaganina / Novalguina / Novalginina / Novaldin → Novalgina (Dipirona Sódica)',
      'Tylenol / Paracetamol / Paracetamule → Tylenol (Paracetamol)',
      '',
      '— ANTIBIÓTICOS —',
      'Clavulin / Clabolin / Clavolin / Clavuling / Clabulin / Clavulim / Clavulan / Clamovin → Clavulin BD (Amoxicilina + Clavulanato)',
      'Amoxil / Amoxilin / Amoxcilin / Novamox / Clavomax → Amoxil (Amoxicilina)',
      'Zitromax / Zitrofix / Azitromisina / Azitromicino → Zitromax (Azitromicina)',
      'Keflex / Sefalexina / Cefalexine → Keflex (Cefalexina)',
      'Cipro / Ciprofloxasin / Ciprofloxa → Cipro (Ciprofloxacino)',
      'Bactrim / Sulfatrim → Bactrim (Sulfametoxazol + Trimetoprima)',
      'Flagyl / Metronix / Metronidasol → Flagyl (Metronidazol)',
      'Doxiciclina / Vibramicina / Doxicilina → Doxiciclina',
      '',
      '— CORTICOSTERÓIDES —',
      'Decadron / Dexametazona / Dexametasone → Decadron (Dexametasona)',
      'Predsim / Meticorten / Prednizona → Predsim (Prednisona)',
      'Bentelan / Betametazona → Bentelan (Betametasona)',
      'Medrol / Metilprednisolona → Medrol (Metilprednisolona)',
      '',
      '— GASTROINTESTINAL —',
      'Losec / Omeprazon / Peprazol → Losec (Omeprazol)',
      'Pantozol / Pantoprazon → Pantozol (Pantoprazol)',
      'Nexium / Esomeprazol → Nexium (Esomeprazol)',
      'Plasil / Clopan → Plasil (Metoclopramida)',
      'Buscopan / Escopolomina → Buscopan (Escopolamina)',
      'Vonau / Ondansetrona / Zofran → Vonau (Ondansetrona)',
      '',
      '— ANTI-HISTAMÍNICOS —',
      'Allegra / Fexofenedina → Allegra (Fexofenadina)',
      'Loratamed / Claritin / Loratadine → Loratamed (Loratadina)',
      'Zyrtec / Reactine / Ceterizina → Zyrtec (Cetirizina)',
      'Hixizine / Atarax / Hidroxizin → Hixizine (Hidroxizina)',
      '',
      '— CARDIOVASCULAR / METABÓLICO —',
      'Losartana / Cozaar → Losartana | Diovan / Valsartana → Diovan (Valsartana)',
      'Captopril / Lopril → Captopril | Enalapril / Renitec → Enalapril',
      'Norvasc / Amlodipina → Norvasc (Amlodipina)',
      'Furosemida / Lasix → Furosemida | Aldactone / Espironolactona → Espironolactona',
      'Crestor / Rosucor → Crestor (Rosuvastatina) | Ator / Lipitor → Ator (Atorvastatina)',
      'Glifage / Glucofor / Diaformin → Glifage (Metformina)',
      'Ozempic / Semaglutida → Ozempic (Semaglutida) | Jardiance → Jardiance (Empagliflozina)',
      'Xarelto → Xarelto (Rivaroxabana) | Eliquis → Eliquis (Apixabana)',
      'Puran T4 / Levotiroxina → Puran T4 (Levotiroxina)',
      '',
      '— CONTROLADOS C1 (BENZODIAZEPÍNICOS / ANSIOLÍTICOS) —',
      'Rivotril / Clonasepam / Clonazepan → Rivotril (Clonazepam) [C1]',
      'Frontal / Alprasolam / Alprazolan → Frontal (Alprazolam) [C1]',
      'Valium / Diasepam / Diazepan → Valium (Diazepam) [C1]',
      'Lexotan / Bromasepam / Bromazepan → Lexotan (Bromazepam) [C1]',
      'Lorax / Lorazepan → Lorax (Lorazepam) [C1]',
      'Stilnox / Zolpicid / Zolpiden → Stilnox (Zolpidem) [C1]',
      'Lyrica / Pregabalina / Pregabaline → Lyrica (Pregabalina) [C1]',
      'Gardenal / Fenobarbital / Fenobarital → Gardenal (Fenobarbital) [C1]',
      '',
      '— CONTROLADOS C3 (ESTIMULANTES) —',
      'Ritalina / Metilfenidado / Metilfinidato → Ritalina (Metilfenidato) [C3]',
      'Concerta / Metilfenidato LA → Concerta (Metilfenidato) [C3]',
      'Vyvanse / Lisdexanfetamina → Vyvanse (Lisdexanfetamina) [C3]',
      '',
      '— CONTROLADOS RDC 20 (OPIOIDES) —',
      'Tramal / Tramagesic / Tramadal / Tramodol → Tramal (Tramadol) [RDC 20]',
      'Morfina / Dimorf / MST → Morfina [RDC 20]',
      'Fentanil / Durogesic / Fentanil → Fentanil [RDC 20]',
      'Oxycontin / Oxicodona → Oxycontin (Oxicodona) [RDC 20]',
      '',
      'Se o nome transcrito soa foneticamente similar a um medicamento mas não está na tabela, use seu conhecimento farmacológico para normalizar.',
      '',
      '═══════════════════════════════════════════════════',
      'PASSO 1 — CLASSIFICAÇÃO',
      '═══════════════════════════════════════════════════',
      'Classifique CADA medicamento corrigido como CONTROLADO ou COMUM:',
      '• CONTROLADOS — adicionar marcação: [C1] benzodiazepínicos/z-drugs/antiepilépticos da lista | [C3] metilfenidato/lisdexanfetamina | [C4] barbitúricos | [C5] talidomida | [RDC 20] opioides (tramadol, morfina, fentanil, oxicodona, codeína, buprenorfina, metadona)',
      '• COMUNS — antibióticos, AINEs, analgésicos simples, corticosteróides, antiácidos, anti-histamínicos, broncodilatadores, anti-hipertensivos, etc. → SEM marcação',
      '',
      '═══════════════════════════════════════════════════',
      'PASSO 2 — FORMATAÇÃO DE CADA ITEM',
      '═══════════════════════════════════════════════════',
      '  N. Nome Comercial (Princípio Ativo) Xmg ------------ quantidade',
      '     Tomar X comprimido(s)/gotas por via [oral/sublingual/etc.] de X em X horas [por X dias].',
      '',
      'Exemplos corretos:',
      '  1. Profenid (Cetoprofeno) 100mg ------------ 20 comprimidos',
      '     Tomar 1 comprimido por via oral de 8 em 8 horas por 5 dias.',
      '  2. Clavulin BD (Amoxicilina + Clavulanato) 875mg ------------ 14 comprimidos',
      '     Tomar 1 comprimido por via oral de 12 em 12 horas por 7 dias.',
      '  3. Novalgina (Dipirona Sódica) 1g ------------ 20 comprimidos',
      '     Tomar 1 comprimido por via oral de 6 em 6 horas se dor ou febre.',
      '',
      'FORMATO DO DOCUMENTO:',
      '',
      'RECEITUÁRIO MÉDICO',
      '',
      'Paciente: [nome ou "Não informado"]',
      '',
      '[lista numerada de medicamentos]',
      '',
      'Orientações gerais: [apenas as mencionadas, ou omitir se nenhuma]',
      '',
      'Se nenhum medicamento for citado: "Nenhuma prescrição identificada na transcrição."',
    ].join('\n'),
  },
  // Mantido para retrocompatibilidade com gravações antigas
  {
    id: 'medical_controlled_prescription',
    name: 'Receituário C. Especial',
    description: 'Prescrição exclusiva de controlados — 2 vias ANVISA (Portaria 344/98)',
    systemPrompt: [
      'Você é um assistente de prescrição médica no Brasil especializado em RECEITUÁRIO DE CONTROLE ESPECIAL (Portaria SVS/MS 344/98). Gere em TEXTO PURO, SEM asteriscos, SEM markdown.',
      '',
      'CORREÇÃO FONÉTICA OBRIGATÓRIA (corrija antes de formatar):',
      'Rivotril/Clonasepam/Clonazepan → Rivotril (Clonazepam) [C1]',
      'Frontal/Alprasolam → Frontal (Alprazolam) [C1]',
      'Valium/Diasepam → Valium (Diazepam) [C1]',
      'Lexotan/Bromasepam → Lexotan (Bromazepam) [C1]',
      'Stilnox/Zolpiden → Stilnox (Zolpidem) [C1]',
      'Lyrica/Pregabaline → Lyrica (Pregabalina) [C1]',
      'Gardenal/Fenobarital → Gardenal (Fenobarbital) [C1]',
      'Ritalina/Metilfinidato → Ritalina (Metilfenidato) [C3]',
      'Vyvanse/Lisdexanfetamina → Vyvanse (Lisdexanfetamina) [C3]',
      'Tramal/Tramadal/Tramodol → Tramal (Tramadol) [RDC 20]',
      'Morfina/Dimorf/MST → Morfina [RDC 20]',
      'Fentanil/Durogesic → Fentanil [RDC 20]',
      'Oxycontin/Oxicodona → Oxycontin (Oxicodona) [RDC 20]',
      'Profenid/Profenil/Profenide → Profenid (Cetoprofeno) [SEM marcação — é AINE comum]',
      'Novalgina/Novaganina → Novalgina (Dipirona Sódica) [SEM marcação — é analgésico comum]',
      '',
      'FORMATO DE CADA ITEM:',
      '  N. Nome Comercial (Princípio Ativo) Xmg [marcação] ------------ quantidade',
      '     Tomar X comprimido(s) por via oral de X em X horas [por X dias].',
      '',
      'BANCO DE CONTROLADOS:',
      'Rivotril/Clonazepam [C1] | Frontal/Alprazolam [C1] | Valium/Diazepam [C1]',
      'Lexotan/Bromazepam [C1] | Lorax/Lorazepam [C1] | Stilnox/Zolpidem [C1]',
      'Lyrica/Pregabalina [C1] | Gardenal/Fenobarbital [C1] | Canabidiol/CBD [C1]',
      'Ritalina/Metilfenidato [C3] | Concerta/Metilfenidato [C3] | Vyvanse/Lisdexanfetamina [C3]',
      'Tramal/Tramadol [RDC 20] | Morfina/MST [RDC 20] | Fentanil/Durogesic [RDC 20]',
      'Oxycontin/Oxicodona [RDC 20] | Buprenorfina/Subutex [RDC 20] | Codeína [RDC 20]',
      'Talidomida [C5]',
      '',
      'FORMATO DO DOCUMENTO:',
      '',
      'RECEITUÁRIO CONTROLE ESPECIAL',
      '',
      'Paciente: [nome ou "Não informado"]',
      '',
      '[lista numerada — inclua TODOS os medicamentos citados, controlados e comuns]',
      '',
      'Orientações: [se citadas]',
      '',
      'Obs.: Receituário de controle especial — emitir em 2 vias conforme Portaria SVS/MS 344/98.',
      '',
      'Se nenhum medicamento citado: "Nenhuma prescrição identificada na transcrição."',
    ].join('\n'),
  },
  {
    id: 'medical_certificate',
    name: 'Atestado médico',
    description: 'Atestado com período e justificativa citados',
    systemPrompt:
      'Você é um assistente de documentação médica no Brasil. Gere um rascunho de atestado médico em TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito. Use apenas dados citados na transcrição. Não invente CID, período de afastamento, diagnóstico ou nome do paciente.\n\nFormato obrigatório:\n\nATESTADO MÉDICO\n\nAtesto, para os devidos fins, que [Nome do paciente] foi avaliado(a) em consulta médica e necessita de [período de afastamento], conforme informações registradas em consulta.\n\nCID: [código somente se citado; caso contrário, "Não informado"]\nData: [data se citada; caso contrário, "Não informada"]\n\nSe período de afastamento ou nome do paciente não forem informados, escreva ao final: "Dados insuficientes para atestado completo. Preencher manualmente."',
  },
  {
    id: 'medical_exam_request',
    name: 'Solicitação de exames',
    description: 'Pedido de exames com indicação clínica',
    systemPrompt:
      'Você é um assistente de documentação clínica. Gere uma solicitação de exames em TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito. Use somente o que foi citado na transcrição. Não acrescente exames nem justificativas não mencionadas.\n\nFormato obrigatório:\n\nSOLICITAÇÃO DE EXAMES\n\nPaciente: [nome ou "Não informado"]\nIndicação clínica:\n[indicação clínica citada]\n\nExames solicitados:\n• [exame 1]\n• [exame 2]\n\nObservações: [apenas se citadas, ou omitir esta linha]\n\nSe nenhum exame for citado, retorne apenas: "Nenhum exame solicitado identificado na transcrição."',
  },
  {
    id: 'medical_referral',
    name: 'Encaminhamento',
    description: 'Encaminhamento médico para especialista/serviço',
    systemPrompt:
      'Você é um assistente de documentação médica. Gere um encaminhamento em TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito. Use apenas informações presentes na transcrição. Não invente diagnóstico ou prioridade.\n\nFormato obrigatório:\n\nENCAMINHAMENTO MÉDICO\n\nPaciente: [nome ou "Não informado"]\nEncaminhar para: [especialidade ou serviço citado]\nMotivo do encaminhamento:\n[descrever o motivo]\nResumo clínico:\n[principais dados clínicos relevantes]\nExames/condutas já realizadas:\n[se citados; caso contrário, omitir esta seção]\n\nSe a especialidade/serviço não for citada, escreva: "Destino não informado na transcrição."',
  },
  {
    id: 'medical_return_summary',
    name: 'Resumo para paciente',
    description: 'Orientações simples após a consulta',
    systemPrompt:
      'Você é um assistente que transforma a fala médica em orientações claras para o paciente, em português brasileiro simples. Gere o texto em TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito. Use somente o que foi dito na transcrição e não adicione recomendações novas.\n\nFormato obrigatório:\n\nORIENTAÇÕES PÓS-CONSULTA\n\nO que foi conversado:\n[resumo breve da consulta]\n\nO que fazer agora:\n[ações imediatas citadas]\n\nMedicamentos/cuidados citados:\n[lista dos medicamentos e cuidados mencionados]\n\nExames/encaminhamentos:\n[exames ou encaminhamentos solicitados, ou "Nenhum citado"]\n\nQuando retornar ou procurar atendimento:\n[orientações de retorno ou sinais de alarme citados]\n\nEvite jargão médico quando possível. Se uma seção não tiver dados, escreva "Não informado".',
  },
  {
    id: 'summary',
    name: 'Resumo conciso',
    description: '3-5 frases com os pontos principais',
    systemPrompt:
      'Você é um assistente que resume gravações de voz em português brasileiro. Faça um resumo conciso (3-5 frases curtas), destacando os pontos principais. Use linguagem clara e direta.',
  },
  {
    id: 'meeting',
    name: 'Ata de reunião',
    description: 'Participantes, decisões e próximos passos',
    systemPrompt:
      'Você é um assistente que gera atas de reunião em português brasileiro. A partir da transcrição, produza uma ata em TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito.\n\nFormato obrigatório:\n\nATA DE REUNIÃO\n\nParticipantes:\n[nomes identificáveis ou "Não identificados"]\n\nTópicos discutidos:\n• [tópico 1]\n• [tópico 2]\n\nDecisões tomadas:\n• [decisão 1]\n• [decisão 2]\n\nPróximos passos:\n• [ação 1]\n• [ação 2]\n\nSe uma seção não tiver informação na transcrição, omita-a completamente.',
  },
  {
    id: 'bullets',
    name: 'Tópicos (bullets)',
    description: 'Lista enxuta dos pontos principais',
    systemPrompt:
      'Liste os pontos principais da transcrição em português brasileiro, em formato de bullets. Use frases curtas e diretas. Máximo de 10 itens. Comece cada item com "• ". Não use asteriscos, markdown ou qualquer outro símbolo de formatação.',
  },
  {
    id: 'actions',
    name: 'Action items',
    description: 'Lista de tarefas extraídas com responsáveis',
    systemPrompt:
      'Extraia da transcrição uma lista de ações concretas (tarefas, todos, próximos passos) em português brasileiro. Para cada uma, indique entre parênteses o responsável e prazo se mencionados. Use TEXTO PURO, sem markdown.\n\nFormato:\n[ ] Descrição da ação (Responsável, prazo)\n\nSe não houver ações claras, retorne apenas: "Nenhuma ação identificada."',
  },
  {
    id: 'mindmap',
    name: 'Mapa Mental',
    description: 'Mapa mental visual em formato Mermaid',
    systemPrompt:
      'Você gera mapas mentais em sintaxe Mermaid a partir de transcrições em português brasileiro.\n\nRegras estritas:\n- Retorne APENAS código Mermaid válido, sem cercas de markdown (```), sem explicações.\n- Primeira linha sempre: mindmap\n- Nó raiz no formato: root((Título Principal))\n- Use indentação de 2 espaços por nível\n- Máximo 3 níveis de profundidade\n- Texto de cada nó conciso (1-5 palavras)\n- Sem caracteres especiais nos nós (parênteses só na raiz)\n\nExemplo de saída válida:\nmindmap\n  root((Reunião Lançamento))\n    Decisões\n      Press release sexta\n      Deploy segunda\n    Responsáveis\n      Carlos comunicação\n      Ana deploy\n    Pendências\n      Alinhamento jurídico',
  },
  {
    id: 'email',
    name: 'Rascunho de email',
    description: 'Transforma a fala em email profissional',
    systemPrompt:
      'Transforme esta gravação num rascunho de email profissional em português brasileiro. Use TEXTO PURO, SEM asteriscos, SEM markdown, SEM negrito.\n\nFormato obrigatório:\n\nAssunto: [assunto do email]\n\nPrezado(a) [Destinatário],\n\n[Corpo do email organizado em parágrafos curtos]\n\nAtenciosamente,\n[Remetente]',
  },
  {
    id: 'transcript',
    name: 'Transcrição',
    description: 'Texto transcrito limpo e formatado em Markdown para exportar como .md',
    systemPrompt:
      'Você é um assistente de transcrição. Formate o texto transcrito em Markdown limpo e legível, em português brasileiro.\n\nREGRAS:\n- Corrija pontuação, maiúsculas e paragrafação natural.\n- NÃO resuma, NÃO omita conteúdo, NÃO acrescente informações.\n- Mantenha cada ideia / trecho em seu próprio parágrafo.\n- Corrija apenas erros óbvios de transcrição automática (palavras truncadas, fonemas errados).\n- Se identificar múltiplos falantes, use o formato:\n  **Falante A:** texto do falante\n  **Falante B:** texto do falante\n- Caso não identifique múltiplos falantes, use parágrafos simples sem marcadores.\n- Use `---` como separador entre seções temáticas distintas, se houver.\n\nRetorne APENAS o texto formatado, sem cabeçalhos adicionais nem comentários sobre a transcrição.',
  },
];

// Alias de retrocompatibilidade
export const PROMPT_TEMPLATES = BUILTIN_TEMPLATES;

export async function getAllTemplates(): Promise<PromptTemplate[]> {
  const custom = await getCustomTemplates();
  return [
    ...BUILTIN_TEMPLATES,
    ...custom.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? '',
      systemPrompt: c.systemPrompt,
    })),
  ];
}

export async function getTemplateById(
  id: string
): Promise<PromptTemplate | null> {
  const all = await getAllTemplates();
  return all.find((t) => t.id === id) ?? null;
}


export interface SummarizeMetadata {
  recordedAt?: string;
}

// ─── Detecção de medicamentos controlados ────────────────────────────────────
//
// Verificação por regex ANTES de chamar o LLM. Quando o médico seleciona
// "Receituário Médico" mas a transcrição contém um controlado, redirecionamos
// automaticamente para "Receituário Controle Especial". Isso é determinístico
// e não depende da interpretação do modelo.
//
// Abrange: benzodiazepínicos (C1), z-drugs (C1), pregabalina (C1),
// barbitúricos (C1), estimulantes (C3), opioides (RDC 20), talidomida (C5),
// canabidiol (C1) — nomes comerciais + genéricos + variantes fonéticas comuns.
const CONTROLLED_SUBSTANCE_REGEX = new RegExp(
  '\\b(' +
  // C1 — Benzodiazepínicos
  'rivotril|clonazepam|clonasepam|clonazepan|' +
  'frontal|alprazolam|alprasolam|alprazolan|xanax|' +
  'valium|diazepam|diasepam|diazepan|' +
  'lexotan|bromazepam|bromasepam|bromazepan|' +
  'lorax|lorazepam|lorazepan|' +
  // C1 — Z-drugs
  'stilnox|zolpidem|zolpicid|zolpiden|' +
  // C1 — Anticonvulsivantes controlados
  'lyrica|pregabalina|pregabaline|' +
  'gardenal|fenobarbital|fenobarital|' +
  'midazolam|dormire|' +
  // C3 — Estimulantes
  'ritalina|metilfenidato|metilfinidato|metilfenidado|concerta|' +
  'vyvanse|lisdexanfetamina|lisdexanfetamine|' +
  // RDC 20 — Opioides
  'tramal|tramadol|tramadal|tramodol|tramagesic|' +
  'morfina|dimorf|' +
  'fentanil|durogesic|fentanyl|' +
  'oxycontin|oxicodona|oxycodone|' +
  'buprenorfina|subutex|buprenorphine|' +
  'metadona|methadone|' +
  'codeina|codeína|codeine|' +
  // C5
  'talidomida|thalidomide|' +
  // C1 — Canabidiol
  'canabidiol|cannabidiol|cbd' +
  ')\\b',
  'i'
);

/**
 * Retorna true se a transcrição contiver nome de medicamento controlado
 * (Portaria SVS/MS 344/98 / RDC 20/2011).
 */
export function transcriptHasControlledSubstance(transcript: string): boolean {
  return CONTROLLED_SUBSTANCE_REGEX.test(transcript);
}

export async function summarizeText(
  text: string,
  templateId: string = 'summary',
  metadata?: SummarizeMetadata
): Promise<string> {
  // ── Auto-roteamento: Receituário Médico → Controle Especial ──────────────
  // Se o usuário escolheu "Receituário Médico" mas a transcrição contém um
  // medicamento controlado, usamos o template correto automaticamente.
  let effectiveTemplateId = templateId;
  if (templateId === 'medical_prescription' && transcriptHasControlledSubstance(text)) {
    effectiveTemplateId = 'medical_controlled_prescription';
  }

  const template =
    (await getTemplateById(effectiveTemplateId)) ?? BUILTIN_TEMPLATES[0];

  let userContent = `Transcrição:\n\n${text}`;
  if (metadata?.recordedAt) {
    const d = new Date(metadata.recordedAt);
    const dateStr = d.toLocaleDateString('pt-BR');
    const timeStr = d.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    userContent = `Metadados da gravação:\nData: ${dateStr}\nHora: ${timeStr}\n\n${userContent}`;
  }

  const currentModel = await getModel();
  const modelInfo = AVAILABLE_MODELS.find((m) => m.id === currentModel) ?? AVAILABLE_MODELS[0];
  const mode = await getOpenAIMode();
  const messages = [
    { role: 'system' as const, content: template.systemPrompt },
    { role: 'user' as const, content: userContent },
  ];

  // ── OpenRouter path (Grok, Kimi, GPT-4o Mini TTS, …) ─────────────────────
  if (modelInfo.provider === 'openrouter') {
    const orKey = await getOpenRouterApiKey();
    if (!orKey) {
      throw new Error(
        'Chave OpenRouter não configurada. Acesse Configurações > Modelo de IA e insira sua chave.'
      );
    }

    const response = await secureFetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${orKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'com.rafaelbrauner.voiceai',
          'X-Title': 'Voice AI Recorder',
        },
        body: JSON.stringify(
          // OpenRouter aceita max_tokens e traduz internamente, mas também
          // suporta max_completion_tokens — usamos buildChatBody para uniformidade.
          buildChatBody(modelInfo.apiModelId, messages, 0.3, 1500)
        ),
        timeoutMs: DIRECT_CHAT_TIMEOUT_MS,
        expectContentType: 'application/json',
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API ${response.status}: ${errText}`);
    }

    const json = await response.json();

    try {
      const inputTokens = json.usage?.prompt_tokens ?? 0;
      const outputTokens = json.usage?.completion_tokens ?? 0;
      // Custo OpenRouter varia por modelo — logamos 0 como placeholder
      await logApiUsage({
        operation: 'chat',
        model: modelInfo.apiModelId,
        inputTokens,
        outputTokens,
        costUSD: calculateChatCost(currentModel, inputTokens, outputTokens),
      });
    } catch (e) {
      logWarn('api_usage', e);
    }

    // Bug #11: guarda contra choices vazio ou formato inesperado
    return (json.choices?.[0]?.message?.content as string | undefined) ?? '';
  }

  // ── Proxy path (OpenAI via Supabase Edge Function) ────────────────────────
  if (mode === 'proxy') {
    const result = await chatViaProxy({
      model: currentModel,
      messages,
      temperature: 0.3,
      maxTokens: 1500,
    });
    try {
      await logApiUsage({
        operation: 'chat',
        model: currentModel,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUSD: result.costUSD,
      });
    } catch (e) {
      logWarn('api_usage', e);
    }
    return result.content;
  }

  // ── Direct OpenAI path ────────────────────────────────────────────────────
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error(
      'Sem credencial: faça login (modo seguro) ou configure uma OpenAI API key em Configurações.'
    );
  }

  const response = await secureFetch(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildChatBody(modelInfo.apiModelId, messages, 0.3, 1500)
      ),
      timeoutMs: DIRECT_CHAT_TIMEOUT_MS,
      expectContentType: 'application/json',
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${errText}`);
  }

  const json = await response.json();

  try {
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    const costUSD = calculateChatCost(currentModel, inputTokens, outputTokens);
    await logApiUsage({
      operation: 'chat',
      model: currentModel,
      inputTokens,
      outputTokens,
      costUSD,
    });
  } catch (e) {
    logWarn('api_usage', e);
  }

  return json.choices[0].message.content as string;
}

// ── Streaming (SSE) helpers ──────────────────────────────────────────────────

/**
 * Parseia um stream SSE no formato OpenAI/OpenRouter e emite cada chunk de
 * conteúdo delta como um item do generator.
 *
 * Formato esperado:
 *   data: {"choices":[{"delta":{"content":"Hello"},...}],...}
 *   data: [DONE]
 */
/**
 * True se o runtime suporta as APIs necessárias para SSE streaming
 * (ReadableStream no body da resposta + TextDecoder no Hermes).
 * Em versões antigas do Hermes/Android essas APIs podem não existir —
 * nesse caso usamos o caminho não-streaming.
 */
function isStreamingSupported(): boolean {
  try {
    return (
      typeof TextDecoder !== 'undefined' &&
      typeof ReadableStream !== 'undefined'
    );
  } catch {
    return false;
  }
}

async function* parseSSEChunks(response: Response): AsyncGenerator<string> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('STREAM_UNSUPPORTED');
  }
  const reader = body.getReader();

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta: unknown = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') yield delta;
        } catch {
          // linha malformada — ignorar
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── SummarizeMetadata (re-exported for use in streaming) ─────────────────────

/**
 * Versão streaming de summarizeText.
 *
 * Chama onChunk para cada fragmento de texto à medida que o modelo gera a
 * resposta — permite exibir o conteúdo em tempo real na UI.
 *
 * Casos de fallback (sem streaming):
 *   • Modelos reasoning (o1, o3, o4) — não suportam SSE
 *   • Modo proxy (Supabase Edge Function) — retorna JSON completo
 *
 * @returns Promise que resolve quando a resposta inteira foi recebida.
 *          O conteúdo completo é a concatenação de todos os chunks emitidos.
 */
export async function summarizeTextStream(
  text: string,
  templateId: string = 'summary',
  onChunk: (chunk: string) => void,
  metadata?: SummarizeMetadata
): Promise<void> {
  // ── Auto-roteamento: Receituário → Controle Especial ─────────────────────
  let effectiveTemplateId = templateId;
  if (templateId === 'medical_prescription' && transcriptHasControlledSubstance(text)) {
    effectiveTemplateId = 'medical_controlled_prescription';
  }

  const template =
    (await getTemplateById(effectiveTemplateId)) ?? BUILTIN_TEMPLATES[0];

  let userContent = `Transcrição:\n\n${text}`;
  if (metadata?.recordedAt) {
    const d = new Date(metadata.recordedAt);
    const dateStr = d.toLocaleDateString('pt-BR');
    const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    userContent = `Metadados da gravação:\nData: ${dateStr}\nHora: ${timeStr}\n\n${userContent}`;
  }

  const currentModel = await getModel();
  const modelInfo = AVAILABLE_MODELS.find((m) => m.id === currentModel) ?? AVAILABLE_MODELS[0];
  const messages = [
    { role: 'system' as const, content: template.systemPrompt },
    { role: 'user' as const, content: userContent },
  ];

  // ── Fallback: reasoning models não suportam streaming ────────────────────
  if (isReasoningModel(modelInfo.apiModelId)) {
    const result = await summarizeText(text, templateId, metadata);
    onChunk(result);
    return;
  }

  // ── Fallback: proxy mode → Edge Function não suporta SSE ─────────────────
  const mode = await getOpenAIMode();
  if (mode === 'proxy' && modelInfo.provider === 'openai') {
    const result = await summarizeText(text, templateId, metadata);
    onChunk(result);
    return;
  }

  // ── Fallback: runtime sem suporte a streaming (Hermes antigo) ────────────
  if (!isStreamingSupported()) {
    const result = await summarizeText(text, templateId, metadata);
    onChunk(result);
    return;
  }

  // ── Streaming: OpenRouter ou Direct OpenAI ───────────────────────────────
  let apiUrl: string;
  let authKey: string;
  const extraHeaders: Record<string, string> = {};

  if (modelInfo.provider === 'openrouter') {
    const orKey = await getOpenRouterApiKey();
    if (!orKey) {
      throw new Error(
        'Chave OpenRouter não configurada. Acesse Configurações → API Keys.'
      );
    }
    apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    authKey = orKey;
    extraHeaders['HTTP-Referer'] = 'com.rafaelbrauner.voiceai';
    extraHeaders['X-Title'] = 'Voice AI Recorder';
  } else {
    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error(
        'Sem credencial: configure a OpenAI API key em Configurações.'
      );
    }
    apiUrl = 'https://api.openai.com/v1/chat/completions';
    authKey = apiKey;
  }

  const requestBody = {
    ...buildChatBody(modelInfo.apiModelId, messages, 0.3, 1500),
    stream: true,
  };

  let emittedAny = false;
  try {
    const response = await expoFetchWithTimeout(
      apiUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authKey}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(requestBody),
      },
      DIRECT_CHAT_TIMEOUT_MS
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
    }

    for await (const chunk of parseSSEChunks(response)) {
      emittedAny = true;
      onChunk(chunk);
    }
  } catch (err) {
    // Se o streaming falhou ANTES de emitir qualquer conteúdo, tentamos o
    // caminho não-streaming — garante que o processamento funcione mesmo em
    // dispositivos/runtimes onde SSE não está disponível.
    if (!emittedAny) {
      logWarn('summarizeTextStream.fallback', err);
      const result = await summarizeText(text, templateId, metadata);
      onChunk(result);
      return;
    }
    // Conteúdo parcial já foi emitido — não dá para recomeçar sem duplicar.
    throw err;
  }

  // Logging simplificado: tokens não disponíveis no stream; custo = 0
  try {
    await logApiUsage({
      operation: 'chat',
      model: currentModel,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
    });
  } catch (e) {
    logWarn('api_usage', e);
  }
}

export const getTranscript = (fileName: string) =>
  getField(fileName, 'transcript');
export const saveTranscript = (fileName: string, text: string) =>
  setField(fileName, 'transcript', text);
export const deleteTranscript = (fileName: string) =>
  clearField(fileName, 'transcript');

export const getSummary = (fileName: string) =>
  getField(fileName, 'summary');
export const saveSummary = (fileName: string, text: string) =>
  setField(fileName, 'summary', text);
export const deleteSummary = (fileName: string) =>
  clearField(fileName, 'summary');

export const getSummaryTemplate = (fileName: string) =>
  getField(fileName, 'templateId');
export const saveSummaryTemplate = (fileName: string, id: string) =>
  setField(fileName, 'templateId', id);
export const deleteSummaryTemplate = (fileName: string) =>
  clearField(fileName, 'templateId');
