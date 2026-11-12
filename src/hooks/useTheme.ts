import { create } from 'zustand';
import { Appearance } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const THEME_STORAGE_KEY = 'theme_mode';

/** Preferência do usuário. 'system' = segue o aparelho (nada salvo no SecureStore). */
export type ThemeMode = 'light' | 'dark' | 'system';

function getSystemIsDark(): boolean {
  return Appearance.getColorScheme() === 'dark';
}

function resolveIsDark(mode: ThemeMode, systemIsDark: boolean): boolean {
  if (mode === 'system') return systemIsDark;
  return mode === 'dark';
}

interface ThemeStore {
  mode: ThemeMode;
  systemIsDark: boolean;
  /** Tema efetivo aplicado na UI (derivado de mode + sistema). */
  isDark: boolean;
  /** Chamado uma vez no mount — lê a preferência salva no SecureStore. */
  initTheme: () => Promise<void>;
  /** Define a preferência (light | dark | system) e persiste. */
  setMode: (mode: ThemeMode) => Promise<void>;
  /** Alterna o tema efetivo entre claro e escuro (preferência explícita). */
  toggleTheme: () => Promise<void>;
}

// Valor inicial síncrono: começa com o tema do sistema, evitando flash no primeiro render.
export const useThemeStore = create<ThemeStore>((set, get) => ({
  mode: 'system',
  systemIsDark: getSystemIsDark(),
  isDark: getSystemIsDark(),

  initTheme: async () => {
    let mode: ThemeMode = 'system';
    try {
      const saved = await SecureStore.getItemAsync(THEME_STORAGE_KEY);
      if (saved === 'dark' || saved === 'light') mode = saved;
    } catch {
      // SecureStore indisponível: segue o sistema.
    }
    const systemIsDark = getSystemIsDark();
    set({ mode, systemIsDark, isDark: resolveIsDark(mode, systemIsDark) });
  },

  setMode: async (mode: ThemeMode) => {
    try {
      if (mode === 'system') await SecureStore.deleteItemAsync(THEME_STORAGE_KEY);
      else await SecureStore.setItemAsync(THEME_STORAGE_KEY, mode);
    } catch {
      // Falha ao persistir: aplica mesmo assim (volta ao padrão na próxima abertura).
    }
    set({ mode, isDark: resolveIsDark(mode, get().systemIsDark) });
  },

  toggleTheme: async () => {
    await get().setMode(get().isDark ? 'light' : 'dark');
  },
}));

// Acompanha o sistema em tempo real quando a preferência é 'system'.
Appearance.addChangeListener(({ colorScheme }) => {
  const systemIsDark = colorScheme === 'dark';
  const { mode } = useThemeStore.getState();
  useThemeStore.setState({ systemIsDark, isDark: resolveIsDark(mode, systemIsDark) });
});

export function useTheme() {
  const isDark = useThemeStore((state) => state.isDark);
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  // Compatibilidade com chamadas antigas (booleano).
  const setTheme = (dark: boolean) => setMode(dark ? 'dark' : 'light');

  return { isDark, mode, setMode, setTheme, toggleTheme };
}
