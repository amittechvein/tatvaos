'use client';

// ============================================================================
//  Theme
// ============================================================================
//
//  Drives the switcher panel. Writes CSS custom properties on <html>, which
//  every Tailwind colour class already points at — so one assignment recolours
//  the entire product in a single frame, with no rebuild and no flash.
//
//  Preferences are per browser, not per account. A customer's brand colour
//  belongs on their tenant and should follow them between devices; that is a
//  different feature and needs a column in core.tenants. This is the personal
//  layer on top: dark mode, sidebar width, and trying a colour out.
// ============================================================================

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';

export type ColorMode = 'light' | 'dark';
export type RailMode = 'expanded' | 'icons' | 'hidden';

// The defaults are named constants, not ACCENTS[0].hex. The project compiles
// with noUncheckedIndexedAccess, which — correctly — treats an array index as
// possibly undefined. Reaching for ! to silence that would be suppressing a
// real rule to save a line; naming the value says what it is and the arrays
// then reference it, so there is still one source of truth.
// Materio's violet. This is THE default accent and must match
// DEFAULT_PRIMARY in lib/mui/theme.ts — MUI builds its palette from whatever
// this resolves to, so two files disagreeing means the product ships in a
// colour neither of them names.
export const DEFAULT_ACCENT = '#7367f0';
export const DEFAULT_RAIL = '#1c1c2b';

/** Accent presets. The switcher also accepts any hex. */
export const ACCENTS: { name: string; hex: string }[] = [
  { name: 'Violet',  hex: DEFAULT_ACCENT },
  { name: 'Blue',    hex: '#3563f0' },
  { name: 'Teal',    hex: '#0ca5a5' },
  { name: 'Magenta', hex: '#a855f7' },
  { name: 'Green',   hex: '#22a35b' },
  { name: 'Coral',   hex: '#ef5455' },
];

/** Sidebar backgrounds. */
export const RAILS: { name: string; hex: string }[] = [
  { name: 'Charcoal', hex: DEFAULT_RAIL },
  { name: 'Navy',     hex: '#152449' },
  { name: 'Teal',     hex: '#0b3a45' },
  { name: 'Plum',     hex: '#331b46' },
  { name: 'Forest',   hex: '#12341f' },
  { name: 'Coffee',   hex: '#3a2416' },
];

interface Theme {
  mode: ColorMode;
  accent: string;
  rail: string;
  railMode: RailMode;
  setMode: (m: ColorMode) => void;
  setAccent: (hex: string) => void;
  setRail: (hex: string) => void;
  setRailMode: (m: RailMode) => void;
  toggleRail: () => void;
  reset: () => void;
}

const DEFAULTS = {
  mode: 'light' as ColorMode,
  accent: DEFAULT_ACCENT,
  rail: DEFAULT_RAIL,
  railMode: 'expanded' as RailMode,
};

const KEY = 'tatvaos.theme';
const ThemeContext = createContext<Theme | null>(null);

// ---------------------------------------------------------------------------
//  Colour maths
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/**
 * Builds a 50–900 ramp from one colour.
 *
 * Generated rather than hand-authored because the switcher accepts an
 * arbitrary hex — there is no opportunity to pick tints by eye. Tints go
 * toward white and shades toward a very dark neutral rather than pure black,
 * which keeps the hue recognisable instead of turning everything to mud.
 */
function ramp(hex: string): Record<string, string> {
  const [r, g, b] = hexToRgb(hex);
  const toward = (tr: number, tg: number, tb: number, t: number) =>
    `${mix(r, tr, t)} ${mix(g, tg, t)} ${mix(b, tb, t)}`;

  return {
    '--brand-50':  toward(255, 255, 255, 0.94),
    '--brand-100': toward(255, 255, 255, 0.86),
    '--brand-200': toward(255, 255, 255, 0.70),
    '--brand-300': toward(255, 255, 255, 0.50),
    '--brand-400': toward(255, 255, 255, 0.26),
    '--brand-500': `${r} ${g} ${b}`,
    '--brand-600': toward(24, 22, 46, 0.18),
    '--brand-700': toward(24, 22, 46, 0.36),
    '--brand-800': toward(24, 22, 46, 0.54),
    '--brand-900': toward(24, 22, 46, 0.70),
  };
}

function railVars(hex: string): Record<string, string> {
  const [r, g, b] = hexToRgb(hex);
  return {
    '--rail': `${r} ${g} ${b}`,
    // A lifted row, for hover and nested items. Toward white rather than a
    // fixed grey, so it stays in the same hue family as whatever was chosen.
    '--rail-soft': `${mix(r, 255, 0.08)} ${mix(g, 255, 0.08)} ${mix(b, 255, 0.08)}`,
  };
}

// ---------------------------------------------------------------------------

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(DEFAULTS.mode);
  const [accent, setAccentState] = useState(DEFAULTS.accent);
  const [rail, setRailState] = useState(DEFAULTS.rail);
  const [railMode, setRailModeState] = useState<RailMode>(DEFAULTS.railMode);

  // Read once on mount, not during render. localStorage does not exist on the
  // server, and reading it while rendering makes the first client paint differ
  // from the server's — React calls that a hydration mismatch and discards the
  // markup.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      if (saved.mode) setModeState(saved.mode);
      if (saved.accent) setAccentState(saved.accent);
      if (saved.rail) setRailState(saved.rail);
      if (saved.railMode) setRailModeState(saved.railMode);
    } catch {
      // Corrupt or blocked storage is not worth an error boundary. Defaults
      // are perfectly usable.
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    root.classList.toggle('dark', mode === 'dark');
    Object.entries(ramp(accent)).forEach(([k, v]) => root.style.setProperty(k, v));

    // In dark mode the rail matches the canvas, so a chosen rail colour is
    // ignored rather than producing a light stripe down a dark screen.
    if (mode === 'light') {
      Object.entries(railVars(rail)).forEach(([k, v]) => root.style.setProperty(k, v));
    } else {
      root.style.removeProperty('--rail');
      root.style.removeProperty('--rail-soft');
    }

    try {
      localStorage.setItem(KEY, JSON.stringify({ mode, accent, rail, railMode }));
    } catch { /* private browsing */ }
  }, [mode, accent, rail, railMode]);

  const toggleRail = useCallback(() => {
    setRailModeState((m) => (m === 'expanded' ? 'icons' : 'expanded'));
  }, []);

  const reset = useCallback(() => {
    setModeState(DEFAULTS.mode);
    setAccentState(DEFAULTS.accent);
    setRailState(DEFAULTS.rail);
    setRailModeState(DEFAULTS.railMode);
  }, []);

  const value = useMemo<Theme>(() => ({
    mode, accent, rail, railMode,
    setMode: setModeState,
    setAccent: setAccentState,
    setRail: setRailState,
    setRailMode: setRailModeState,
    toggleRail, reset,
  }), [mode, accent, rail, railMode, toggleRail, reset]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return ctx;
}
