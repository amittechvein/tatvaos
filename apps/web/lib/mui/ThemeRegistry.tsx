'use client';

import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { useMemo } from 'react';
import { useTheme as useAppearance } from '@/lib/theme';
import { buildTheme } from './theme';

/**
 * Wires MUI into the App Router.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  AppRouterCacheProvider is not optional.
 *
 *  MUI styles with Emotion, which generates CSS at runtime. Without this,
 *  the server sends markup with no styles attached and the browser paints an
 *  unstyled page for a beat before hydration catches up — on every navigation,
 *  not just the first. It collects Emotion's output during the server render
 *  and inlines it, so the first paint is already correct.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The theme is built once — the accent is fixed (YZEN's green) since the
 * appearance panel was removed. useMemo keeps createTheme from running on
 * unrelated re-renders.
 */
export function MuiRegistry({ children }: { children: React.ReactNode }) {
  const { mode } = useAppearance();
  // The accent is fixed now (YZEN's green, buildTheme's default) — the theme
  // is built once and only the mode class changes at runtime.
  const theme = useMemo(() => buildTheme(), []);

  // enableCssLayer is deliberately NOT set.
  //
  // It wraps every MUI style in `@layer mui`, and CSS layers always lose to
  // unlayered rules regardless of specificity — that is what layers are for.
  // Tailwind 3 compiles its own @layer directives away and emits plain
  // unlayered CSS, so with it enabled Tailwind's reset beat MUI's component
  // styles and the product rendered as unstyled text: inputs with no outline,
  // buttons with no fill.
  //
  // Only safe to turn on once Tailwind emits native layers (v4) and the order
  // is declared explicitly.
  return (
    <AppRouterCacheProvider options={{ key: 'mui' }}>
      <ThemeProvider theme={theme} defaultMode={mode} modeStorageKey="tatvaos.mui-mode">
        {/* Normalises browser defaults and applies the palette's background
            to <body>. enableColorScheme also tells the browser to render
            native controls — scrollbars, date pickers — in the right mode. */}
        <CssBaseline enableColorScheme />
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
