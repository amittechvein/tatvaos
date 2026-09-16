'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

/** A pill in the brand colour. Badge's tones are the status set (ok, warn,
 *  danger, info, neutral) and "this address is ours" is not a status. */
function BrandPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-brand-500/10 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
      {children}
    </span>
  );
}

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

/**
 * A labelled monospace value with a copy button — the unit DNS admins want.
 *
 * The button confirms in place for a moment after copying. Without that there
 * is no way to tell a successful copy from a click that missed, and the usual
 * result is pasting whatever was on the clipboard before.
 */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* Clipboard blocked — the value is on screen and selectable anyway. */
    }
  }

  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      <div className="flex items-stretch gap-1">
        <div className="flex min-w-0 flex-1 items-center break-all rounded-lg bg-canvas p-2 font-mono text-[13px] text-ink">
          {value}
        </div>
        <button
          type="button"
          onClick={() => void copy()}
          title={copied ? 'Copied' : 'Copy'}
          aria-label={copied ? 'Copied' : `Copy ${label}`}
          className={`shrink-0 rounded-lg border border-line px-2 transition ${
            copied ? 'text-ok' : 'text-ink-muted hover:bg-canvas hover:text-ink'
          }`}
        >
          {copied ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 012-2h10" />
            </svg>
          )}
        </button>
      </div>
    </div>
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
  const ownershipPassed = checks.find((c) => c.id === 'ownership')?.passed;

  return (
    <AdminShell
      scope="organisation"
      title="Domains"
      subtitle="Addresses your organisation sends and receives on"
      actions={<Button variant="primary" onClick={() => setAdding(true)}>Add domain</Button>}
    >
      {error && (
        <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>
      )}

      {loading ? (
        <div className="grid place-items-center !py-[3rem]">
          <span className="block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
        </div>
      ) : (
        <div className="grid !gap-[1rem]">
          {domains.map((d) => (
            <div className="rounded-card border border-line bg-surface !p-[1rem] !flex !items-center !gap-[1rem] flex-wrap" key={d.id}>
                <div className="min-w-0 !flex-auto">
                  <div className="!flex !items-center gap-2 flex-wrap">
                    <h6 className="!font-semibold mb-0" style={{ wordBreak: 'break-all' }}>{d.fqdn}</h6>

                    {d.isPlatform ? (
                      <BrandPill>TatvaOS address</BrandPill>
                    ) : d.ownershipVerified ? (
                      <Badge tone="ok">Verified</Badge>
                    ) : (
                      <Badge tone="warn">Not verified</Badge>
                    )}
                  </div>

                  <p className="!text-[0.8125rem] !text-ink-muted mb-0 mt-1">
                    {d.isPlatform
                      ? 'Issued by us and working immediately. Cannot be removed — it is how you sign in if your own domain’s DNS ever breaks.'
                      : d.ownershipVerified
                        ? d.lastCheckResult ?? 'Ownership proven.'
                        : 'Not accepting mail yet. Publish the ownership record, then check again.'}
                  </p>
                </div>

                {!d.isPlatform && (
                  <Button variant="secondary" onClick={() => openDomain(d.id)}>
                    {d.ownershipVerified ? 'DNS records' : 'Set up'}
                  </Button>
                )}
            </div>
          ))}

          {domains.length === 0 && (
            <div className="rounded-card border border-line bg-surface !p-[1rem]">No domains yet.</div>
          )}
        </div>
      )}

      <Alert tone="info" className="!mt-[1.5rem]">
        Adding a domain changes nothing about your existing mail. It keeps arriving
        wherever it does today until <strong>you</strong> move the MX record — and
        that step is reversible.
      </Alert>

      {/* ---------------------------------------------------------------- */}
      {adding && (
        <Modal
          title="Add a domain"
          onClose={() => setAdding(false)}
          busy={busy}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button variant="primary" onClick={addDomain}
                      disabled={busy || newFqdn.trim().length < 4}>
                {busy ? 'Adding…' : 'Add domain'}
              </Button>
            </>
          }
        >
          <p className="!text-[0.8125rem] !text-ink-muted">
            The domain your organisation&apos;s email addresses use. You will be asked
            to publish a record proving you control it.
          </p>
          <Field label="Domain">
            <Input
               autoFocus placeholder="abcschool.edu.in"
              autoCapitalize="none" spellCheck={false}
              value={newFqdn} onChange={(e) => setNewFqdn(e.target.value)}
            />
          </Field>
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {openId && (
        <Modal
          title={open?.fqdn ?? 'DNS records'}
          subtitle="Add these to your DNS, then check again."
          size="lg"
          onClose={() => setOpenId(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>
              <Button variant="primary" onClick={() => openId && verify(openId)} disabled={checking}>
                {checking ? 'Checking DNS…' : 'Check again'}
              </Button>
            </>
          }
        >
          {summary && (
            <Alert tone={ownershipPassed ? 'ok' : 'warn'}>{summary}</Alert>
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
          <div className="grid !gap-[1rem]">
            {records.map((r, i) => {
              const check = checkFor(checks, r, i);
              const state: 'passed' | 'required' | 'optional' =
                check?.passed ? 'passed' : r.required ? 'required' : 'optional';
              const edge = state === 'passed' ? '#53c405' : state === 'required' ? '#fd4963' : '#ffa909';

              return (
                <div
                  key={`${r.type}-${r.host}-${i}`}
                  className="rounded-card border border-line bg-surface !p-[1rem]"
                  style={{ borderInlineStartWidth: 4, borderInlineStartColor: edge }}
                >
                  {/* Header: status + name + badges */}
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full text-white"
                      style={{ background: edge }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
                           strokeLinejoin="round">
                        {state === 'passed'
                          ? <path d="M20 6L9 17l-5-5" />
                          : <path d="M12 7v6m0 4h.01" />}
                      </svg>
                    </span>

                    <span className="flex-1 truncate font-bold text-ink">
                      {check?.label ?? r.purpose.split('.')[0]}
                    </span>

                    <span className="inline-flex items-center rounded-full border border-line bg-canvas px-2.5 py-0.5 !font-mono text-xs font-semibold text-ink-muted">
                      {r.type}
                    </span>
                    {check?.passed
                      ? <Badge tone="ok">verified</Badge>
                      : r.required
                        ? <Badge tone="danger">required</Badge>
                        : <Badge tone="neutral">optional</Badge>}
                  </div>

                  {/* The server's own words when a check ran; the record's
                      purpose otherwise. "NXDOMAIN looking up TXT" tells a
                      DNS admin far more than a friendlier rewrite would. */}
                  <p className="!mb-[1rem] text-[13px] text-ink-muted">
                    {check && !check.passed ? check.detail : r.purpose}
                  </p>

                  {/* The record itself — verified ones collapse it, since a
                      record already found in DNS needs no copying. */}
                  {!check?.passed && (
                    /* Flex, not grid: overrides.css has to neutralise YZEN's
                       own .grid rule and can only re-assert the enumerated
                       grid-cols-* utilities, so an arbitrary column template
                       would be silently flattened to one column. */
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <div className="sm:w-40 sm:shrink-0">
                        <CopyField label="Host / Name" value={r.host} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <CopyField label="Value" value={r.value} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="!mt-[1.5rem] mb-0 text-xs leading-relaxed text-ink-faint">
            DNS changes usually appear within minutes but can take up to an hour.
            If a check fails right after you add a record, wait and try again before
            changing anything.
          </p>
        </Modal>
      )}
    </AdminShell>
  );
}
