'use client';

// ============================================================================
//  Theme
// ============================================================================
//
//  One job now: light/dark. The product's colour is YZEN's green, fixed at
//  build time — the old runtime accent switcher (and the browser-stored accent
//  that came with it) is gone by decision: one licensed template, one brand
//  colour, no per-browser drift. The green ramp lives statically in
//  styles/globals.css; nothing recolours at runtime except the mode.
//
//  Mode is still per browser: it is a device preference (a dark room, a bright
//  office), not an identity setting, so localStorage is the right home.
// ============================================================================

import {
  createContext, useContext, useEffect, useMemo, useState,
} from 'react';

export type ColorMode = 'light' | 'dark';

interface Theme {
  mode: ColorMode;
  setMode: (m: ColorMode) => void;
}

// Same key as the old theme object on purpose: reading it finds an existing
// {mode, accent, rail, ...} blob and takes only the mode; the next write
// replaces the blob with {mode} alone, which is how the stored orange accent
// from the switcher era gets purged from every browser that had one.
const KEY = 'tatvaos.theme';
const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ColorMode>('light');

  // Read once on mount, not during render. localStorage does not exist on the
  // server, and reading it while rendering makes the first client paint differ
  // from the server's — React calls that a hydration mismatch and discards the
  // markup.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      if (saved.mode === 'dark' || saved.mode === 'light') setMode(saved.mode);
    } catch {
      // Corrupt or blocked storage is not worth an error boundary.
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    // Both styling systems read the mode, each in its own dialect: Tailwind
    // (the Mail client) matches on the .dark class, YZEN's stylesheet matches
    // on data-theme-mode / data-header-styles. Setting them together is what
    // keeps one toggle honest across both.
    root.classList.toggle('dark', mode === 'dark');
    root.dataset.themeMode = mode;
    root.dataset.headerStyles = mode;
    // The rail is dark in both modes — YZEN's default and ours.
    root.dataset.menuStyles = 'dark';

    try {
      localStorage.setItem(KEY, JSON.stringify({ mode }));
    } catch { /* private browsing */ }
  }, [mode]);

  const value = useMemo<Theme>(() => ({ mode, setMode }), [mode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return ctx;
}
