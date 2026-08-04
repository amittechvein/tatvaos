import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { MuiRegistry } from '@/lib/mui/ThemeRegistry';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: 'TatvaOS Mail',
  description: 'Business email hosting',
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
      <body className="h-full">
        <ThemeProvider>
          <MuiRegistry>
            <AuthProvider>{children}</AuthProvider>
          </MuiRegistry>
        </ThemeProvider>
      </body>
    </html>
  );
}
