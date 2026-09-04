import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { BuildBadge } from '@/components/BuildBadge';
import { RecoveryReminder } from '@/components/RecoveryReminder';
// YZEN's real stylesheet (licensed to Techvein) drives the console look. Order
// matters: our Tailwind/globals baseline first, then Bootstrap, then YZEN's
// styles.css last so its component rules win. Icon fonts (Tabler, RemixIcon)
// are free/open-source and loaded from their own CDNs in <head> below.
import '../styles/globals.css';
import '../styles/yzen/bootstrap.min.css';
import '../styles/yzen/styles.css';
// Loaded LAST: corrects the Tailwind/YZEN .grid collision (see overrides.css).
import '../styles/overrides.css';

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
  themeColor: '#03b562',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      dir="ltr"
      // YZEN reads these to activate its layout: a dark vertical menu over a
      // light page and light header — the default from their index.html.
      data-nav-layout="vertical"
      data-vertical-style="overlay"
      data-theme-mode="light"
      data-header-styles="light"
      data-menu-styles="dark"
      data-width="fullwidth"
      // Icons-only rail by default; it expands on hover (see Sidebar) and can be
      // pinned open from the header toggle. Client JS switches this to "close"
      // (off-canvas) on mobile widths.
      data-toggled="icon-overlay-close"
      suppressHydrationWarning
    >
      <head>
        {/* Free icon fonts YZEN's markup uses (ti = Tabler, ri = RemixIcon).
            Loaded from their own open-source CDNs, not from the theme. */}
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
        the chosen accent to build a MUI theme. MUI is gone — the console is
        Bootstrap and YZEN throughout — so the registry, its emotion cache and
        the six packages behind it have all been removed.
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
