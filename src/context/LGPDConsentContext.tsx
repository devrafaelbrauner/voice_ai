import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { logError, logDebug } from '../services/log';

const CONSENT_KEY = 'lgpd_consent_v1';
const CURRENT_CONSENT_VERSION = '2024-05-24';

interface LGPDConsentState {
  accepted: boolean | null;
  acceptedAt: string | null;
  version: string | null;
}

interface LGPDContextValue extends LGPDConsentState {
  acceptConsent: () => Promise<void>;
  revokeConsent: () => Promise<void>;
}

const LGPDContext = createContext<LGPDContextValue | null>(null);

export function LGPDConsentProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LGPDConsentState>({
    accepted: null,
    acceptedAt: null,
    version: null,
  });

  // Single initialization effect
  useEffect(() => {
    checkConsent();
  }, []);

  async function checkConsent() {
    try {
      const raw = await SecureStore.getItemAsync(CONSENT_KEY);
      logDebug('LGPD', 'SecureStore result:', raw ? 'found' : 'not found');

      if (raw) {
        const parsed = JSON.parse(raw);
        logDebug('LGPD', 'Parsed consent:', {
          version: parsed.version,
          current: CURRENT_CONSENT_VERSION,
        });

        if (parsed.version === CURRENT_CONSENT_VERSION) {
          logDebug('LGPD', 'Version match — user already consented');
          setState({
            accepted: true,
            acceptedAt: parsed.acceptedAt,
            version: parsed.version,
          });
          return;
        }
      }

      logDebug('LGPD', 'Showing consent modal');
      setState({ accepted: false, acceptedAt: null, version: null });
    } catch (err) {
      logError('LGPD', err);
      setState({ accepted: false, acceptedAt: null, version: null });
    }
  }

  async function acceptConsent() {
    const acceptedAt = new Date().toISOString();
    const stored = JSON.stringify({
      accepted: true,
      acceptedAt,
      version: CURRENT_CONSENT_VERSION,
    });
    await SecureStore.setItemAsync(CONSENT_KEY, stored);
    logDebug('LGPD', 'Consent accepted');
    setState({
      accepted: true,
      acceptedAt,
      version: CURRENT_CONSENT_VERSION,
    });
  }

  async function revokeConsent() {
    await SecureStore.deleteItemAsync(CONSENT_KEY);
    logDebug('LGPD', 'Consent revoked');
    setState({ accepted: false, acceptedAt: null, version: null });
  }

  return (
    <LGPDContext.Provider value={{ ...state, acceptConsent, revokeConsent }}>
      {children}
    </LGPDContext.Provider>
  );
}

export function useLGPDConsent() {
  const context = useContext(LGPDContext);
  if (!context) {
    throw new Error('useLGPDConsent must be used within LGPDConsentProvider');
  }
  return context;
}

/**
 * Standalone check — does NOT need React (safe to call in services)
 */
export async function hasLGPDConsent(): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(CONSENT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed.version === CURRENT_CONSENT_VERSION && parsed.accepted === true;
  } catch {
    return false;
  }
}
