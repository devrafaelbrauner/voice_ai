import '@/global.css';

import { Platform } from 'react-native';

// Comprehensive semantic color palette for the app.
// Each color has a light and dark variant. Use via useColors() hook.
// ─── Bootstrap Gray Scale ──────────────────────────────────────
// Reference: https://coolors.co/palette/f8f9fa-e9ecef-dee2e6-ced4da-adb5bd-6c757d-495057-343a40-212529
const G = {
  100: '#f8f9fa', // lightest
  200: '#e9ecef',
  300: '#dee2e6',
  400: '#ced4da',
  500: '#adb5bd',
  600: '#6c757d',
  700: '#495057',
  800: '#343a40',
  900: '#212529', // darkest
} as const;

// ─── Light mode — Warm palette ─────────────────────────────────
// Reference: https://coolors.co/palette/000000-fffffc-beb7a4-ff7f11-ff3f00
//   black #000000 · cream #fffffc · taupe #beb7a4 · orange #ff7f11 · vermilion #ff3f00
// Os 5 swatches são a identidade; alguns tons quentes são derivados (tints do
// taupe e um laranja queimado) para cobrir os papéis semânticos com contraste
// legível — laranja vivo não tem contraste suficiente como texto sobre creme,
// então é reservado para acentos/preenchimentos, e o preto cobre texto e CTAs.
const W = {
  black: '#000000',
  cream: '#fffffc',
  taupe: '#beb7a4', // base
  orange: '#ff7f11',
  vermilion: '#ff3f00',
  burnt: '#c2410c', // laranja queimado derivado — texto/rótulo legível (~5.8:1)
  // tints quentes (taupe → creme) para superfícies e bordas
  t050: '#f7f6f1',
  t100: '#f0eee7',
  t200: '#e6e2d7',
  t300: '#d9d4c5',
  t400: '#cac4b3',
  t600: '#8c8676', // texto muted
  t700: '#57534a', // texto secundário
  t800: '#2e2b26', // quase-preto quente
} as const;

export const Colors = {
  light: {
    // ─── VoiceAI — Warm palette (Light) ─────────────────────────
    // Cream surfaces, black text, taupe structure, orange/vermilion accents.
    // Paleta: https://coolors.co/palette/000000-fffffc-beb7a4-ff7f11-ff3f00

    // Backgrounds
    bg: W.cream,
    background: W.cream,
    bgScreen: W.t050,              // GlassBackground anchor — creme levemente quente
    bgCard: W.cream,               // cards creme sobre fundo levemente taupe
    bgSubtle: 'rgba(255,255,252,0.72)',
    backgroundElement: 'rgba(255,255,252,0.72)',
    backgroundSelected: W.t200,
    bgInput: W.cream,

    // Accent backgrounds
    bgPurpleSoft: W.t100,          // container tonal sutil
    bgBlueSoft: W.t100,
    bgGreenSoft: W.t100,
    bgGreenSofter: W.t050,
    bgYellowSoft: '#ffead5',       // tint laranja — avisos/fila offline
    bgRedSoft: '#ffe3db',          // tint vermilion — erros/destrutivo

    // Text
    text: W.black,
    textSecondary: W.t700,
    textLabel: W.black,
    textPlaceholder: W.taupe,
    textMuted: W.t600,
    textInverse: W.cream,
    textOnAccent: W.cream,         // texto claro sobre preto/queimado/vermilion

    // Borders
    border: W.t300,
    borderInput: W.t400,
    borderPurple: W.t200,
    borderBlue: W.taupe,
    borderGreen: W.t300,
    borderYellow: '#f2c99b',

    // Brand — preto para legibilidade; laranjas como acentos
    primary: W.black,              // #000000 — texto, ícones e CTAs principais
    primaryDeep: W.t800,           // #2e2b26 — variante profunda / chips
    secondary: W.burnt,            // #c2410c — rótulos/seções/ações secundárias (legível)
    accentBlue: W.burnt,           // #c2410c — acento informativo (reaproveitado, quente)
    accentRed: W.vermilion,        // #ff3f00 — destrutivo / estado de gravação
    accentOrange: W.orange,        // #ff7f11 — laranja vivo de destaque
    accentYellow: W.burnt,         // #c2410c — texto de aviso legível
    accentNavy: W.t800,            // #2e2b26
    accentGreenDark: W.t800,       // #2e2b26 — corpo do resumo (texto escuro legível)
  },
  dark: {
    // ─── VoiceAI — Bootstrap Gray (Dark) ────────────────────────
    // Inverted: darkest grays as backgrounds, lightest as text.

    // Backgrounds
    bg: G[900],
    background: G[900],
    bgScreen: G[900],
    bgCard: G[800],                // #343a40 — card surface
    bgSubtle: 'rgba(52,58,64,0.80)',
    backgroundElement: 'rgba(52,58,64,0.80)',
    backgroundSelected: G[700],
    bgInput: 'rgba(73,80,87,0.60)',

    // Accent backgrounds
    bgPurpleSoft: G[800],
    bgBlueSoft: G[800],
    bgGreenSoft: G[800],
    bgGreenSofter: G[900],
    bgYellowSoft: G[800],
    bgRedSoft: G[800],

    // Text — light on dark
    text: G[100],
    textSecondary: G[300],
    textLabel: G[100],
    textPlaceholder: G[600],
    textMuted: G[500],
    textInverse: G[900],
    textOnAccent: G[900],

    // Borders
    border: G[700],
    borderInput: G[600],
    borderPurple: G[700],
    borderBlue: G[600],
    borderGreen: G[700],
    borderYellow: G[700],

    // Brand — light primary on dark bg
    primary: G[200],               // #e9ecef — main actions on dark
    primaryDeep: G[100],           // #f8f9fa
    secondary: G[500],             // #adb5bd
    accentBlue: G[300],            // #dee2e6
    accentRed: '#e74c3c',          // brighter red for visibility on dark
    accentOrange: G[500],
    accentYellow: G[500],
    accentNavy: G[300],
    accentGreenDark: G[300],
  },
} as const;

// Use a mapped type so both light and dark palettes satisfy ColorPalette
// (literal string types in Colors.light are too narrow otherwise)
export type ColorPalette = { [K in keyof typeof Colors.light]: string };
export type ThemeColor = keyof ColorPalette;

// VoiceAI Design System fonts.
//   - Headings → 'New York' (iOS system serif) with Georgia fallback on Android/web.
//   - Body / UI → 'DM Sans' loaded via Google Fonts (or system sans fallback).
//   - Numbers / display → 'Lora' (serif with good number proportion).
//   - Code → 'DM Mono'.
export const Fonts = Platform.select({
  ios: {
    sans: 'DM Sans',           // body, captions
    serif: 'New York',          // titles, headings
    display: 'Lora',            // numeric display (timer)
    rounded: 'ui-rounded',
    mono: 'DM Mono',
  },
  default: {
    sans: 'DM Sans',
    serif: 'Georgia',
    display: 'Lora',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "'DM Sans', sans-serif",
    serif: "'New York', ui-serif, Georgia, serif",
    display: "'Lora', Georgia, serif",
    rounded: 'var(--font-rounded)',
    mono: "'DM Mono', monospace",
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
