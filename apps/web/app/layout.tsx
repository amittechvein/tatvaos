import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { DesktopAlerts } from '@/components/DesktopAlerts';
import { RecoveryReminder } from '@/components/RecoveryReminder';
// ONE stylesheet. Until 16 Sept 2026 three more loaded after it — Bootstrap,
// YZEN's licensed theme, and an overrides file patching the collisions
// between them and Tailwind. Every card in the product rendered 48px of
// padding instead of 20px for a month because two frameworks agreed on the
// name px-5 and disagreed on the number. Stage 4 of docs/UI_LANE_BRIEF.md
// deleted them; the icon fonts (Tabler, RemixIcon) are free and stay.
import '../styles/globals.css';

// ---------------------------------------------------------------------------
//  Plus Jakarta Sans — the typeface the console's visual language is tuned
//  for. It is geometric and slightly condensed, which is what makes a dense
//  admin UI read as designed rather than defaulted; the previous Inter (and
//  before that, unstyled Segoe UI) is most of what read as "cheap".
//
//  The font files live in this repository (app/fonts/) and this stylesheet
//  only declares them: no request to Google at build time or at runtime.
//  Until 7 Oct 2026 next/font/google fetched them during `next build`, and a
//  failed fetch failed the build (CI red on 2 and 6 Oct, nothing at fault).
//  The header of the stylesheet says why it is not next/font/local (the ₹
//  sign). Its .app-font class still sets a variable called --font-inter so the
//  theme and globals that reference it keep working — one rename would
//  otherwise ripple through both. eslint.config.mjs refuses next/font/google.
// ---------------------------------------------------------------------------
import './fonts/plus-jakarta-sans.css';

export const metadata: Metadata = {
  title: 'TatvaOS',
  description: 'One identity, every product — mail, storage and people for Indian organisations.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#6C3CE9',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      dir="ltr"
      // The eight data-* attributes YZEN read to lay out its shell lived here
      // until 16 Sept 2026. The rail's state is React state in AppShell now,
      // and dark mode is the one .dark class ThemeProvider toggles.
      suppressHydrationWarning
    >
      <head>
        {/* Free icon fonts (ti = Tabler, ri = RemixIcon), loaded from their own
            open-source CDNs. 51 distinct icons across the app use them. */}
        <link rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.11.0/dist/tabler-icons.min.css" />
        <link rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/remixicon@4.3.0/fonts/remixicon.css" />
        {/* Machine-readable build stamp — lets a deploy be verified without
            reading the screen (document.querySelector('meta[name=x-build]')). */}
        <meta name="x-build" content={process.env.NEXT_PUBLIC_BUILD_SHA || 'unknown'} />
      </head>
      {/*
        AuthProvider wraps everything so the access token lives in one place,
        in memory, for the lifetime of the tab. Putting it lower down would
        mean a second copy for each subtree that needed it.
      */}
      {/*
        suppressHydrationWarning because ThemeProvider adds the .dark class and
        sets CSS variables on <html> as soon as it mounts. The server cannot
        know a preference stored in the browser, so that first attribute change
        is expected rather than a bug worth warning about.
      */}
      {/*
        MuiRegistry used to sit between ThemeProvider and AuthProvider, reading
        the chosen accent to build a MUI theme. MUI went first, then the
        Bootstrap/YZEN theme that replaced it; the console is Tailwind and
        components/ui throughout.
      */}
      <body className="h-full app-font">
        <ThemeProvider>
          {/* DesktopAlerts renders nothing. It is here rather than on the
              mail page so that alerts work wherever the person is — alerts
              that only run while you are looking at your inbox would be
              telling you what you can already see. */}
          <AuthProvider><RecoveryReminder /><DesktopAlerts />{children}</AuthProvider>
        </ThemeProvider>
        {/* THE BUILD STAMP IS NOT HERE ANY MORE — 23 September 2026.
            It sat on every page of every app, so a customer in Mail or a
            guest in a Connect room read a commit id in the corner of their
            screen. Amit asked for it gone from all pages and kept on the
            consoles, which is where somebody asks "did my deploy land?".
            It is rendered by app/admin/layout.tsx and app/org/layout.tsx.

            The machine-readable <meta name="x-build"> in the head above
            STAYS on every page: deploy.sh and verify-live.sh read it, and
            it is invisible to the person using the screen. */}
      </body>
    </html>
  );
}
