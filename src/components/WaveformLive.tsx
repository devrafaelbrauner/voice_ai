/**
 * WaveformLive
 *
 * Animated waveform rendered during recording.
 * Data is fed from useVoiceRecorder at 95 ms intervals.
 *
 * Implementation note: uses plain React Native <View> bars (NOT react-native-svg)
 * because the SVG path showed inconsistent rendering on some Expo SDK 55 builds.
 * Views with dynamic height + backgroundColor are guaranteed to render on every
 * RN platform without any third-party dependency.
 *
 * Visual spec:
 *  • Each bar is centered vertically (flex aligns items: 'center')
 *  • Amplitude 0–1 → bar height 12–68 px (MIN_HEIGHT … MAX_HEIGHT)
 *  • Color by amplitude:
 *      valley  (< 0.35) → G-400 / G-600  (light blue-gray)
 *      mid     (0.35–0.65) → G-600 / G-400
 *      peak    (> 0.65) → G-800 / G-200  (strong charcoal / near-white)
 *  • Glow: bars > 65 % render under a wider semi-transparent shadow halo.
 *  • pointerEvents="none" on the outer View prevents touch interception on iOS.
 */

import React from 'react';
import { View } from 'react-native';
import { useThemedColors } from '../context/ThemeContext';

const BAR_WIDTH = 3;
const BAR_GAP = 3;
const CONTAINER_HEIGHT = 80;
const MAX_HEIGHT = 68; // px, doubled MAX_HALF from old SVG impl
const MIN_HEIGHT = 12;

const MID_THRESH = 0.35;
const PEAK_THRESH = 0.65;

interface BarColors {
  valley: string;
  mid: string;
  peak: string;
  glow: string;
}

function makeColors(isDark: boolean): BarColors {
  if (isDark) {
    return {
      valley: 'rgba(108,117,125,0.55)',
      mid:    '#adb5bd',
      peak:   '#dee2e6',
      glow:   'rgba(233,236,239,0.30)',
    };
  }
  // Light — paleta quente: vale taupe, meio laranja, pico vermilion.
  return {
    valley: '#d9d4c5',
    mid:    '#ff7f11',
    peak:   '#ff3f00',
    glow:   'rgba(255,63,0,0.22)',
  };
}

function barColor(amp: number, colors: BarColors): string {
  if (amp > PEAK_THRESH) return colors.peak;
  if (amp > MID_THRESH)  return colors.mid;
  return colors.valley;
}

export const WaveformLive = ({ data }: { data: number[] }) => {
  const { isDark } = useThemedColors();
  const colors = makeColors(isDark);

  return (
    <View
      pointerEvents="none"
      style={{
        height: CONTAINER_HEIGHT,
        marginVertical: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: BAR_GAP,
        paddingHorizontal: 8,
      }}
    >
      {data.map((amp, i) => {
        const h = Math.max(MIN_HEIGHT, Math.round(amp * MAX_HEIGHT));
        const fill = barColor(amp, colors);
        const isPeak = amp > PEAK_THRESH;

        return (
          <View
            key={i}
            style={{
              width: BAR_WIDTH,
              height: h,
              borderRadius: 1.5,
              backgroundColor: fill,
              shadowColor: isPeak ? colors.peak : 'transparent',
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: isPeak ? 0.45 : 0,
              shadowRadius: isPeak ? 4 : 0,
              elevation: isPeak ? 3 : 0,
            }}
          />
        );
      })}
    </View>
  );
};
