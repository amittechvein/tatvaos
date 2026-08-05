'use client';

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import { AdminShell } from '@/components/admin/AdminShell';
import { Card, Empty, Stat, Table, Td } from '@/components/ui/Kit';
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
      {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}

      <Box sx={{ display: 'grid', gap: 2, mb: 3,
                 gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' } }}>
        <Stat label="Open" caption="Started, not finished" value={String(funnel.open)} />
        <Stat label="Stuck on verification" caption="Tried and failed — call these"
              value={String(funnel.stalledAtVerification)} />
        <Stat label="Completed" caption={`${rate}% of everyone who started`}
              value={String(funnel.converted)} />
      </Box>

      <Card padded={false}>
        {loading ? (
          <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
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
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{d.orgName}</Typography>
                  <Typography variant="caption" color="text.secondary"
                              sx={{ textTransform: 'capitalize' }}>
                    {d.orgType} · {d.country}
                  </Typography>
                </Td>

                <Td>
                  <Typography variant="body2">{d.adminName}</Typography>
                  {/* Both clickable. This screen exists to be acted on, and
                      making someone copy a number out of a table is friction
                      that turns a call into a maybe. */}
                  <Link href={`mailto:${d.adminEmail}`} variant="caption"
                        sx={{ display: 'block' }}>
                    {d.adminEmail}
                  </Link>
                  {d.adminPhone && (
                    <Link href={`tel:${d.adminPhone.replace(/\s/g, '')}`} variant="caption"
                          sx={{ display: 'block', fontWeight: 600 }}>
                      {d.adminPhone}
                    </Link>
                  )}
                </Td>

                <Td>
                  {d.fqdn
                    ? <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{d.fqdn}</Typography>
                    : <Typography variant="caption" color="text.disabled">not reached</Typography>}
                  {d.verificationMethod && (
                    <Typography variant="caption" color="text.secondary"
                                sx={{ display: 'block', textTransform: 'uppercase' }}>
                      via {d.verificationMethod}
                    </Typography>
                  )}
                </Td>

                <Td>
                  <Chip size="small"
                        color={d.stalledAtVerification ? 'warning' : 'default'}
                        label={STEP_LABEL[d.reachedStep] ?? d.reachedStep} />
                  {d.attempts > 0 && (
                    <Typography variant="caption" color="text.secondary"
                                sx={{ display: 'block', mt: 0.5 }}>
                      {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                    </Typography>
                  )}
                </Td>

                <Td>
                  {/* The verifier's own words, unedited. This is what you read
                      aloud on the phone — a friendlier summary would remove the
                      only part that identifies the mistake. */}
                  <Typography variant="caption" color="text.secondary"
                              sx={{ display: 'block', maxWidth: 320, lineHeight: 1.5 }}>
                    {d.lastAttemptError ?? '—'}
                  </Typography>
                </Td>

                <Td>
                  <Link href={d.resumeUrl} target="_blank" rel="noopener" variant="body2">
                    Open their signup
                  </Link>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Alert severity="info" sx={{ mt: 3 }}>
        <strong>This queue is the point.</strong> Requiring domain verification
        before sign-in loses customers who cannot reach whoever manages their DNS.
        These are those customers, with a phone number. Working the list is what
        makes that trade-off worth making — leaving it unworked makes it a worse
        design than letting people straight in.
      </Alert>
    </AdminShell>
  );
}
