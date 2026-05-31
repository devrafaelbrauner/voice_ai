/**
 * AudioPlayerBar
 *
 * Compact progress bar rendered below each recording row while that
 * recording is active. Shows:
 *   • Current time / total duration
 *   • Filled progress track (tap anywhere to seek)
 *   • Buffering indicator
 */
import React, { useRef, useState } from 'react';
import { View, Pressable, StyleSheet, LayoutChangeEvent } from 'react-native';
import { Text, XStack } from 'tamagui';
import { useColors } from '../context/ThemeContext';

const SPEEDS = [1, 1.5, 2] as const;
type Speed = typeof SPEEDS[number];

interface Props {
  currentTime: number;   // seconds
  duration: number;      // seconds (0 while loading)
  isBuffering?: boolean;
  onSeek: (ratio: number) => void; // ratio 0–1
  onSpeedChange?: (rate: Speed) => void;
}

function formatTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function AudioPlayerBar({ currentTime, duration, isBuffering, onSeek, onSpeedChange }: Props) {
  const c = useColors();
  const [barWidth, setBarWidth] = useState(1);
  const [speed, setSpeed] = useState<Speed>(1);
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    onSpeedChange?.(next);
  };

  const handleLayout = (e: LayoutChangeEvent) => {
    setBarWidth(e.nativeEvent.layout.width || 1);
  };

  const handlePress = (e: any) => {
    const { locationX } = e.nativeEvent;
    const ratio = Math.max(0, Math.min(1, locationX / barWidth));
    onSeek(ratio);
  };

  return (
    <XStack alignItems="center" gap="$2" px="$1" pb="$1">
      {/* Progress track */}
      <Pressable
        style={styles.trackContainer}
        onLayout={handleLayout}
        onPress={handlePress}
        accessibilityRole="adjustable"
        accessibilityLabel="Barra de progresso do áudio"
        accessibilityHint="Toque para navegar para uma posição no áudio"
        accessibilityValue={{
          min: 0,
          max: 100,
          now: Math.round(progress * 100),
          text: `${formatTime(currentTime)} de ${formatTime(duration)}`,
        }}
      >
        {/* Background track */}
        <View style={[styles.track, { backgroundColor: c.border }]}>
          {/* Filled portion */}
          <View
            style={[
              styles.fill,
              {
                width: `${(progress * 100).toFixed(1)}%` as any,
                backgroundColor: c.primary,
              },
            ]}
          />
          {/* Thumb dot */}
          <View
            style={[
              styles.thumb,
              {
                left: `${(progress * 100).toFixed(1)}%` as any,
                backgroundColor: c.primary,
              },
            ]}
          />
        </View>
      </Pressable>

      {/* Time display */}
      <Text
        fontSize={11}
        color={c.textSecondary}
        fontWeight="600"
        flexShrink={0}
      >
        {isBuffering && duration === 0
          ? '…'
          : `${formatTime(currentTime)} / ${formatTime(duration)}`}
      </Text>

      {/* Speed toggle */}
      <Pressable
        onPress={cycleSpeed}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Velocidade de reprodução: ${speed}x`}
        accessibilityHint="Toque para alterar a velocidade de reprodução"
      >
        <Text
          fontSize={10}
          fontWeight="800"
          color={speed !== 1 ? c.primary : c.textMuted}
          flexShrink={0}
        >
          {speed}×
        </Text>
      </Pressable>
    </XStack>
  );
}

const styles = StyleSheet.create({
  trackContainer: {
    flex: 1,
    paddingVertical: 8, // larger tap area
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
    position: 'relative',
    overflow: 'visible',
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    borderRadius: 2,
  },
  thumb: {
    position: 'absolute',
    top: -4,
    marginLeft: -5,
    width: 12,
    height: 12,
    borderRadius: 6,
  },
});
