'use client';

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

import { AdminShell } from '@/components/admin/AdminShell';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Domains
// ============================================================================
//
//  The screen a customer reaches when they want their own address instead of
//  the subdomain we issued them.
//
//  Two things it has to get right. It must never imply their existing mail is
//  at risk — it isn't, until they move MX — and when a check fails it must say
//  what is actually wrong, because the person reading it usually has to relay
//  it to whoever manages their DNS.
// ============================================================================

interface DnsRecord {
  type: string; host: string; value: string; purpose: string; required: boolean;
}

interface Check {
  id: string; label: string; passed: boolean; detail: string; required: boolean;
}

interface DomainRow {
  id: string;
  fqdn: string;
  isActive: boolean;
  isPlatform: boolean;
  ownershipVerified: boolean;
  lastCheckedAt: string | null;
  lastCheckResult: string | null;
}

/** Which verification check a DNS record belongs to. The API returns them as
 *  two lists with different keys, so the pairing is by shape — stable because
 *  both lists are built from the same DomainVerifier. */
function checkFor(checks: Check[], r: DnsRecord, index: number): Check | undefined {
  const byId = (id: string) => checks.find((c) => c.id === id);
  if (r.type === 'MX') return byId('mx');
  if (r.host.includes('_dmarc')) return byId('dmarc');
  if (r.host.includes('_domainkey')) return byId('dkim');
  if (r.value.startsWith('v=spf1')) return byId('spf');
  if (r.value.startsWith('tatvaos-verification=')) return byId('ownership');
  return checks[index];
}

/** A labelled monospace value with a copy button — the unit DNS admins want. */
function CopyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Box>
      <Typography variant="caption" color="text.disabled"
                  sx={{ display: 'block', mb: 0.25, fontWeight: 600,
                        letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: 10 }}>
        {label}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'stretch' }}>
        <Box sx={{ flex: 1, p: 1, borderRadius: 1.5, minWidth: 0,
                   fontFamily: mono ? 'monospace' : undefined, fontSize: 13,
                   wordBreak: 'break-all', bgcolor: 'background.default',
                   display: 'flex', alignItems: 'center' }}>
          {value}
        </Box>
        <Tooltip title="Copy">
          <IconButton size="small" onClick={() => void navigator.clipboard.writeText(value)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 012-2h10" />
            </svg>
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

export default function DomainsPage() {
  const { authedFetch } = useAuth();

  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newFqdn, setNewFqdn] = useState('');
  const [busy, setBusy] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [checking, setChecking] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch('/org/domains');
      if (!res.ok) throw new Error('Could not load domains.');
      setDomains(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load domains.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function addDomain() {
    setBusy(true);
    try {
      const res = await authedFetch('/org/domains', {
        method: 'POST',
        body: JSON.stringify({ fqdn: newFqdn.trim().toLowerCase() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not add that domain.');

      setAdding(false);
      setNewFqdn('');
      await load();

      // Straight into the checklist. Adding a domain is never the goal —
      // publishing the records is, and a screen that congratulates them and
      // stops leaves them to find the next step themselves.
      setRecords(body.records ?? []);
      setChecks([]);
      setSummary(null);
      setOpenId(body.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that domain.');
    } finally {
      setBusy(false);
    }
  }

  async function openDomain(id: string) {
    setOpenId(id);
    setChecks([]);
    setSummary(null);
    const res = await authedFetch(`/org/domains/${id}`);
    if (res.ok) {
      const body = await res.json();
      setRecords(body.records ?? []);
    }
  }

  async function verify(id: string) {
    setChecking(true);
    try {
      const res = await authedFetch(`/org/domains/${id}/verify`, { method: 'POST' });
      const body = await res.json();
      setChecks(body.checks ?? []);
      setSummary(body.summary ?? null);
      setRecords(body.records ?? records);
      await load();
    } finally {
      setChecking(false);
    }
  }

  const open = domains.find((d) => d.id === openId);

  return (
    <AdminShell
      scope="organisation"
      title="Domains"
      subtitle="Addresses your organisation sends and receives on"
      actions={
        <Button variant="contained" onClick={() => setAdding(true)}>Add domain</Button>
      }
    >
      {error && <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
      ) : (
        <Stack spacing={2}>
          {domains.map((d) => (
            <Card key={d.id}>
              <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="h6" sx={{ wordBreak: 'break-all' }}>{d.fqdn}</Typography>

                    {d.isPlatform ? (
                      <Chip size="small" color="primary" label="TatvaOS address" />
                    ) : d.ownershipVerified ? (
                      <Chip size="small" color="success" label="Verified" />
                    ) : (
                      <Chip size="small" color="warning" label="Not verified" />
                    )}
                  </Box>

                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {d.isPlatform
                      ? 'Issued by us and working immediately. Cannot be removed — it is how you sign in if your own domain’s DNS ever breaks.'
                      : d.ownershipVerified
                        ? d.lastCheckResult ?? 'Ownership proven.'
                        : 'Not accepting mail yet. Publish the ownership record, then check again.'}
                  </Typography>
                </Box>

                {!d.isPlatform && (
                  <Button variant="outlined" onClick={() => openDomain(d.id)}>
                    {d.ownershipVerified ? 'DNS records' : 'Set up'}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}

          {domains.length === 0 && (
            <Card><CardContent>
              <Typography>No domains yet.</Typography>
            </CardContent></Card>
          )}
        </Stack>
      )}

      <Alert severity="info" sx={{ mt: 3 }}>
        Adding a domain changes nothing about your existing mail. It keeps arriving
        wherever it does today until <strong>you</strong> move the MX record — and
        that step is reversible.
      </Alert>

      {/* ---------------------------------------------------------------- */}
      <Dialog open={adding} onClose={() => setAdding(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add a domain</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
            The domain your organisation&apos;s email addresses use. You will be asked
            to publish a record proving you control it.
          </Typography>
          <TextField
            autoFocus fullWidth label="Domain" placeholder="abcschool.edu.in"
            value={newFqdn} onChange={(e) => setNewFqdn(e.target.value)}
            slotProps={{ htmlInput: { autoCapitalize: 'none', spellCheck: false } }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="contained" onClick={addDomain} disabled={busy || newFqdn.trim().length < 4}>
            {busy ? 'Adding…' : 'Add domain'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---------------------------------------------------------------- */}
      <Dialog open={!!openId} onClose={() => setOpenId(null)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ pb: 1 }}>
          {open?.fqdn}
          <Typography variant="body2" color="text.secondary">
            Add these to your DNS, then check again.
          </Typography>
        </DialogTitle>

        <DialogContent>
          {summary && (
            <Alert severity={checks.find((c) => c.id === 'ownership')?.passed ? 'success' : 'warning'}
                   sx={{ mb: 2.5 }}>
              {summary}
            </Alert>
          )}

          {/* ------------------------------------------------------------
              One CARD per concern, pairing the check with its record.

              The previous layout was two lists — statuses at the top,
              records at the bottom — which made the reader match "Signing
              key: no key found" to the right record by eye, scrolling
              between them. Anyone relaying this to whoever manages their
              DNS wants one self-contained block per record: what it is,
              whether it passes, and exactly what to paste where.
             ------------------------------------------------------------ */}
          <Stack spacing={2}>
            {records.map((r, i) => {
              const check = checkFor(checks, r, i);
              const state: 'passed' | 'required' | 'optional' =
                check?.passed ? 'passed' : r.required ? 'required' : 'optional';

              return (
                <Card key={`${r.type}-${r.host}-${i}`} variant="outlined"
                      sx={{
                        boxShadow: 'none',
                        borderColor: (t) =>
                          state === 'passed' ? alpha(t.palette.success.main, 0.4)
                            : state === 'required' ? alpha(t.palette.error.main, 0.4)
                              : t.palette.divider,
                        borderLeft: '4px solid',
                        borderLeftColor: state === 'passed' ? 'success.main'
                          : state === 'required' ? 'error.main' : 'warning.main',
                      }}>
                  <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                    {/* Header: status + name + badges */}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 0.75 }}>
                      <Box sx={{ display: 'grid', placeItems: 'center', width: 26, height: 26,
                                 borderRadius: '50%', flexShrink: 0, color: '#fff',
                                 bgcolor: state === 'passed' ? 'success.main'
                                   : state === 'required' ? 'error.main' : 'warning.main' }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
                             strokeLinejoin="round">
                          {state === 'passed'
                            ? <path d="M20 6L9 17l-5-5" />
                            : <path d="M12 7v6m0 4h.01" />}
                        </svg>
                      </Box>

                      <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1 }} noWrap>
                        {check?.label ?? r.purpose.split('.')[0]}
                      </Typography>

                      <Chip label={r.type} size="small" sx={{ fontFamily: 'monospace' }} />
                      {check?.passed
                        ? <Chip label="verified" size="small" color="success" />
                        : r.required
                          ? <Chip label="required" size="small" color="error" variant="outlined" />
                          : <Chip label="optional" size="small" variant="outlined" />}
                    </Box>

                    {/* The server's own words when a check ran; the record's
                        purpose otherwise. "NXDOMAIN looking up TXT" tells a
                        DNS admin far more than a friendlier rewrite would. */}
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                      {check && !check.passed ? check.detail : r.purpose}
                    </Typography>

                    {/* The record itself — verified ones collapse it, since a
                        record already found in DNS needs no copying. */}
                    {!check?.passed && (
                      <Box sx={{ display: 'grid', gap: 1,
                                 gridTemplateColumns: { xs: '1fr', sm: '160px 1fr' } }}>
                        <CopyField label="Host / Name" value={r.host} mono />
                        <CopyField label="Value" value={r.value} mono />
                      </Box>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </Stack>

          <Typography variant="caption" color="text.disabled"
                      sx={{ display: 'block', mt: 3, lineHeight: 1.7 }}>
            DNS changes usually appear within minutes but can take up to an hour.
            If a check fails right after you add a record, wait and try again before
            changing anything.
          </Typography>
        </DialogContent>

        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setOpenId(null)}>Close</Button>
          <Button variant="contained" onClick={() => openId && verify(openId)} disabled={checking}>
            {checking ? 'Checking DNS…' : 'Check again'}
          </Button>
        </DialogActions>
      </Dialog>
    </AdminShell>
  );
}
