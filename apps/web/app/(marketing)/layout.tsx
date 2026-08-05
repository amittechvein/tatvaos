import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'TatvaOS — one identity, every product',
  description:
    'Business email and identity for Indian organisations. One sign-in across '
    + 'Mail, Drive and Payroll. Hosted in India, isolated by the database.',
};

/**
 * A route group, so the marketing pages sit outside the app shell without
 * appearing in the URL. `(marketing)` is not a path segment — the landing page
 * is still `/`.
 *
 * Deliberately has no AppShell and no RequireAuth. This is the one part of the
 * product a stranger sees, and wrapping it in an authenticated layout is how a
 * landing page ends up redirecting visitors to a login screen.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
