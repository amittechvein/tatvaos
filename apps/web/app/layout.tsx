import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
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
      <body className="h-full">
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
