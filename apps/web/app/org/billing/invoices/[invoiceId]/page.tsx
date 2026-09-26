'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { InvoicePage } from '@/components/billing/InvoicePage';
import { useAuth } from '@/lib/auth';
import { confirmPayment, fetchMyInvoice, payInvoice } from '@/lib/billing';

// ============================================================================
//  One of this organisation's invoices, printable, with Pay now (billing
//  part 2: online only, through Razorpay).
//
//  Razorpay sends the customer back HERE with its result in the query string.
//  That result is checked by the API (signature, and that it is this
//  invoice's link) before anything is recorded; what the page shows is what
//  the API then says. If the check cannot be made, the page says the payment
//  will appear once Razorpay's own notice arrives — which it does, separately.
// ============================================================================

function MyInvoice() {
  const { authedFetch } = useAuth();
  const router = useRouter();
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const query = useSearchParams();
  const load = useCallback(() => fetchMyInvoice(authedFetch, invoiceId), [authedFetch, invoiceId]);
  const [paying, setPaying] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || !query.get('razorpay_payment_link_status')) return;
    handled.current = true;
    const status = query.get('razorpay_payment_link_status');
    (async () => {
      if (status === 'paid') {
        try {
          await confirmPayment(authedFetch, invoiceId, new URLSearchParams(query.toString()));
          setBanner({ tone: 'ok', text: 'Payment received. Thank you. This invoice is now marked paid.' });
        } catch {
          setBanner({ tone: 'warn', text: 'Razorpay says the payment went through. It will show as paid here as soon as Razorpay confirms it to us, usually within a minute.' });
        }
      } else {
        setBanner({ tone: 'danger', text: 'The payment was not completed. Nothing was charged. You can try again with Pay now.' });
      }
      setReloadKey((k) => k + 1);
      // Drop Razorpay's parameters so a refresh does not replay them.
      router.replace(`/org/billing/invoices/${invoiceId}`);
    })();
  }, [authedFetch, invoiceId, query, router]);

  async function pay() {
    setPaying(true);
    setBanner(null);
    try {
      window.location.href = await payInvoice(authedFetch, invoiceId);
    } catch (e) {
      setBanner({ tone: 'danger', text: e instanceof Error ? e.message : 'Online payment is not available right now.' });
      setPaying(false);
    }
  }

  return (
    <InvoicePage
      load={load}
      reloadKey={reloadKey}
      back={<Button href="/org/billing">Back to billing</Button>}
      banner={banner && <Alert tone={banner.tone}>{banner.text}</Alert>}
      actions={(inv) => inv.status === 'issued' && (
        <Button variant="primary" onClick={pay} disabled={paying}>
          {paying ? 'Opening Razorpay…' : `Pay now`}
        </Button>
      )}
    />
  );
}

export default function Page() {
  // useSearchParams needs a Suspense boundary in the app router.
  return <Suspense fallback={null}><MyInvoice /></Suspense>;
}
