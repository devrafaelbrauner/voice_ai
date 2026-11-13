/**
 * processing-store.ts — Store global de transcrição e processamento IA.
 *
 * Por que existe?
 * As operações de transcrição (Whisper) e processamento (GPT) podem demorar
 * 10–90 segundos. Se o médico navegar para outra tela enquanto aguarda, a
 * versão anterior baseada em useState do componente `recordings.tsx` abandonava
 * o resultado — o estado era descartado junto com o componente desmontado.
 *
 * Esta store Zustand vive fora do ciclo de vida de qualquer componente. As
 * Promises continuam rodando e, ao terminar, salvam o resultado no banco local
 * via setField() e incrementam `completionCount`. O componente de gravações
 * assiste `completionCount` e recarrega a lista do banco quando notificado.
 *
 * Fluxo:
 *   1. Médico toca "Transcrever" → startTranscription() adiciona o fileName
 *      em `transcribingFiles` e dispara a Promise em background (fire-and-forget).
 *   2. Médico navega para configurações, volta ou qualquer outra coisa.
 *   3. Promise resolve → setField() grava no SQLite → completionCount++.
 *   4. Se recordings.tsx ainda estiver montado, useEffect([completionCount])
 *      detecta a mudança e chama loadRecordings(), atualizando a UI.
 *   5. Se o componente tiver sido desmontado (ex.: médico pressionou voltar),
 *      o dado já está no banco; na próxima vez que abrir a tela,
 *      useFocusEffect carrega os dados frescos automaticamente.
 */

import { create } from 'zustand';
import { Alert, AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  transcribeAudio,
  summarizeText,
  summarizeTextStream,
  isTranscriptionError,
  type TranscriptionErrorKind,
} from './openai';
import { setField, extractPatientName, getPendingDeletions } from './db';
import {
  enqueueTranscription,
  dequeueTranscription,
  getQueueCount,
  isRetryableTranscriptionError,
  processQueue,
  type DrainStopReason,
} from './transcription-queue';
import { logError, logWarn } from './log';

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface TranscriptionItem {
  fileName: string;
  uri: string;
  createdAt: string;
  localFileExists: boolean;
}

export interface ProcessingItem {
  fileName: string;
  transcript: string;
  createdAt: string;
}

/** Última falha de transcrição de uma gravação (por fileName), para a UI. */
export interface TranscriptionFailure {
  /**
   * 'unknown' = erro que não é TranscriptionError (ex.: falha ao gravar no banco).
   * 'no_speech' = o áudio não tem fala reconhecível (nada foi gravado; áudio mantido).
   */
  kind: TranscriptionErrorKind | 'unknown' | 'no_speech';
  message: string;
  /** True quando a gravação ficou na fila offline para nova tentativa automática. */
  queued: boolean;
}

/** Resultado de uma drenagem da fila offline (único caminho de drain do app). */
export interface DrainResult {
  /** Transcrições gravadas no banco nesta drenagem. */
  processed: number;
  /** Itens que falharam ou não tinham fala (detalhe em `errors`). */
  failed: number;
  /** Itens ainda pendentes na fila (exclui os com falha permanente). */
  remaining: number;
  /**
   * Por que parou antes do fim (ou nem começou): 'network' | 'rate_limit' |
   * 'invalid_key' | 'forbidden' | 'quota' | 'already_running'.
   */
  stoppedBy?: DrainStopReason | 'already_running';
  /**
   * Falha por fileName. `kind`: kind do TranscriptionError, 'unknown' ou
   * 'no_speech'. A chave '*' = erro da própria drenagem (não de um item).
   */
  errors: Record<string, { kind: string; message: string }>;
}

export interface DrainOptions {
  /** Ação explícita do usuário: ignora o intervalo mínimo, o cooldown dos itens e a pausa por erro de configuração. */
  ignoreCooldown?: boolean;
}

/** Intervalo mínimo entre drenagens automáticas da fila (anti re-drain, C3-05). */
const MIN_DRAIN_INTERVAL_MS = 5_000;

let lastDrainAt = 0;
let drainInFlight = false;

/**
 * A gravação ainda existe? Ela some se o usuário a exclui enquanto a
 * transcrição está em voo: o áudio é apagado e a exclusão deixa tombstone.
 * Gravar o texto nesse caso ressuscitaria uma linha-fantasma (LGPD). Falha ao
 * checar lança: o item fica na fila e é tentado de novo, nada se perde.
 */
async function recordingStillExists(fileName: string, uri: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return false;
  const pending = await getPendingDeletions();
  return !pending.some((p) => p.kind === 'recording' && p.key === fileName);
}

/**
 * Grava a transcrição, tira o item da fila e apaga o áudio bruto.
 * Bug #8: o .m4a (PHI) não deve permanecer em disco sem proteção depois que o
 * texto está cifrado no SQLite. Só roda após sucesso confirmado — em qualquer
 * falha o áudio permanece. Se a gravação foi excluída durante o voo, não grava
 * nada ('discarded') e só tira o item da fila.
 */
async function saveTranscriptAndCleanup(
  fileName: string,
  uri: string,
  text: string
): Promise<'saved' | 'discarded'> {
  if (!(await recordingStillExists(fileName, uri))) {
    logWarn('processing-store.discard', 'recording deleted during transcription; transcript discarded');
    await dequeueTranscription(fileName);
    return 'discarded';
  }
  await setField(fileName, 'transcript', text);
  await dequeueTranscription(fileName);
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  } catch (deleteErr) {
    // Falha silenciosa: não bloquear o fluxo por erro de limpeza
    logWarn('processing-store.deleteAudio', deleteErr);
  }
  return 'saved';
}

interface ProcessingState {
  /** FileNames de gravações sendo transcritas no momento. */
  transcribingFiles: ReadonlySet<string>;
  /** FileNames de gravações sendo processadas com IA no momento. */
  processingFiles: ReadonlySet<string>;
  /**
   * Conteúdo em tempo real gerado pelo modelo enquanto processa.
   * Chave: fileName. Valor: texto acumulado até o momento.
   * Removido quando o processamento termina (sucesso ou falha).
   */
  streamingContent: Readonly<Record<string, string>>;
  /**
   * Contador incrementado sempre que uma operação termina (sucesso ou falha).
   * Componentes assistem a este valor para saber quando recarregar a lista.
   */
  completionCount: number;
  /** Última falha de transcrição por fileName. Limpa ao reiniciar ou ao concluir. */
  transcriptionErrors: Readonly<Record<string, TranscriptionFailure>>;

  /** Inicia transcrição em background. Idempotente: ignora se já em andamento. */
  startTranscription: (item: TranscriptionItem) => void;
  /** Inicia processamento IA em background. Idempotente: ignora se já em andamento. */
  startProcessing: (item: ProcessingItem, templateId: string) => void;
  /**
   * Drena a fila offline (itens por fileName, respeitando cooldown). ÚNICO
   * caminho de drain: a tela de Gravações chama este método. Não reentrante
   * ('already_running'); sem `ignoreCooldown` respeita o intervalo mínimo.
   * Nunca lança nem exibe UI: quem chama mostra o DrainResult. Chamada
   * automática (sem UI) quando o app volta ao primeiro plano.
   */
  drainOfflineQueue: (opts?: DrainOptions) => Promise<DrainResult>;

  /** Helper para verificar estado sem re-renderizar toda vez. */
  isTranscribing: (fileName: string) => boolean;
  isProcessing: (fileName: string) => boolean;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useProcessingStore = create<ProcessingState>((set, get) => ({
  transcribingFiles: new Set<string>(),
  processingFiles: new Set<string>(),
  streamingContent: {},
  completionCount: 0,
  transcriptionErrors: {},

  isTranscribing: (fileName) => get().transcribingFiles.has(fileName),
  isProcessing:   (fileName) => get().processingFiles.has(fileName),

  // ── Transcrição ─────────────────────────────────────────────────────────────

  startTranscription(item) {
    if (!item.localFileExists) {
      Alert.alert(
        'Áudio indisponível',
        'Esta gravação foi sincronizada apenas com metadados. O arquivo de áudio não está neste dispositivo.'
      );
      return;
    }
    if (get().transcribingFiles.has(item.fileName)) return; // já em andamento

    set((s) => {
      const { [item.fileName]: _cleared, ...restErrors } = s.transcriptionErrors;
      return {
        transcribingFiles: new Set([...s.transcribingFiles, item.fileName]),
        transcriptionErrors: restErrors,
      };
    });

    // Fire-and-forget — roda independente do componente que disparou
    void (async () => {
      try {
        const text = await transcribeAudio(item.uri);

        // Bug #9: transcrição vazia (áudio silencioso ou sem fala detectada)
        if (!text || text.trim().length === 0) {
          Alert.alert(
            'Nenhuma fala detectada',
            'O áudio não contém fala reconhecível. Verifique o microfone e tente novamente.'
          );
          return;
        }

        // 'discarded' = a gravação foi excluída durante a transcrição: nada a mostrar.
        await saveTranscriptAndCleanup(item.fileName, item.uri, text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        let queued = false;
        if (isRetryableTranscriptionError(err)) {
          try {
            await enqueueTranscription({
              fileName: item.fileName,
              uri: item.uri,
              createdAt: item.createdAt,
              error: err,
            });
            queued = true;
          } catch (queueErr) {
            logWarn('processing-store.enqueue', queueErr);
          }
        }
        set((s) => ({
          transcriptionErrors: {
            ...s.transcriptionErrors,
            [item.fileName]: {
              kind: isTranscriptionError(err) ? err.kind : 'unknown',
              message: msg,
              queued,
            },
          },
        }));
        if (queued && isTranscriptionError(err) && err.kind === 'network') {
          Alert.alert(
            'Sem conexão',
            'Sua gravação foi salva na fila offline. Vamos tentar transcrever automaticamente quando a conexão voltar.'
          );
        } else if (queued) {
          Alert.alert(
            'Transcrição adiada',
            `${msg}\n\nSua gravação foi salva na fila e será tentada novamente automaticamente.`
          );
        } else {
          logError('processing-store.transcribe', err);
          Alert.alert('Erro na transcrição', msg);
        }
      } finally {
        set((s) => ({
          transcribingFiles: new Set(
            [...s.transcribingFiles].filter((f) => f !== item.fileName)
          ),
          completionCount: s.completionCount + 1,
        }));
      }
    })();
  },

  // ── Fila offline ────────────────────────────────────────────────────────────

  async drainOfflineQueue(opts = {}) {
    const result: DrainResult = { processed: 0, failed: 0, remaining: 0, errors: {} };
    const pendingCount = () => getQueueCount().catch(() => 0);

    if (drainInFlight) {
      return { ...result, remaining: await pendingCount(), stoppedBy: 'already_running' };
    }
    if (!opts.ignoreCooldown && Date.now() - lastDrainAt < MIN_DRAIN_INTERVAL_MS) {
      return { ...result, remaining: await pendingCount() };
    }
    drainInFlight = true;
    try {
      // Falha por item: reflete na UI (transcriptionErrors) e no resultado. Inclui
      // invalid_key/forbidden/quota, que são de configuração e não gastam tentativa.
      const recordFailure = (fileName: string, err: unknown) => {
        const kind = isTranscriptionError(err) ? err.kind : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        result.errors[fileName] = { kind, message };
        set((s) => ({
          transcriptionErrors: { ...s.transcriptionErrors, [fileName]: { kind, message, queued: true } },
        }));
      };
      const clearFailure = (fileName: string) =>
        set((s) => {
          const { [fileName]: _cleared, ...restErrors } = s.transcriptionErrors;
          return { transcriptionErrors: restErrors };
        });
      let noSpeech = 0;
      let discarded = 0;

      const summary = await processQueue(
        async (uri, queued) => {
          // Marca a gravação como "transcrevendo" enquanto a fila trabalha nela.
          set((s) => ({ transcribingFiles: new Set([...s.transcribingFiles, queued.fileName]) }));
          try {
            return { text: await transcribeAudio(uri) };
          } finally {
            set((s) => ({
              transcribingFiles: new Set([...s.transcribingFiles].filter((f) => f !== queued.fileName)),
            }));
          }
        },
        async (queued, text) => {
          if (!text || text.trim().length === 0) {
            // "Sem fala": nunca grava ''. O item sai da fila (a cadeia já tentou
            // todos os passos) e o áudio fica para o usuário ouvir/regravar.
            const message = 'Nenhuma fala detectada no áudio.';
            result.errors[queued.fileName] = { kind: 'no_speech', message };
            set((s) => ({
              transcriptionErrors: {
                ...s.transcriptionErrors,
                [queued.fileName]: { kind: 'no_speech', message, queued: false },
              },
            }));
            noSpeech++;
            return;
          }
          const saved = await saveTranscriptAndCleanup(queued.fileName, queued.uri, text);
          clearFailure(queued.fileName);
          if (saved === 'saved') result.processed++;
          else discarded++;
        },
        {
          ignoreCooldown: opts.ignoreCooldown,
          // Gravação que o usuário está transcrevendo à mão não entra na fila agora.
          skip: (queued) => get().transcribingFiles.has(queued.fileName),
          onItemError: (queued, err) => recordFailure(queued.fileName, err),
        }
      );
      result.failed = summary.failed + summary.permanentlyFailed + noSpeech;
      result.remaining = summary.remaining;
      result.stoppedBy = summary.alreadyRunning ? 'already_running' : summary.stoppedBy;
      if (result.processed > 0 || result.failed > 0 || discarded > 0) {
        set((s) => ({ completionCount: s.completionCount + 1 }));
      }
    } catch (err) {
      logWarn('processing-store.drain', err);
      result.errors['*'] = {
        kind: isTranscriptionError(err) ? err.kind : 'unknown',
        message: err instanceof Error ? err.message : String(err),
      };
      result.remaining = await pendingCount();
    } finally {
      drainInFlight = false;
      lastDrainAt = Date.now();
    }
    return result;
  },

  // ── Processamento IA (streaming) ────────────────────────────────────────────

  startProcessing(item, templateId) {
    if (get().processingFiles.has(item.fileName)) return; // já em andamento

    set((s) => ({
      processingFiles: new Set([...s.processingFiles, item.fileName]),
      // Inicializa entrada de streaming com string vazia
      streamingContent: { ...s.streamingContent, [item.fileName]: '' },
    }));

    void (async () => {
      let accumulated = '';
      try {
        // summarizeTextStream emite chunks em tempo real.
        // Para modelos sem suporte a streaming (proxy / reasoning), emite o
        // texto completo num único chunk — a UI se comporta da mesma forma.
        await summarizeTextStream(
          item.transcript,
          templateId,
          (chunk) => {
            accumulated += chunk;
            set((s) => ({
              streamingContent: {
                ...s.streamingContent,
                [item.fileName]: accumulated,
              },
            }));
          },
          { recordedAt: item.createdAt }
        );

        if (!accumulated.trim()) {
          throw new Error('O modelo retornou uma resposta vazia. Tente novamente.');
        }

        await setField(item.fileName, 'summary', accumulated);
        await setField(item.fileName, 'templateId', templateId);
        const patientName = extractPatientName(accumulated);
        if (patientName) {
          await setField(item.fileName, 'patientName', patientName);
        }
      } catch (err: unknown) {
        logError('processing-store.process', err);
        Alert.alert(
          'Erro no processamento',
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        set((s) => {
          // Remove a entrada de streaming independentemente do resultado
          const { [item.fileName]: _removed, ...restStreaming } = s.streamingContent;
          return {
            processingFiles: new Set(
              [...s.processingFiles].filter((f) => f !== item.fileName)
            ),
            streamingContent: restStreaming,
            completionCount: s.completionCount + 1,
          };
        });
      }
    })();
  },
}));

// Drena a fila offline quando o app volta ao primeiro plano. Registrado uma
// vez (nível de módulo, fora de qualquer componente): a fila não depende da
// tela estar focada, e drainOfflineQueue é não reentrante e tem intervalo
// mínimo, então eventos 'active' repetidos não geram laço de re-drain.
AppState.addEventListener('change', (state) => {
  if (state === 'active') void useProcessingStore.getState().drainOfflineQueue();
});
