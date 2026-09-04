'use client';

// ============================================================================
//  /mail/filters — kept as a route because the message ⋮ menu links here with
//  ?from=<address> to prefill a new rule. The screen itself is now assembled
//  from the same panels the Settings tabs use, so there is one implementation
//  of filters and one of blocking, not two that drift.
// ============================================================================

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { FiltersPanel } from '@/components/mail/FiltersPanel';
import { BlockedPanel } from '@/components/mail/BlockedPanel';

export default function FiltersPage() {
  // useSearchParams needs a Suspense boundary in the App Router; without one
  // the whole route opts out of static rendering.
  return (
    <Suspense fallback={<p className="p-6 text-sm text-ink-faint">Loading…</p>}>
      <FiltersRoute />
    </Suspense>
  );
}

function FiltersRoute() {
  const prefillFrom = useSearchParams().get('from');
  return (
    <div className="scroll-thin h-full overflow-y-auto p-6">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-ink">Filters and blocked senders</h1>
          <p className="text-sm text-ink-muted">
            Also available under Mail settings.
          </p>
        </div>
        <Link href="/mail/inbox" className="text-sm font-medium text-brand-600 hover:underline">
          Back to inbox
        </Link>
        <Link href="/mail/settings" className="text-sm font-medium text-brand-600 hover:underline">
          All settings
        </Link>
      </header>

      <FiltersPanel prefillFrom={prefillFrom} />
      <div className="mt-8">
        <BlockedPanel />
      </div>
    </div>
  );
}
