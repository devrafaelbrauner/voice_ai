import { useEffect, useRef } from 'react';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { RecordButton } from '../components/RecordButton';
import { WaveformLive } from '../components/WaveformLive';
import { GlassBackground } from '../components/GlassBackground';
import { VoiceAILogo } from '../components/VoiceAILogo';
import { Text, YStack, XStack } from 'tamagui';
import {
  List,
  Settings as SettingsIcon,
  Pause,
  Play,
  Users,
  BarChart3,
  Trash2,
} from 'lucide-react-native';
import { Link, useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { Alert, Linking, Pressable } from 'react-native';
import { useColors } from '../context/ThemeContext';
import { useThemeStore } from '../hooks/useTheme';
import type { ColorPalette } from '../constants/theme';
import { glass } from '../utils/glass';

const IconButton = ({
  href,
  c,
  isDark,
  children,
  accessibilityLabel,
}: {
  // Bug #13: usar tipo correto do expo-router em vez de `href as any`
  href: Href;
  c: ColorPalette;
  isDark: boolean;
  children: React.ReactNode;
  accessibilityLabel: string;
}) => (
  <Link href={href} asChild>
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel}
    >
      <XStack
        style={glass(0.55, 16, isDark)}
        w={42}
        h={42}
        borderRadius={21}
        alignItems="center"
        justifyContent="center"
      >
        {children}
      </XStack>
    </Pressable>
  </Link>
);

export default function RecordScreen() {
  const c = useColors();
  const isDark = useThemeStore((state) => state.isDark);
  const router = useRouter();
  const {
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
  } = useVoiceRecorder();

  const confirmDiscard = () => {
    Alert.alert(
      'Descartar gravação',
      'A gravação atual será apagada permanentemente. Deseja continuar?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Descartar',
          style: 'destructive',
          onPress: () => { discardRecording(); },
        },
      ]
    );
  };

  // Keep a stable ref to startRecording so the Linking listener below doesn't
  // capture a stale closure and re-registers every render.
  const startRecordingRef = useRef(startRecording);
  useEffect(() => { startRecordingRef.current = startRecording; }, [startRecording]);

  // Handle iOS Home Screen Quick Actions (and any other deep links)
  useEffect(() => {
    // Bug #12: armazenar ID do setTimeout para cancelar no unmount
    let deepLinkTimerId: ReturnType<typeof setTimeout> | null = null;

    const handleUrl = ({ url }: { url: string }) => {
      if (url === 'voiceairecorder://record') {
        // Small delay so the screen is fully mounted before starting
        deepLinkTimerId = setTimeout(() => startRecordingRef.current(), 300);
      } else if (url === 'voiceairecorder://recordings') {
        router.push('/recordings');
      }
    };

    // App was already running — quick action tapped while in background
    const sub = Linking.addEventListener('url', handleUrl);

    // App was cold-launched via quick action
    Linking.getInitialURL().then((url) => {
      if (!url) return;
      handleUrl({ url });
    });

    return () => {
      sub.remove();
      // Bug #12: cancelar timer pendente ao desmontar para evitar side-effect em componente desmontado
      if (deepLinkTimerId !== null) clearTimeout(deepLinkTimerId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Use maximum-contrast text color so the timer is always legible.
  // c.text = G[900]/#212529 in light mode, G[100]/#f8f9fa in dark mode.
  const timerColor = isPaused ? c.secondary : c.text;

  return (
    <GlassBackground>
      <YStack f={1} p="$6" alignItems="center" justifyContent="center" gap="$6">
        {/* Header: Logo (left) + IconButtons (right) — both glass */}
        <XStack
          position="absolute"
          top={60}
          left={20}
          right={20}
          alignItems="center"
          justifyContent="space-between"
        >
          {/* Logo — decorativo, sem ação */}
          <XStack
            style={glass(0.48, 24, isDark)}
            px="$3"
            py="$2"
            borderRadius="$4"
            alignItems="center"
            gap="$2"
          >
            <VoiceAILogo size={26} />
            <Text
              color={c.primaryDeep}
              fontWeight="800"
              fontSize={16}
              fontFamily="serif"
            >
              VoiceAI
            </Text>
          </XStack>

          <XStack gap="$2">
            <IconButton href="/stats" c={c} isDark={isDark} accessibilityLabel="Estatísticas">
              <BarChart3 size={20} color={c.secondary} />
            </IconButton>
            <IconButton href="/patients" c={c} isDark={isDark} accessibilityLabel="Pacientes">
              <Users size={20} color={c.primary} />
            </IconButton>
            <IconButton href="/recordings" c={c} isDark={isDark} accessibilityLabel="Minhas gravações">
              <List size={20} color={c.primary} />
            </IconButton>
            <IconButton href="/settings" c={c} isDark={isDark} accessibilityLabel="Configurações">
              <SettingsIcon size={20} color={c.textMuted} />
            </IconButton>
          </XStack>
        </XStack>

        {/* Timer — Lora display font per handoff */}
        <YStack alignItems="center" gap="$2" marginTop={60}>
          <Text
            fontSize={56}
            fontWeight="800"
            color={timerColor}
            fontFamily="$display"
            letterSpacing={-2}
            opacity={!isRecording && !isPaused ? 0.45 : 1}
          >
            {formatTime(duration)}
          </Text>
          {isPaused && (
            <XStack
              style={glass(0.55, 16, isDark)}
              paddingHorizontal="$3"
              paddingVertical="$1"
              borderRadius={999}
            >
              <Text
                color={c.secondary}
                fontSize={9}
                fontWeight="700"
                letterSpacing={2}
              >
                PAUSADO
              </Text>
            </XStack>
          )}
          {isRecording && !isPaused && (
            <XStack
              backgroundColor="rgba(192,57,43,0.10)"
              paddingHorizontal="$3"
              paddingVertical="$1"
              borderRadius={999}
              borderWidth={1}
              borderColor="rgba(192,57,43,0.28)"
            >
              <Text
                color="#c0392b"
                fontSize={9}
                fontWeight="700"
                letterSpacing={2}
              >
                ● GRAVANDO
              </Text>
            </XStack>
          )}
        </YStack>

        <WaveformLive data={waveformData} />

        <RecordButton
          isRecording={isRecording}
          isPaused={isPaused}
          isTransitioning={isTransitioning}
          onPress={isRecording ? stopRecording : startRecording}
        />

        {isRecording && (
          <XStack gap="$3" alignItems="center">
            <Pressable
              onPress={isPaused ? resumeRecording : pauseRecording}
              accessibilityRole="button"
              accessibilityLabel={isPaused ? 'Retomar gravação' : 'Pausar gravação'}
              accessibilityHint={isPaused ? 'Retoma a gravação pausada' : 'Pausa temporariamente a gravação'}
            >
              <XStack
                bg={isPaused ? 'rgba(52,58,64,0.70)' : '#343a40'}
                paddingHorizontal={22}
                paddingVertical={8}
                borderRadius={999}
                alignItems="center"
                gap="$2"
              >
                {isPaused ? (
                  <Play size={14} color="white" />
                ) : (
                  <Pause size={14} color="white" />
                )}
                <Text color="white" fontWeight="700" fontSize={12} letterSpacing={1}>
                  {isPaused ? 'RETOMAR' : 'PAUSAR'}
                </Text>
              </XStack>
            </Pressable>

            {isPaused && (
              <Pressable
                onPress={confirmDiscard}
                accessibilityRole="button"
                accessibilityLabel="Descartar gravação"
                accessibilityHint="Descarta e apaga permanentemente a gravação atual"
              >
                <XStack
                  bg="rgba(192,57,43,0.10)"
                  borderWidth={1}
                  borderColor="#c0392b"
                  paddingHorizontal={18}
                  paddingVertical={8}
                  borderRadius={999}
                  alignItems="center"
                  gap="$2"
                >
                  <Trash2 size={14} color="#c0392b" />
                  <Text color="#c0392b" fontWeight="700" fontSize={12} letterSpacing={1}>
                    DESCARTAR
                  </Text>
                </XStack>
              </Pressable>
            )}
          </XStack>
        )}
      </YStack>
    </GlassBackground>
  );
}
