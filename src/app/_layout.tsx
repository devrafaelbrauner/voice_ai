import { TamaguiProvider, Theme } from 'tamagui';
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { pullOnLogin } from '../services/sync';
import config from '../tamagui.config';
import { ThemeProvider } from '../context/ThemeContext';
import { useThemeStore } from '../hooks/useTheme';
import { LGPDConsentProvider, useLGPDConsent } from '../context/LGPDConsentContext';
import { LGPDConsentModal } from '../components/LGPDConsentModal';
import { AndroidActionSheetProvider } from '../components/ActionSheet';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { OnboardingModal, useOnboarding } from '../components/OnboardingModal';
import { ErrorBoundary } from '../components/ErrorBoundary';

function ThemeAwareLayout() {
  const isDark = useThemeStore((state) => state.isDark);
  const { accepted, acceptConsent } = useLGPDConsent();
  const { show: showOnboarding, markSeen: markOnboardingSeen } = useOnboarding();

  useEffect(() => {
    // Only sync after consent (loading state = null, skip)
    if (accepted === true) {
      pullOnLogin();
    }
  }, [accepted]);

  return (
    <TamaguiProvider config={config} defaultTheme={isDark ? 'dark' : 'light'}>
      <Theme name={isDark ? 'dark' : 'light'}>
        {/*
         * Explicit Stack with headerShown:false on all screens.
         * Using <Slot> instead caused expo-router SDK 55 to spin up an internal
         * navigator whose transparent overlay intercepted ALL touch events on
         * the iOS native layer. Switching to <Stack> with explicit options
         * eliminates that invisible hit-test layer.
         */}
        <Stack screenOptions={{ headerShown: false }} />
        {/* LGPD consent gate — shows before any data sync/recording */}
        {accepted === false && (
          <LGPDConsentModal
            visible
            onAccept={acceptConsent}
          />
        )}
        {/* Onboarding — only shown once, after LGPD consent is given */}
        {accepted === true && showOnboarding && (
          <OnboardingModal
            visible
            onDismiss={markOnboardingSeen}
          />
        )}
      </Theme>
    </TamaguiProvider>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ThemeProvider>
          <LGPDConsentProvider>
            <AndroidActionSheetProvider>
              <ThemeAwareLayout />
            </AndroidActionSheetProvider>
          </LGPDConsentProvider>
        </ThemeProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
