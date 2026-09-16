import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { BuildBadge } from '@/components/BuildBadge';
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
//  next/font self-hosts it: no Google request at runtime, no layout shift,
//  and the file is subset and cached by the build. The CSS variable is still
//  called --font-inter so the theme and globals that reference it keep
//  working — one rename would otherwise ripple through both.
// ---------------------------------------------------------------------------
const inter = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-inter',
});

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
      <body className={`h-full ${inter.variable} ${inter.className}`}>
        <ThemeProvider>
          <AuthProvider><RecoveryReminder />{children}</AuthProvider>
        </ThemeProvider>
        {/* Outside the providers on purpose: the version must still render
            even if a provider below it throws. */}
        <BuildBadge />
      </body>
    </html>
  );
}
