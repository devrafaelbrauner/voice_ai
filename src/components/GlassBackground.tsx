// GlassBackground — full-screen gradient that respects the app's internal
// dark-mode toggle (Zustand / SecureStore), NOT the system colorScheme.
//
// Light: #dee2e6 (G-300) → #e9ecef (G-200) → #dee2e6 (G-300)
// Dark:  #0d0f10 → #16181a → #0d0f10   (near-black, AMOLED-friendly)

import React from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect, Circle } from 'react-native-svg';
import { useThemeStore } from '../hooks/useTheme';

interface Props {
  children: React.ReactNode;
}

export function GlassBackground({ children }: Props) {
  const { width, height } = useWindowDimensions();
  const isDark = useThemeStore((state) => state.isDark);

  // Light palette: Bootstrap Gray 200–300
  // Dark palette: near-black charcoal tones (darker than theme.ts G-900 for
  //               a richer "true dark" feel, especially on AMOLED screens)
  const bg1    = isDark ? '#0d0f10' : '#dee2e6';
  const bg2    = isDark ? '#16181a' : '#e9ecef';
  const blob1  = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.45)';
  const blob2  = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.30)';
  const blob3  = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(73,80,87,0.08)';
  const rootBg = isDark ? '#0d0f10' : '#dee2e6';

  return (
    <View style={[styles.root, { backgroundColor: rootBg }]}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
              <Stop offset="0%"   stopColor={bg1} />
              <Stop offset="50%"  stopColor={bg2} />
              <Stop offset="100%" stopColor={bg1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#bg)" />

          <Circle cx={width * 0.25} cy={height * 0.12} r={110} fill={blob1} />
          <Circle cx={width * 0.78} cy={height * 0.55} r={90}  fill={blob2} />
          <Circle cx={width * 0.15} cy={height * 0.85} r={80}  fill={blob3} />
        </Svg>
      </View>

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
