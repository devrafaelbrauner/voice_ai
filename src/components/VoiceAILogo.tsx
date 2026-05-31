// VoiceAI Logo — Conceito D Vertical Dark (handoff): gradiente azul #5a96c4 → #2d5a8a.

import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect, Line, Path } from 'react-native-svg';

interface Props {
  size?: number;
  variant?: 'icon' | 'wordmark';
}

export function VoiceAILogo({ size = 34, variant = 'icon' }: Props) {
  const cornerRadius = size * 0.22; // 22% per handoff spec

  const icon = (
    // pointerEvents="none" — SVG must not intercept touch events on iOS
    <View pointerEvents="none">
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <SvgLinearGradient id="vai-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#5a96c4" />
          <Stop offset="100%" stopColor="#2d5a8a" />
        </SvgLinearGradient>
      </Defs>
      <Rect width="100" height="100" rx={cornerRadius * (100 / size)} fill="url(#vai-grad)" />
      {/* Microphone body */}
      <Rect x="34" y="12" width="32" height="40" rx="16" stroke="white" strokeWidth="2.8" fill="none" />
      <Line x1="40" y1="26" x2="60" y2="26" stroke="white" strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
      <Line x1="40" y1="33" x2="60" y2="33" stroke="white" strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
      <Line x1="40" y1="40" x2="60" y2="40" stroke="white" strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
      {/* Mic stand arc */}
      <Path d="M26 53 Q26 72 50 72 Q74 72 74 53" stroke="white" strokeWidth="2.8" fill="none" strokeLinecap="round" />
      <Line x1="50" y1="72" x2="50" y2="83" stroke="white" strokeWidth="2.8" strokeLinecap="round" />
      <Line x1="38" y1="83" x2="62" y2="83" stroke="white" strokeWidth="2.8" strokeLinecap="round" />
      {/* Bottom decorative arc */}
      <Path d="M34 90 A18 9 0 0 1 66 90" stroke="white" strokeWidth="1.8" fill="none" strokeLinecap="round" opacity="0.5" />
    </Svg>
    </View>
  );

  if (variant === 'icon') {
    return icon;
  }

  // Wordmark: icon + "Voice AI" + "Recorder"
  return (
    <View style={{ alignItems: 'center', gap: 10 }}>
      {icon}
      <View style={{ alignItems: 'center' }}>
        <Text style={{ fontSize: size * 0.36, fontWeight: '700', color: 'white' }}>
          Voice<Text style={{ color: '#c8ddf0' }}>AI</Text>
        </Text>
        <Text
          style={{
            fontSize: size * 0.13,
            fontWeight: '600',
            color: 'rgba(255,255,255,0.3)',
            letterSpacing: 2,
            textTransform: 'uppercase',
            marginTop: 2,
          }}
        >
          Recorder
        </Text>
      </View>
    </View>
  );
}
