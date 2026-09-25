'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';

import { Spinner } from '@/components/ui/Kit';
import { closes, EMPLOYMENT, fetchCareers, type CareersList } from '@/lib/careers';

// ============================================================================
//  An organisation's public careers page — its open jobs (decision 0010 §1).
//
//  Public: no sign-in, outside every product shell. What it can show is only
//  what the API's public projection sends. Every "no" (unknown organisation,
//  page switched off, platform switch off) reads the same here as it does in
//  the API: "no careers page at this address".
// ============================================================================

export default function CareersPage({ params }: { params: Promise<{ site: string }> }) {
  const { site } = use(params);
  const [data, setData] = useState<CareersList | null | 'loading'>('loading');

  useEffect(() => {
    let alive = true;
    void fetchCareers(site).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [site]);

  if (data === 'loading') return <main className="flex min-h-screen items-center justify-center bg-canvas"><Spinner /></main>;

  if (data === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <div className="w-full max-w-md rounded-card border border-line bg-surface p-8 text-center shadow-raised">
          <h1 className="mb-2 text-lg font-semibold text-ink">There is no careers page at this address</h1>
          <p className="text-sm text-ink-muted">Check the link, or look for current openings on the organisation&apos;s own website.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-8">
          <p className="text-sm text-ink-muted">Careers</p>
          <h1 className="text-2xl font-semibold text-ink">{data.organisation}</h1>
        </header>

        {data.jobs.length === 0 ? (
          <div className="rounded-card border border-line bg-surface p-8 text-center">
            <p className="text-sm text-ink-muted">There are no open positions right now. Please check again later.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {data.jobs.map((j) => (
              <li key={j.slug}>
                <Link href={`/careers/${site}/${j.slug}`}
                      className="block rounded-card border border-line bg-surface p-5 transition-colors hover:border-brand-500">
                  <span className="block text-[15px] font-semibold text-ink">{j.title}</span>
                  <span className="mt-1 block text-sm text-ink-muted">
                    {[j.location, EMPLOYMENT[j.employmentType] ?? j.employmentType].filter(Boolean).join(' · ')}
                    {j.closingDate && <> · Apply by {closes(j.closingDate)}</>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-10 text-center text-xs text-ink-faint">Careers page by TatvaOS Hire</p>
      </div>
    </main>
  );
}
