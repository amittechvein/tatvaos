'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Alert } from '@/components/ui/Page';

// ============================================================================
//  The organisation's own view of its plan warnings (Amit, 26 Sept 2026:
//  "warn first"). Renders NOTHING unless the operator has switched client
//  warnings on (platform setting plans.warn_clients, off by default) — the
//  API answers enabled:false and an empty list until then.
//
//  The wording is customer-facing, so it is Amit's and the CTO's to approve
//  before the setting is turned on.
// ============================================================================

interface Warning { code: string; level: 'not_in_plan' | 'over' | 'near'; message: string }

export function PlanWarningsNotice() {
  const { authedFetch } = useAuth();
  const [warnings, setWarnings] = useState<Warning[]>([]);

  useEffect(() => {
    authedFetch('/org/plan-warnings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWarnings(d?.enabled ? d.warnings : []))
      .catch(() => setWarnings([]));
  }, [authedFetch]);

  if (warnings.length === 0) return null;

  return (
    <Alert tone="warn" title="Your plan" className="mb-6">
      <p className="mb-2">
        Your organisation is using more than its plan includes. Nothing has been switched off.
        To add these to your plan, contact Techvein.
      </p>
      <ul className="list-disc space-y-0.5 pl-5">
        {warnings.map((w) => <li key={`${w.code}-${w.level}`}>{w.message}</li>)}
      </ul>
    </Alert>
  );
}
