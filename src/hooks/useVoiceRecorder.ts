import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  AudioModule,
  setAudioModeAsync,
  RecordingInput,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { setField } from '../services/db';
import { logError, logWarn } from '../services/log';

const MIN_RECORDING_DURATION_MS = 1000;
const MIN_AUDIO_BYTES_PER_SECOND = 4000;
const AUDIO_SIGNAL_METERING_DB = -90;
// Otimização de velocidade de transcrição:
// O Whisper reamostra TODO áudio para 16 kHz mono internamente, então gravar em
// 44,1 kHz / 64 kbps estéreo-preset gera bytes que são descartados no servidor.
// Reduzir para 22,05 kHz mono @ 32 kbps corta o tamanho do arquivo ~pela metade
// (ex.: 30 min: ~14 MB → ~7 MB), acelerando upload e processamento, sem perda
// perceptível de qualidade para voz/ditado clínico. AAC a 32 kbps mono é
// transparente para fala; a reprodução continua nítida.
const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
  numberOfChannels: 1,
  bitRate: 32000,
  ios: {
    ...RecordingPresets.HIGH_QUALITY.ios,
    sampleRate: 22050,
  },
  android: {
    ...RecordingPresets.HIGH_QUALITY.android,
    sampleRate: 22050,
  },
};

export const useVoiceRecorder = () => {
  const recorder = useAudioRecorder(RECORDING_OPTIONS);

  // Poll at 95 ms — drives both duration display and waveform animation.
  const recorderState = useAudioRecorderState(recorder, 95);

  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false); // Bug #7: evita duplo-toque
  const [waveformData, setWaveformData] = useState<number[]>([]);

  const currentInputRef = useRef<RecordingInput | null>(null);
  const hasAudioSignalRef = useRef(false);

  // Keep the latest recorderState available to the interval (avoid stale closures
  // AND avoid relying on React reference-change semantics for the waveform tick).
  const recorderStateRef = useRef(recorderState);
  recorderStateRef.current = recorderState;

  const duration = isRecording || isPaused
    ? Math.floor((recorderState.durationMillis ?? 0) / 1000)
    : 0;

  // Request permission + configure audio mode on mount.
  useEffect(() => {
    (async () => {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) logWarn('recorder', 'Permissão de microfone negada');
      try {
        await setAudioModeAsync({
          allowsRecording: true,
          ...(Platform.OS === 'ios' ? { playsInSilentMode: true } : {}),
          shouldPlayInBackground: true,
        });
      } catch (e) {
        logWarn('audio', e);
      }
    })();
  }, []);

  // ─── Waveform animation ─────────────────────────────────────────────────────
  // Self-contained setInterval at 95 ms, started only while actively recording.
  // Reads the latest metering value via recorderStateRef so we never read a
  // stale closure and never depend on expo-audio updating the state-object
  // reference on every poll (which it doesn't always do).
  useEffect(() => {
    if (!isRecording || isPaused) return;

    const id = setInterval(() => {
      const status = recorderStateRef.current;
      const metering = status?.metering;
      let value: number;

      if (metering !== undefined && metering !== null) {
        // Real metering: normalize −160 dB → 0 … 0 dB → 1.
        // Floor at 0.12 so bars are always clearly visible even in silence.
        if (metering > AUDIO_SIGNAL_METERING_DB) {
          hasAudioSignalRef.current = true;
        }
        const raw = Math.max(0, (metering + 160) / 160);
        value = raw < 0.12 ? 0.12 + Math.random() * 0.08 : raw;
      } else {
        // No metering available (simulator / no mic input) — synthetic sine.
        // Range [0.25, 0.85] spans all three amplitude zones so all bar
        // colours (valley / mid / peak) appear during the animation.
        const t = Date.now() / 400;
        value = 0.25 + Math.abs(Math.sin(t * 2.5 + Math.random() * 1.2)) * 0.60;
      }

      setWaveformData((prev) => [...prev, value].slice(-50));
    }, 95);

    return () => clearInterval(id);
  }, [isRecording, isPaused]);

  const ensureRecordingReady = useCallback(async () => {
    const currentPermission = await AudioModule.getRecordingPermissionsAsync();
    const permission = currentPermission.granted
      ? currentPermission
      : await AudioModule.requestRecordingPermissionsAsync();

    if (!permission.granted) {
      Alert.alert(
        'Permissão necessária',
        'Ative o acesso ao microfone para iniciar a gravação.'
      );
      return false;
    }

    await setAudioModeAsync({
      allowsRecording: true,
      ...(Platform.OS === 'ios' ? {
        playsInSilentMode: true,
        allowsBackgroundRecording: true,
      } : {}),
      shouldPlayInBackground: true,
    });

    return true;
  }, []);

  const describeCurrentInput = () => {
    const input = currentInputRef.current;
    if (!input) return 'entrada não informada';
    return `${input.name}${input.type ? ` (${input.type})` : ''}`;
  };

  const getSimulatorInputHint = () => {
    if (Platform.OS !== 'ios') return '';
    return '\n\nNo Simulator, use I/O > Audio Input > System (...) em vez de uma entrada direta sem sinal.';
  };

  const startRecording = async () => {
    // Bug #7: impede duplo-toque durante transição start/stop
    if (isTransitioning) return;
    setIsTransitioning(true);
    try {
      const ready = await ensureRecordingReady();
      if (!ready) return;

      await recorder.prepareToRecordAsync();
      try {
        currentInputRef.current = await recorder.getCurrentInput();
      } catch (inputErr) {
        currentInputRef.current = null;
        logWarn('recorder', inputErr);
      }
      recorder.record();

      // Activate keep awake during recording to prevent screen lock
      try {
        await activateKeepAwakeAsync();
      } catch (err) {
        logWarn('recorder', `Failed to activate keep awake: ${err}`);
      }

      hasAudioSignalRef.current = false;
      setWaveformData([]);
      setIsRecording(true);
      setIsPaused(false);
    } catch (err: any) {
      setIsRecording(false);
      setIsPaused(false);
      logError('recorder', err);
      const detail = err?.message ? `\n\nDetalhe: ${err.message}` : '';
      const hint = Platform.OS === 'ios'
        ? 'Verifique se o microfone está disponível. No Simulator, confira em I/O > Audio Input se há uma entrada selecionada.'
        : 'Verifique se as permissões de microfone foram concedidas nas configurações do dispositivo.';
      Alert.alert('Não foi possível iniciar a gravação', hint + detail);
    } finally {
      setIsTransitioning(false);
    }
  };

  const pauseRecording = () => {
    if (!isRecording || isPaused) return;
    try {
      recorder.pause();
      setIsPaused(true);
    } catch (err) {
      logError('recorder', err);
    }
  };

  const resumeRecording = () => {
    if (!isRecording || !isPaused) return;
    try {
      recorder.record();
      setIsPaused(false);
    } catch (err) {
      logError('recorder', err);
    }
  };

  // Discard the current recording WITHOUT saving it.
  // Stops the recorder, deletes the temp file, resets state.
  const discardRecording = async () => {
    if (!isRecording && !isPaused) return;
    // Bug #7: impede duplo-toque durante transição
    if (isTransitioning) return;
    setIsTransitioning(true);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (uri) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      }
    } catch (err: any) {
      logWarn('recorder', err);
    } finally {
      // Deactivate keep awake when discarding
      try {
        await deactivateKeepAwake();
      } catch (err) {
        logWarn('recorder', `Failed to deactivate keep awake: ${err}`);
      }
      setIsRecording(false);
      setIsPaused(false);
      setWaveformData([]);
      hasAudioSignalRef.current = false;
      setIsTransitioning(false);
    }
  };

  const stopRecording = async () => {
    // Bug #7: impede duplo-toque durante transição
    if (isTransitioning) return;
    setIsTransitioning(true);
    try {
      const status = recorder.getStatus();
      await recorder.stop();
      const uri = recorder.uri;
      const durationMillis = status?.durationMillis ?? duration * 1000;

      // Bug #10: uri null após stop (corrida ou estado inválido)
      if (!uri) {
        logWarn('recorder', 'stopRecording: recorder.uri é null após stop — gravação perdida');
        Alert.alert(
          'Gravação não salva',
          'Ocorreu um erro inesperado ao finalizar a gravação. Por favor, tente gravar novamente.'
        );
        return;
      }

      if (durationMillis < MIN_RECORDING_DURATION_MS) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
        Alert.alert(
          'Gravação muito curta',
          'Grave pelo menos 1 segundo de áudio antes de transcrever.'
        );
        return;
      }
      const fileName = `recording_${Date.now()}.m4a`;
      const newUri = `${FileSystem.documentDirectory}${fileName}`;

      try {
        await FileSystem.moveAsync({ from: uri, to: newUri });
      } catch (moveErr: any) {
        logError('recorder', moveErr);
        Alert.alert(
          'Gravação não salva',
          'Houve um erro ao salvar o arquivo de áudio no armazenamento. Tente gravar novamente.\n\nDetalhe: ' +
            (moveErr?.message ?? String(moveErr))
        );
        return;
      }

      let fileBytes = 0;
      try {
        const info = await FileSystem.getInfoAsync(newUri);
        fileBytes =
          info.exists && 'size' in info && typeof info.size === 'number'
            ? info.size
            : 0;
      } catch (infoErr) {
        logWarn('recorder', infoErr);
      }

      const seconds = Math.max(1, durationMillis / 1000);

      // Persist duration so it can be shown in the recordings list
      try {
        await setField(fileName, 'durationSecs', String(Math.round(seconds)));
      } catch {
        // Non-critical — don't block the recording flow
      }

      if (fileBytes > 0 && fileBytes / seconds < MIN_AUDIO_BYTES_PER_SECOND) {
        await FileSystem.deleteAsync(newUri, { idempotent: true });
        const inputDescription = describeCurrentInput();
        const signalDescription = hasAudioSignalRef.current
          ? 'houve sinal no medidor, mas o arquivo final ficou inválido'
          : 'não houve sinal detectável no medidor';
        Alert.alert(
          'Áudio não capturado',
          `A gravação foi iniciada, mas o arquivo salvo não contém áudio válido.\n\nEntrada atual: ${inputDescription}.\nStatus: ${signalDescription}.${getSimulatorInputHint()}`
        );
      }
    } catch (err: any) {
      logError('recorder', err);
      Alert.alert(
        'Erro ao finalizar gravação',
        'Não foi possível salvar a gravação. O arquivo pode ter sido perdido.\n\nDetalhe: ' +
          (err?.message ?? String(err))
      );
    } finally {
      // Deactivate keep awake when recording stops
      try {
        await deactivateKeepAwake();
      } catch (err) {
        logWarn('recorder', `Failed to deactivate keep awake: ${err}`);
      }
      setIsRecording(false);
      setIsPaused(false);
      setIsTransitioning(false);
    }
  };

  return {
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    discardRecording,
    isRecording,
    isPaused,
    isTransitioning,
    duration,
    waveformData,
  };
};
