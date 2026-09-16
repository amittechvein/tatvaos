'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Card, Empty, Stat, Table, Td } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Signups that stalled
// ============================================================================
//
//  A work list, not a report.
//
//  Requiring domain verification before console access loses customers — the
//  office manager trialling this at a school often cannot reach whoever manages
//  their DNS. This screen is what makes that trade acceptable: they are not
//  turned away, they are captured with a phone number and called.
//
//  If nobody works this queue, gating on verification is strictly worse than
//  letting people straight in.
// ============================================================================

interface Draft {
  id: string;
  orgName: string;
  orgType: string;
  country: string;
  adminName: string;
  adminEmail: string;
  adminPhone: string | null;
  fqdn: string | null;
  verificationMethod: string | null;
  attempts: number;
  reachedStep: number;
  lastAttemptError: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  stalledAtVerification: boolean;
  resumeUrl: string;
}

const STEP_LABEL: Record<number, string> = {
  1: 'Organisation',
  2: 'Their details',
  3: 'Domain',
  4: 'Verification',
};

export default function DraftsPage() {
  const { authedFetch } = useAuth();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [funnel, setFunnel] = useState({ open: 0, converted: 0, stalledAtVerification: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/admin/organisations/drafts');
      if (!res.ok) throw new Error('Could not load signups.');
      const body = await res.json();
      setDrafts(body.drafts ?? []);
      setFunnel(body.funnel ?? funnel);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load signups.');
    } finally {
      setLoading(false);
    }
    // funnel deliberately omitted — including it would re-run this on every
    // successful load, forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const rate = funnel.converted + funnel.open > 0
    ? Math.round((funnel.converted / (funnel.converted + funnel.open)) * 100)
    : 0;

  return (
    <AdminShell scope="platform" title="Signups in progress"
                subtitle="People who started and have not finished">
      {error && (
        <Alert tone="danger">{error}</Alert>
      )}

      <div className="mb-6 grid gap-6 sm:grid-cols-3">
        <Stat label="Open" caption="Started, not finished" value={String(funnel.open)} />
        <Stat label="Stuck on verification" caption="Tried and failed — call these"
              value={String(funnel.stalledAtVerification)} />
        <Stat label="Completed" caption={`${rate}% of everyone who started`}
              value={String(funnel.converted)} />
      </div>

      <Card padded={false}>
        {loading ? (
          <div className="grid place-items-center py-12">
            <span className="block h-7 w-7 animate-spin rounded-full border-2 border-line border-t-brand-600" />
          </div>
        ) : drafts.length === 0 ? (
          <Empty
            title="Nobody is mid-signup"
            hint="Anyone who starts and does not finish appears here with their contact details and the step they stopped at."
          />
        ) : (
          <Table head={['Organisation', 'Contact', 'Domain', 'Stopped at', 'Why', '']}>
            {drafts.map((d) => (
              <tr key={d.id}>
                <Td>
                  <div className="font-semibold">{d.orgName}</div>
                  <div className="text-[0.75rem] text-ink-muted capitalize">
                    {d.orgType} · {d.country}
                  </div>
                </Td>

                <Td>
                  <div>{d.adminName}</div>
                  {/* Both clickable. This screen exists to be acted on, and
                      making someone copy a number out of a table is friction
                      that turns a call into a maybe. */}
                  <a href={`mailto:${d.adminEmail}`} className="block text-[0.75rem] text-brand-500">
                    {d.adminEmail}
                  </a>
                  {d.adminPhone && (
                    <a href={`tel:${d.adminPhone.replace(/\s/g, '')}`}
                       className="block text-[0.75rem] font-semibold text-brand-500">
                      {d.adminPhone}
                    </a>
                  )}
                </Td>

                <Td>
                  {d.fqdn
                    ? <div style={{ wordBreak: 'break-all' }}>{d.fqdn}</div>
                    : <div className="text-[0.75rem] text-ink-muted">not reached</div>}
                  {d.verificationMethod && (
                    <div className="text-[0.75rem] text-ink-muted uppercase">
                      via {d.verificationMethod}
                    </div>
                  )}
                </Td>

                <Td>
                  <Badge tone={d.stalledAtVerification ? 'warn' : 'neutral'}>
                    {STEP_LABEL[d.reachedStep] ?? d.reachedStep}
                  </Badge>
                  {d.attempts > 0 && (
                    <div className="text-[0.75rem] text-ink-muted mt-1">
                      {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                    </div>
                  )}
                </Td>

                <Td>
                  {/* The verifier's own words, unedited. This is what you read
                      aloud on the phone — a friendlier summary would remove the
                      only part that identifies the mistake. */}
                  <div className="text-[0.75rem] text-ink-muted" style={{ maxWidth: 320, lineHeight: 1.5 }}>
                    {d.lastAttemptError ?? '—'}
                  </div>
                </Td>

                <Td>
                  <a href={d.resumeUrl} target="_blank" rel="noopener" className="text-brand-500">
                    Open their signup
                  </a>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Alert tone="info" className="mt-6">
        <strong>This queue is the point.</strong> Requiring domain verification
        before sign-in loses customers who cannot reach whoever manages their DNS.
        These are those customers, with a phone number. Working the list is what
        makes that trade-off worth making — leaving it unworked makes it a worse
        design than letting people straight in.
      </Alert>
    </AdminShell>
  );
}
