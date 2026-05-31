// Liquid Glass helper — produces translucent surface styles consistent
// with the VoiceAI design handoff (Maio 2026).
//
// Three standard levels:
//   • glass(0.55, 16) — Standard card: lists, sections, containers
//   • glass(0.48, 24) — Header / nav / tab bar
//   • glass(0.60, 28) — Bottom tab bar, primary overlays
//
// Pass isDark=true to get a charcoal-tinted surface (Bootstrap G-800 base)
// instead of the default white-tinted surface.
//
// NOTE on React Native: backdropFilter / WebkitBackdropFilter are
// browser-only. On native (iOS/Android), use the BlurView from expo-blur
// for the actual blur. The styles returned here apply the *surface color*,
// border, and shadow — pair them with a BlurView wrapper for full effect.

import { Platform, ViewStyle } from 'react-native';

export interface GlassStyle extends ViewStyle {
  backgroundColor: string;
  borderWidth: number;
  borderColor: string;
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
}

/**
 * Returns a ViewStyle approximating a liquid-glass surface.
 * @param alpha  Opacity of the surface tint (0–1). Default 0.55.
 * @param _blur  Blur radius for BlurView / CSS backdrop-filter. Default 16.
 * @param isDark When true, uses a dark charcoal base (Bootstrap G-800).
 */
export function glass(
  alpha: number = 0.55,
  _blur: number = 16,
  isDark: boolean = false
): GlassStyle {
  // Light: white tinted surface on gray background
  // Dark:  Bootstrap G-800 (#343a40) charcoal tinted surface on near-black bg
  const bg     = isDark
    ? `rgba(52,58,64,${alpha})`          // G-800 charcoal
    : `rgba(255,255,255,${alpha})`;      // white

  const border = isDark
    ? 'rgba(255,255,255,0.10)'           // subtle white rim on dark
    : 'rgba(255,255,255,0.70)';          // bright white rim on light

  const shadow = isDark
    ? 'rgba(0,0,0,0.50)'
    : 'rgba(33,37,41,0.12)';            // G-900 @ 12%

  const base: GlassStyle = {
    backgroundColor: bg,
    borderWidth: 1,
    borderColor: border,
    shadowColor: shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 16,
    elevation: 4,
  };

  if (Platform.OS === 'web') {
    return {
      ...base,
      backdropFilter: `blur(${_blur}px) saturate(180%)`,
      WebkitBackdropFilter: `blur(${_blur}px) saturate(180%)`,
    };
  }

  return base;
}

/**
 * Recommended blur intensities for expo-blur's BlurView,
 * matching the same three glass levels (0-100 scale).
 */
export const GLASS_BLUR = {
  card: 16,    // Standard
  header: 24,  // Headers
  tabBar: 28,  // Bottom tab bar
} as const;

/**
 * Returns the matching surface color for a glass level.
 * @param isDark When true, returns charcoal tints.
 */
export function glassTint(isDark: boolean = false) {
  return {
    card:   isDark ? 'rgba(52,58,64,0.72)'   : 'rgba(255,255,255,0.72)',
    header: isDark ? 'rgba(52,58,64,0.65)'   : 'rgba(255,255,255,0.65)',
    tabBar: isDark ? 'rgba(33,37,41,0.85)'   : 'rgba(248,249,250,0.80)',
  };
}

// Legacy constant kept for back-compat (light-only).
export const GLASS_TINT = {
  card:   'rgba(255,255,255,0.72)',
  header: 'rgba(255,255,255,0.65)',
  tabBar: 'rgba(248,249,250,0.80)',
} as const;
