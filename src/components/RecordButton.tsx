import { useEffect, useRef } from 'react';
import {
  TouchableOpacity,
  StyleSheet,
  Vibration,
  Platform,
  Animated,
} from 'react-native';
import { Mic, Square } from 'lucide-react-native';
import { Text } from 'tamagui';
import { useColors } from '../context/ThemeContext';

interface RecordButtonProps {
  isRecording: boolean;
  isPaused?: boolean;
  onPress: () => void;
}

export const RecordButton = ({
  isRecording,
  isPaused = false,
  onPress,
}: RecordButtonProps) => {
  // Use built-in RN Animated (not Reanimated) to avoid worklet-runtime
  // initialization issues that block touch events on iOS 18 / Expo Go.
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isRecording && !isPaused) {
      Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(scale, { toValue: 1.15, duration: 800, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0.6, duration: 800, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 800, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
          ]),
        ])
      ).start();
    } else {
      Animated.parallel([
        Animated.timing(scale, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    }
    return () => {
      scale.stopAnimation();
      opacity.stopAnimation();
    };
  }, [isRecording, isPaused, scale, opacity]);

  const animatedStyle = {
    transform: [{ scale }],
    opacity,
  };

  const c = useColors();
  // Bootstrap Gray palette:
  // Idle: rgba(52,58,64,.95) — G-800 charcoal
  // Recording: rgba(192,57,43,.92) — red (kept for critical UX feedback)
  const bg = isRecording ? 'rgba(192,57,43,0.92)' : 'rgba(52,58,64,0.95)';
  const shadowColor = isRecording ? '#c0392b' : c.primary;

  const a11yLabel = isRecording
    ? isPaused
      ? 'Retomar gravação'
      : 'Parar gravação'
    : 'Iniciar gravação';

  const a11yHint = isRecording
    ? isPaused
      ? 'Toque para retomar a gravação pausada'
      : 'Toque para finalizar e salvar a gravação'
    : 'Toque para começar a gravar';

  return (
    <TouchableOpacity
      onPress={() => {
        // Haptic feedback via built-in Vibration (no extra native module needed)
        if (Platform.OS === 'android') {
          Vibration.vibrate(isRecording ? 40 : 80);
        }
        onPress();
      }}
      activeOpacity={0.8}
      style={{ alignItems: 'center' }}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint={a11yHint}
      accessibilityState={{ selected: isRecording }}
    >
      <Animated.View
        style={[
          styles.button,
          { backgroundColor: bg, shadowColor },
          animatedStyle,
        ]}
      >
        {isRecording ? (
          <Square size={36} color="white" strokeWidth={3} fill="white" />
        ) : (
          <Mic size={42} color="white" strokeWidth={2.5} />
        )}
      </Animated.View>
      <Text
        textAlign="center"
        marginTop="$2"
        color={isRecording ? '#c0392b' : c.primaryDeep}
        fontWeight="700"
        fontSize={10}
        letterSpacing={2}
        textTransform="uppercase"
      >
        {isRecording ? (isPaused ? 'Pausado' : 'Gravando') : 'Toque para gravar'}
      </Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    // Handoff spec: 104 × 104 · borderRadius: 999 · 1.5px white border
    width: 104,
    height: 104,
    borderRadius: 999,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.28)',
    // Shadow: 0 8px 36px {color}55
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.33,
    shadowRadius: 18,
    elevation: 16,
  },
});
