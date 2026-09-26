'use client';

import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import { Button } from '@/components/ui/Kit';
import { InvoicePage } from '@/components/billing/InvoicePage';
import { useAuth } from '@/lib/auth';
import { fetchMyInvoice } from '@/lib/billing';

/** One of this organisation's own invoices, printable. */
export default function MyInvoice() {
  const { authedFetch } = useAuth();
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const load = useCallback(() => fetchMyInvoice(authedFetch, invoiceId), [authedFetch, invoiceId]);
  return <InvoicePage load={load} back={<Button href="/org/billing">Back to billing</Button>} />;
}
