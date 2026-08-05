import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { MuiRegistry } from '@/lib/mui/ThemeRegistry';
import '../styles/globals.css';

// ---------------------------------------------------------------------------
//  The theme has named Inter since day one — and nothing ever LOADED it, so
//  the entire product rendered in Segoe UI. Most of what read as "cheap" was
//  this one missing import: the metrics, weights and spacing of the design
//  were tuned for a font that was never on the page.
//
//  next/font self-hosts it: no Google request at runtime, no layout shift,
//  and the file is subset and cached by the build.
// ---------------------------------------------------------------------------
const inter = Inter({
  subsets: ['latin'],
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
  themeColor: '#2145d6',
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
