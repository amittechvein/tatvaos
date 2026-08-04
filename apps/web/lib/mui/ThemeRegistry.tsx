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
 * The theme is rebuilt when the accent changes, which is why the appearance
 * panel can recolour the product live. createTheme is cheap; useMemo stops it
 * running on unrelated re-renders.
 */
export function MuiRegistry({ children }: { children: React.ReactNode }) {
  const { accent, mode } = useAppearance();
  const theme = useMemo(() => buildTheme(accent), [accent]);

  return (
    <AppRouterCacheProvider options={{ key: 'mui', enableCssLayer: true }}>
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
