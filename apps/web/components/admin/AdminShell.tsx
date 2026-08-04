'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Shell for both admin surfaces.
 *
 * The colour band is deliberate. Super admin sees EVERY organisation's data;
 * org admin sees one. Confusing the two is how an operator suspends the wrong
 * tenant, so the two panels never look alike.
 */
export function AdminShell({
  scope,
  title,
  subtitle,
  nav,
  children,
  actions,
}: {
  scope: 'platform' | 'organisation';
  title: string;
  subtitle?: string;
  nav: { href: string; label: string }[];
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const pathname = usePathname();
  const isPlatform = scope === 'platform';

  return (
    <div className="min-h-full bg-gray-50">
      <div className={isPlatform ? 'bg-slate-900' : 'bg-brand-700'}>
        <div className="mx-auto max-w-7xl px-6 py-3">
          <div className="flex items-center gap-3">
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
                isPlatform ? 'bg-amber-400 text-slate-900' : 'bg-white/20 text-white'
              }`}
            >
              {isPlatform ? 'Platform admin' : 'Organisation admin'}
            </span>
            <span className="text-sm text-white/70">
              {isPlatform ? 'All organisations' : 'This organisation only'}
            </span>
            <Link href="/mail/f-inbox" className="ml-auto text-sm text-white/70 hover:text-white">
              Back to mail
            </Link>
          </div>
        </div>
      </div>

      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex flex-wrap items-center gap-4 py-5">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
              {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
            </div>
            {actions && <div className="ml-auto flex gap-2">{actions}</div>}
          </div>
          <nav className="flex gap-1 overflow-x-auto">
            {nav.map((n) => {
              const active = pathname === n.href;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition ${
                    active
                      ? 'border-brand-600 text-brand-700'
                      : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900'
                  }`}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}
