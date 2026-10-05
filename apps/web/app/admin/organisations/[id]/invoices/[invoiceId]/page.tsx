'use client';

import { useParams } from 'next/navigation';
import { useCallback } from 'react';
import { Button } from '@/components/ui/Kit';
import { InvoicePage } from '@/components/billing/InvoicePage';
import { useAuth } from '@/lib/auth';
import { fetchOperatorInvoice } from '@/lib/billing';

/** One invoice, as the operator sees it — the same document the customer gets. */
export default function OperatorInvoice() {
  const { authedFetch } = useAuth();
  const { id, invoiceId } = useParams<{ id: string; invoiceId: string }>();
  const load = useCallback(() => fetchOperatorInvoice(authedFetch, id, invoiceId), [authedFetch, id, invoiceId]);
  return <InvoicePage load={load} back={<Button href={`/admin/organisations/${id}`}>Back to the organisation</Button>} />;
}
