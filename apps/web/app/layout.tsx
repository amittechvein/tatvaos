import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { MuiRegistry } from '@/lib/mui/ThemeRegistry';
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
  themeColor: '#03b562',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
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
        Order matters. ThemeProvider holds the user's chosen accent and mode;
        MuiRegistry reads them to build the MUI theme. Reversing these means
        MUI mounts before the preference is known and the product repaints
        after load.
      */}
      <body className={`h-full ${inter.variable} ${inter.className}`}>
        <ThemeProvider>
          <MuiRegistry>
            <AuthProvider>{children}</AuthProvider>
          </MuiRegistry>
        </ThemeProvider>
      </body>
    </html>
  );
}
