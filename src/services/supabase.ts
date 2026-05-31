import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import { logWarn } from './log';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  logWarn("supabase", 
    '[supabase] EXPO_PUBLIC_SUPABASE_URL ou EXPO_PUBLIC_SUPABASE_ANON_KEY não definidos. Cloud sync desabilitado.'
  );
}

const canPersistAuth =
  Platform.OS !== 'web' || typeof window !== 'undefined';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: canPersistAuth ? AsyncStorage : undefined,
    autoRefreshToken: true,
    persistSession: canPersistAuth,
    detectSessionInUrl: false,
  },
});

export const isCloudConfigured = () =>
  Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
