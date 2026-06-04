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
import { Alert } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { transcribeAudio, summarizeText, summarizeTextStream } from './openai';
import { setField, extractPatientName } from './db';
import {
  enqueueTranscription,
  dequeueTranscription,
  isNetworkError,
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

  /** Inicia transcrição em background. Idempotente: ignora se já em andamento. */
  startTranscription: (item: TranscriptionItem) => void;
  /** Inicia processamento IA em background. Idempotente: ignora se já em andamento. */
  startProcessing: (item: ProcessingItem, templateId: string) => void;

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

    set((s) => ({
      transcribingFiles: new Set([...s.transcribingFiles, item.fileName]),
    }));

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

        await setField(item.fileName, 'transcript', text);
        await dequeueTranscription(item.fileName);

        // Bug #8: deletar áudio PHI após transcrição bem-sucedida.
        // O texto já está cifrado no SQLite — o .m4a bruto não é mais necessário
        // e não deve permanecer em disco sem proteção.
        try {
          const info = await FileSystem.getInfoAsync(item.uri);
          if (info.exists) {
            await FileSystem.deleteAsync(item.uri, { idempotent: true });
          }
        } catch (deleteErr) {
          // Falha silenciosa: não bloquear o fluxo por erro de limpeza
          logWarn('processing-store.deleteAudio', deleteErr);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isNetworkError(err)) {
          await enqueueTranscription({
            fileName: item.fileName,
            uri: item.uri,
            createdAt: item.createdAt,
            lastError: msg,
          }).catch(() => {});
          Alert.alert(
            'Sem conexão',
            'Sua gravação foi salva na fila offline. Vamos tentar transcrever automaticamente quando a conexão voltar.'
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
