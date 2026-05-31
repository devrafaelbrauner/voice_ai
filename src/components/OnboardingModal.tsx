/**
 * OnboardingModal — shown once after LGPD consent on first app launch.
 *
 * 4 slides:
 *   1. Boas-vindas
 *   2. Como gravar
 *   3. Templates de IA
 *   4. Conta / API key
 *
 * State is persisted in AsyncStorage so it never appears again once dismissed.
 */
import React, { useEffect, useState, useRef } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  Animated,
  Dimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from 'tamagui';
import { useRouter } from 'expo-router';
import {
  Mic,
  Sparkles,
  ShieldCheck,
  BookOpen,
  ChevronRight,
  X,
} from 'lucide-react-native';
import { useColors } from '../context/ThemeContext';

const SEEN_KEY = '@voice_ai_recorder/onboarding_seen/v1';
const { width: SCREEN_W } = Dimensions.get('window');

// ─── Slide data ──────────────────────────────────────────────────────────────

interface Slide {
  icon: React.ReactNode;
  title: string;
  body: string;
  hint?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  /** Controls visibility. True = show (parent decides when to open). */
  visible: boolean;
  onDismiss: () => void;
}

export function OnboardingModal({ visible, onDismiss }: Props) {
  const c = useColors();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const slideAnim = useRef(new Animated.Value(0)).current;

  const slides: Slide[] = [
    {
      icon: <Mic size={56} color={c.primary} strokeWidth={1.5} />,
      title: 'Bem-vindo ao VoiceAI',
      body: 'Grave sua voz e deixe a IA transcrever, resumir e formatar automaticamente — consultas médicas, atas, prescrições e muito mais.',
    },
    {
      icon: <View style={[styles.recordDot, { backgroundColor: c.accentRed }]} />,
      title: 'Grave com um toque',
      body: 'Toque no botão vermelho para iniciar.\nPode pausar e retomar quando quiser.\nO arquivo fica salvo no seu dispositivo — mesmo sem internet.',
      hint: 'Dica: grave direto na consulta. A transcrição acontece depois.',
    },
    {
      icon: <Sparkles size={56} color={c.secondary} strokeWidth={1.5} />,
      title: 'Formatos prontos para cada uso',
      body: 'Escolha entre 14 templates:\nConsulta SOAP · Receituário · Atestado · Encaminhamento · Solicitação de Exames · Ata de Reunião · Mapa Mental e mais.',
      hint: 'Você também pode criar templates personalizados.',
    },
    {
      icon: <ShieldCheck size={56} color="#16a34a" strokeWidth={1.5} />,
      title: 'Como funciona a IA',
      body: 'Faça login para usar o modo seguro: sua chave OpenAI fica no servidor, nunca exposta no app.\n\nOu configure sua própria API key em Configurações.',
    },
  ];

  const goNext = () => {
    if (step < slides.length - 1) {
      Animated.timing(slideAnim, {
        toValue: -(step + 1) * SCREEN_W,
        duration: 260,
        useNativeDriver: true,
      }).start();
      setStep(step + 1);
    }
  };

  const isLast = step === slides.length - 1;

  const handleDismiss = () => {
    onDismiss();
    setStep(0);
    slideAnim.setValue(0);
  };

  const handleGoToAuth = () => {
    handleDismiss();
    setTimeout(() => router.push('/auth'), 300);
  };

  if (!visible) return null;

  const current = slides[step];

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      accessibilityViewIsModal
      onRequestClose={handleDismiss}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: c.bgSubtle }]}>
          {/* Skip button */}
          <Pressable
            style={styles.skipBtn}
            onPress={handleDismiss}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Fechar tutorial"
            accessibilityHint="Pula o tutorial de introdução"
          >
            <X size={20} color={c.textSecondary} />
          </Pressable>

          {/* Icon */}
          <View style={styles.iconWrap}>{current.icon}</View>

          {/* Title */}
          <Text
            style={styles.title as any}
            fontSize={22}
            fontWeight="800"
            color={c.text}
            textAlign="center"
          >
            {current.title}
          </Text>

          {/* Body */}
          <Text
            style={styles.body as any}
            fontSize={15}
            color={c.textSecondary}
            textAlign="center"
            lineHeight={22}
          >
            {current.body}
          </Text>

          {/* Hint */}
          {current.hint && (
            <View style={[styles.hintBox, { backgroundColor: c.bgYellowSoft, borderColor: c.borderYellow }]}>
              <BookOpen size={13} color={c.secondary} style={{ marginRight: 6, marginTop: 1 }} />
              <Text fontSize={12} color={c.secondary} flex={1} lineHeight={17}>
                {current.hint}
              </Text>
            </View>
          )}

          {/* Dots */}
          <View
            style={styles.dots}
            accessibilityLabel={`Passo ${step + 1} de ${slides.length}`}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 1, max: slides.length, now: step + 1 }}
          >
            {slides.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  {
                    backgroundColor: i === step ? c.primary : c.borderInput,
                    width: i === step ? 20 : 8,
                  },
                ]}
              />
            ))}
          </View>

          {/* Actions */}
          {isLast ? (
            <View style={styles.actionRow}>
              <Pressable
                style={[styles.btnSecondary, { borderColor: c.primary }]}
                onPress={handleDismiss}
                accessibilityRole="button"
                accessibilityLabel="Configurar depois"
                accessibilityHint="Fecha o tutorial e configura a conta mais tarde"
              >
                <Text fontWeight="700" fontSize={14} color={c.primary}>
                  Configurar depois
                </Text>
              </Pressable>
              <Pressable
                style={[styles.btnPrimary, { backgroundColor: c.primary }]}
                onPress={handleGoToAuth}
                accessibilityRole="button"
                accessibilityLabel="Entrar ou criar conta"
                accessibilityHint="Navega para a tela de login ou criação de conta"
              >
                <ShieldCheck size={16} color="#fff" />
                <Text fontWeight="700" fontSize={14} color="#fff" marginLeft="$2">
                  Entrar / Criar conta
                </Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.btnPrimary, { backgroundColor: c.primary }]}
              onPress={goNext}
              accessibilityRole="button"
              accessibilityLabel={`Próximo — passo ${step + 2} de ${slides.length}`}
            >
              <Text fontWeight="700" fontSize={15} color="#fff">
                Próximo
              </Text>
              <ChevronRight size={18} color="#fff" style={{ marginLeft: 4 }} />
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * Manages whether the onboarding modal should be shown.
 * Returns { show, markSeen }.
 */
export function useOnboarding() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(SEEN_KEY).then((v) => {
      if (!v) setShow(true);
    });
  }, []);

  const markSeen = async () => {
    setShow(false);
    await AsyncStorage.setItem(SEEN_KEY, 'true');
  };

  return { show, markSeen };
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
    gap: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 10,
  },
  skipBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    padding: 4,
  },
  iconWrap: {
    marginTop: 8,
    marginBottom: 4,
    alignItems: 'center',
    justifyContent: 'center',
    height: 72,
  },
  recordDot: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  title: {
    marginTop: 0,
  },
  body: {
    paddingHorizontal: 4,
  },
  hintBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    width: '100%',
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginVertical: 4,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  btnPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    gap: 6,
  },
  btnSecondary: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 2,
  },
});
