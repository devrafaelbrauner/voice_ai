import { create } from 'zustand';
import { Appearance } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const THEME_STORAGE_KEY = 'theme_mode';

// ─── Bootstrap: lê preferência do sistema SINCRONAMENTE ─────────────────────
// Isso evita o flash "light → dark" no primeiro render porque o store
// já começa com o valor correto antes de qualquer efeito assíncrono.
function getSystemIsDark(): boolean {
  return Appearance.getColorScheme() === 'dark';
}

interface ThemeStore {
  isDark: boolean;
  /** Chamado uma vez no mount — lê SecureStore (preferência explícita do usuário). */
  initTheme: () => Promise<void>;
  /** Alterna entre light e dark e persiste. */
  toggleTheme: () => Promise<void>;
  /** Define tema explicitamente e persiste. */
  setTheme: (isDark: boolean) => Promise<void>;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  // Valor inicial síncrono: lê o sistema agora, sem esperar SecureStore.
  // Evita o flash de modo claro ao abrir com o sistema em dark.
  isDark: getSystemIsDark(),

  initTheme: async () => {
    try {
      const saved = await SecureStore.getItemAsync(THEME_STORAGE_KEY);
      if (saved === 'dark' || saved === 'light') {
        // O usuário definiu uma preferência explícita → respeitar.
        set({ isDark: saved === 'dark' });
      } else {
        // Sem preferência salva → seguir o sistema (já setado no inicial,
        // mas relê para garantir consistência após possível mudança na inicialização).
        set({ isDark: getSystemIsDark() });
      }
    } catch {
      // SecureStore falhou → manter o valor do sistema.
      set({ isDark: getSystemIsDark() });
    }
  },

  toggleTheme: async () => {
    const current = useThemeStore.getState().isDark;
    const newValue = !current;
    await SecureStore.setItemAsync(THEME_STORAGE_KEY, newValue ? 'dark' : 'light');
    set({ isDark: newValue });
  },

  setTheme: async (isDark: boolean) => {
    await SecureStore.setItemAsync(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
    set({ isDark });
  },
}));

// ─── Listener de mudança do sistema ─────────────────────────────────────────
// Se o usuário NÃO definiu preferência explícita, o app acompanha o sistema
// em tempo real (ex.: modo automático do iOS ao pôr do sol).
Appearance.addChangeListener(({ colorScheme }) => {
  SecureStore.getItemAsync(THEME_STORAGE_KEY)
    .then((saved) => {
      if (saved !== 'dark' && saved !== 'light') {
        // Sem preferência explícita → seguir o sistema.
        useThemeStore.setState({ isDark: colorScheme === 'dark' });
      }
    })
    .catch(() => {
      // Silencioso — mantém o estado atual.
    });
});

export function useTheme() {
  const isDark = useThemeStore((state) => state.isDark);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const setTheme = useThemeStore((state) => state.setTheme);

  return { isDark, toggleTheme, setTheme };
}
