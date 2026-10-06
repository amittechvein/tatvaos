'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { InvoiceDocument } from '@/components/billing/InvoiceDocument';
import type { InvoiceDoc } from '@/lib/billing';

/**
 * An invoice on its own page, with Print. The print stylesheet shows only the
 * invoice (print:hidden on everything else), so "Save as PDF" from the
 * browser's print dialog gives the customer a clean document.
 *
 * `actions` adds buttons beside Print (the customer's Pay now); `banner`
 * shows a message above the invoice (the result of a return from Razorpay).
 */
export function InvoicePage({ load, back, actions, banner, reloadKey = 0 }: {
  load: () => Promise<InvoiceDoc>;
  back: React.ReactNode;
  actions?: (inv: InvoiceDoc) => React.ReactNode;
  banner?: React.ReactNode;
  reloadKey?: number;
}) {
  const [inv, setInv] = useState<InvoiceDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchIt = useCallback(() => { load().then(setInv).catch((e: Error) => setError(e.message)); }, [load]);
  useEffect(() => { fetchIt(); }, [fetchIt, reloadKey]);

  return (
    <div className="min-h-screen bg-canvas px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-3xl flex-wrap items-center justify-between gap-2 print:hidden">
        {back}
        {inv && (
          <div className="flex flex-wrap gap-2">
            {actions?.(inv)}
            <Button onClick={() => window.print()}>Print or save as PDF</Button>
          </div>
        )}
      </div>
      {banner && <div className="mx-auto max-w-3xl print:hidden">{banner}</div>}
      {error && <div className="mx-auto max-w-3xl"><Alert tone="danger">{error}</Alert></div>}
      {inv && <InvoiceDocument inv={inv} />}
    </div>
  );
}
