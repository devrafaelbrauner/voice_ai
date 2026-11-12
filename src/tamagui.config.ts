import { createTamagui, createFont } from 'tamagui';
import { config as defaultConfig } from '@tamagui/config';
import { Platform } from 'react-native';

// VoiceAI Design System font stack.
// New York is iOS's system serif — falls back to Georgia on Android/web.
// Lora is used for numeric display (timer). DM Sans for body/captions.
const serifFamily = Platform.select({
  ios: 'New York',
  default: 'Georgia',
}) as string;

const displayFamily = Platform.select({
  ios: 'Lora_400Regular',
  default: 'Lora_400Regular',
}) as string;

const sansFamily = Platform.select({
  ios: 'DMSans_400Regular',
  default: 'DMSans_400Regular',
}) as string;

const sizeScale = {
  1: 9,
  2: 10,
  3: 12,
  4: 13,
  5: 14,
  6: 15,
  7: 16,
  8: 20,
  9: 24,
  10: 32,
  11: 42,
  12: 56,
  true: 14,
};

const lineHeightScale = {
  1: 13,
  2: 14,
  3: 16,
  4: 18,
  5: 20,
  6: 21,
  7: 22,
  8: 28,
  9: 32,
  10: 40,
  11: 50,
  12: 64,
  true: 20,
};

const baseFontMeta = {
  size: sizeScale,
  lineHeight: lineHeightScale,
  weight: {
    1: '400',
    2: '500',
    3: '600',
    4: '700',
    5: '800',
    true: '500',
  },
  letterSpacing: {
    1: 0,
    2: -0.2,
    3: -0.4,
    4: -0.6,
    true: 0,
  },
};

const serifFont = createFont({
  family: serifFamily,
  ...baseFontMeta,
});

const sansFont = createFont({
  family: sansFamily,
  ...baseFontMeta,
  // Pesos reais carregados em _layout.tsx (useFonts). Sem isso o RN faz negrito sintético.
  face: {
    400: { normal: 'DMSans_400Regular' },
    500: { normal: 'DMSans_500Medium' },
    600: { normal: 'DMSans_600SemiBold' },
    700: { normal: 'DMSans_700Bold' },
    800: { normal: 'DMSans_800ExtraBold' },
  },
});

const displayFont = createFont({
  family: displayFamily,
  ...baseFontMeta,
  face: {
    400: { normal: 'Lora_400Regular' },
    500: { normal: 'Lora_500Medium' },
    600: { normal: 'Lora_600SemiBold' },
    700: { normal: 'Lora_700Bold' },
    800: { normal: 'Lora_700Bold' }, // Lora não tem peso 800
  },
});

const config = createTamagui({
  ...defaultConfig,
  fonts: {
    ...defaultConfig.fonts,
    heading: serifFont,
    body: sansFont,
    serif: serifFont,
    display: displayFont,
  },
});

export type AppConfig = typeof config;

declare module 'tamagui' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface TamaguiCustomConfig extends AppConfig {}
}

export default config;
