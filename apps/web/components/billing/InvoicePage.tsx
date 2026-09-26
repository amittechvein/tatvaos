'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { InvoiceDocument } from '@/components/billing/InvoiceDocument';
import type { InvoiceDoc } from '@/lib/billing';

/**
 * An invoice on its own page, with Print. The print stylesheet shows only the
 * invoice (print:hidden on everything else), so "Save as PDF" from the
 * browser's print dialog gives the customer a clean document.
 */
export function InvoicePage({ load, back }: { load: () => Promise<InvoiceDoc>; back: React.ReactNode }) {
  const [inv, setInv] = useState<InvoiceDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { load().then(setInv).catch((e: Error) => setError(e.message)); }, [load]);

  return (
    <div className="min-h-screen bg-canvas px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-3xl items-center justify-between gap-2 print:hidden">
        {back}
        {inv && <Button variant="primary" onClick={() => window.print()}>Print or save as PDF</Button>}
      </div>
      {error && <div className="mx-auto max-w-3xl"><Alert tone="danger">{error}</Alert></div>}
      {inv && <InvoiceDocument inv={inv} />}
    </div>
  );
}
