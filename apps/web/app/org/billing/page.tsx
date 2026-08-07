'use client';

import { ComingSoon } from '@/components/ui/ComingSoon';

export default function OrgBillingPage() {
  return (
    <ComingSoon
      scope="organisation"
      title="Billing"
      blurb="Your subscription, invoices and payment method will live here once billing goes live. Your current plan already shows in the platform console."
    />
  );
}
