'use client';

// ============================================================================
//  Theme
// ============================================================================
//
//  One job now: light/dark. The product's colour is the violet in
//  styles/globals.css, fixed at build time — the old runtime accent switcher
//  (and the browser-stored accent that came with it) is gone by decision:
//  one brand colour, no per-browser drift. Nothing recolours at runtime
//  except the mode.
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

    // One class, one dialect. Until 16 Sept 2026 three data-* attributes were
    // set beside it for YZEN's stylesheet, and they had to agree with static
    // copies in app/layout.tsx — this line won because it ran after hydration,
    // which is how a served page once said one thing and the browser another.
    // The tokens in globals.css switch on .dark; the rail follows them.
    root.classList.toggle('dark', mode === 'dark');

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
