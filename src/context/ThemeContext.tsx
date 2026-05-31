import React, { createContext, useContext, useEffect } from 'react';
import { useThemeStore } from '../hooks/useTheme';
import { Colors, ColorPalette } from '../constants/theme';

interface ThemeContextType {
  isDark: boolean;
  colors: ColorPalette;
  toggleTheme: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const isDark = useThemeStore((state) => state.isDark);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const initTheme = useThemeStore((state) => state.initTheme);

  // Load persisted theme preference on mount.
  // IMPORTANT: always render the Provider (never conditionally swap the tree
  // type) — changing Fragment→Provider causes full subtree remount which drops
  // native touch-responder registration on iOS.
  useEffect(() => {
    initTheme();
  }, [initTheme]);

  const colors: ColorPalette = isDark ? Colors.dark : Colors.light;

  return (
    <ThemeContext.Provider value={{ isDark, colors, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useColors(): ColorPalette {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    return Colors.light;
  }
  return context.colors;
}

export function useThemedColors() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useThemedColors must be used within ThemeProvider');
  }
  return context;
}
