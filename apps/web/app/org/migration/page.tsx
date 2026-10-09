'use client';

// ============================================================================
//  /org/migration - moving the organisation from Google Workspace
// ============================================================================
//
//  Three steps, in the order the server enforces them (MigrationEndpoints.cs):
//  give TatvaOS access, check it fits, choose people and start. Then progress,
//  person by person, refreshed while anything is moving.
//
//  The server's words are shown as they come (lib/orgMigration.ts): refusals
//  say what to do in Google's console, and the verdict's reasons carry the
//  numbers. This page adds no rule of its own.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatBytes } from '@tatvaos/core';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Spinner, Stat, Table, Td } from '@/components/ui/Kit';
import { Modal } from '@/components/ui/Modal';
import { Checkbox, Field, Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import {
  DATA_TYPES, DATA_TYPE_LABEL, catchUp, enrol, fetchPeople, fetchSetup, grantAccess, isActive,
  revokeAccess, runEstimate, sharedDriveName, start,
  type DataType, type EnrolmentReport, type MigrationEstimate, type MigrationPeople, type MigrationSetup,
  type TypeProgress,
} from '@/lib/orgMigration';

const STATE_TONE: Record<TypeProgress['state'], 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  planned: 'neutral', pending: 'info', running: 'info', completed: 'ok', failed: 'danger', cancelled: 'warn',
};
const VERDICT_TONE = { fits: 'ok', refused: 'danger', incomplete: 'warn' } as const;

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded border border-line bg-canvas px-2 py-1 text-xs">{value}</code>
      <Button size="sm" onClick={() => {
        void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
      }}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

export default function OrgMigrationPage() {
  const { authedFetch } = useAuth();

  const [setup, setSetup] = useState<MigrationSetup | null>(null);
  const [people, setPeople] = useState<MigrationPeople | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'danger' | 'info'; text: string } | null>(null);

  const [domain, setDomain] = useState('');
  const [admin, setAdmin] = useState('');
  const [estimate, setEstimate] = useState<MigrationEstimate | null>(null);
  const [enrolled, setEnrolled] = useState<EnrolmentReport | null>(null);
  const [types, setTypes] = useState<DataType[]>([...DATA_TYPES]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [removeInGoogle, setRemoveInGoogle] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([fetchSetup(authedFetch), fetchPeople(authedFetch)]);
      setSetup(s); setPeople(p); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the migration.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  // Refresh while anything is moving - the runner works in the background.
  const moving = useMemo(() => people?.people.some(p => p.types.some(t => isActive(t.state))) ?? false, [people]);
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => { void fetchPeople(authedFetch).then(setPeople).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [moving, authedFetch]);

  /** Run one action; show the server's own sentence if it refuses. */
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setNotice(null);
    try { await fn(); } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'That did not work.' });
    } finally { setBusy(null); }
  };

  const shell = (children: React.ReactNode) => (
    <AdminShell scope="organisation" title="Move from Google Workspace"
                subtitle="Mail, contacts, calendars and Drive files, person by person. Nothing in Google is changed.">
      {children}
    </AdminShell>
  );

  if (loading) return shell(<Spinner />);
  if (error || !setup) return shell(<Alert tone="danger" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>{error ?? 'Could not load the migration.'}</Alert>);

  const grant = setup.grant;
  const toggle = (email: string) => setSelected(prev => {
    const next = new Set(prev); if (next.has(email)) next.delete(email); else next.add(email); return next;
  });

  return shell(
    <>
      {notice && <Alert tone={notice.tone} onDismiss={() => setNotice(null)} className="mb-4">{notice.text}</Alert>}
      {!setup.configured && (
        <Alert tone="info" title="Not available on this server yet" className="mb-4">{setup.reason}</Alert>
      )}
      {removeInGoogle && (
        <Alert tone="warn" title="One more step, in Google" onDismiss={() => setRemoveInGoogle(null)} className="mb-4">{removeInGoogle}</Alert>
      )}

      {/* ── 1. Access ─────────────────────────────────────────────────── */}
      <Card title="1. Give TatvaOS read-only access" className="mb-6"
            subtitle="Your Google admin authorises TatvaOS once. Nothing in your Google account can be changed by it.">
        {grant ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-sm">
              <Badge tone="ok">Access granted</Badge>{' '}
              <span className="text-ink-muted">for <b>{grant.googleDomain}</b>, checked as {grant.googleAdmin}, on {new Date(grant.grantedAt).toLocaleDateString()}</span>
              {setup.grantIsForThisKey === false && (
                <div className="mt-2"><Alert tone="warn">This grant was for a previous TatvaOS key. Remove it and grant access again.</Alert></div>
              )}
            </div>
            <Button variant="danger" onClick={() => setConfirmRevoke(true)}>Remove access</Button>
          </div>
        ) : setup.configured ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <ol className="min-w-0 list-decimal space-y-3 pl-5 text-sm">
              <li>In the <b>Google Admin console</b>, open Security → Access and data control → API controls → <b>Manage domain-wide delegation</b>, and choose <b>Add new</b>.</li>
              <li>Client ID:<div className="mt-1"><Copyable value={setup.clientId ?? ''} /></div></li>
              <li>OAuth scopes - all read-only:<div className="mt-1"><Copyable value={(setup.scopes ?? []).join(',')} /></div></li>
              <li>Authorise, then tell TatvaOS here. We check it works before recording it.</li>
            </ol>
            <form className="min-w-0" onSubmit={e => {
              e.preventDefault();
              void act('grant', async () => {
                const r = await grantAccess(authedFetch, domain, admin);
                setNotice({ tone: 'ok', text: `Access works: ${r.peopleListed} people found in ${r.grant.googleDomain}.` });
                await load();
              });
            }}>
              <Field label="Your Google domain" hint="e.g. example.com">
                {(f) => <Input id={f.id} describedBy={f.describedBy} value={domain} onChange={e => setDomain(e.target.value)} placeholder="example.com" required />}
              </Field>
              <Field label="A Google admin's address" hint="We list your directory as this person to check the access works.">
                {(f) => <Input id={f.id} describedBy={f.describedBy} type="email" value={admin} onChange={e => setAdmin(e.target.value)} placeholder="admin@example.com" required />}
              </Field>
              <Button variant="primary" type="submit" disabled={busy !== null}>{busy === 'grant' ? 'Checking with Google…' : "I've authorised it - check"}</Button>
            </form>
          </div>
        ) : (
          <Empty title="Waiting for the server" hint="An administrator of this TatvaOS server has to install its Google key first." />
        )}
      </Card>

      {/* ── 2. Estimate ───────────────────────────────────────────────── */}
      <Card title="2. Check it fits" className="mb-6"
            subtitle="Measures every person's mail and Drive in Google. Nothing is copied."
            actions={<Button disabled={!grant || busy !== null} onClick={() => void act('estimate', async () => setEstimate(await runEstimate(authedFetch)))}>
              {busy === 'estimate' ? 'Measuring…' : estimate ? 'Measure again' : 'Measure'}</Button>}>
        {!estimate ? (
          <p className="text-sm text-ink-muted">{grant ? 'Run it before starting. It refuses, with a number, anything that would fill the disk.' : 'Give access first.'}</p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label="People" value={String(estimate.people.length)} caption={estimate.unmeasured.length ? `${estimate.unmeasured.length} not measured` : undefined} />
              <Stat label="Mail" value={formatBytes(estimate.mailBytes)} caption="stored twice on disk" />
              <Stat label="Drive files" value={formatBytes(estimate.driveBytes)} caption="Docs/Sheets not counted" />
              <div className="flex items-center"><Badge tone={VERDICT_TONE[estimate.verdict.state]}>{estimate.verdict.state === 'fits' ? 'It fits' : estimate.verdict.state === 'refused' ? 'It does not fit' : 'Not yet a yes'}</Badge></div>
            </div>
            {estimate.verdict.reasons.length > 0 && (
              <ul className="mb-2 list-disc space-y-1 pl-5 text-sm">{estimate.verdict.reasons.map(r => <li key={r}>{r}</li>)}</ul>
            )}
            {estimate.unmeasured.map(u => <p key={u.email} className="text-sm text-ink-muted">{u.email}: {u.reason}</p>)}
          </>
        )}
      </Card>

      {/* ── 3. People ─────────────────────────────────────────────────── */}
      <Card title="3. Choose people and start"
            subtitle="Start with one person. Mail lands in their mailbox, contacts in their address book, calendars and files in their own space."
            actions={
              <div className="flex flex-wrap gap-2">
                <Button disabled={!grant || busy !== null} onClick={() => void act('enrol', async () => { setEnrolled(await enrol(authedFetch, types)); await load(); })}>
                  {busy === 'enrol' ? 'Reading Google…' : 'Add everyone from Google'}</Button>
                <Button variant="primary" disabled={!grant || busy !== null || selected.size === 0}
                        onClick={() => void act('start', async () => {
                          const r = await start(authedFetch, types, [...selected]);
                          setNotice({ tone: r.notStarted.length ? 'warn' : 'ok', text: `Started ${r.jobsStarted} job(s) for ${r.peopleStarted} person(s).${r.notStarted.map(n => ` ${n.email}: ${n.reason}.`).join('')}` });
                          setSelected(new Set()); await load();
                        })}>Start selected ({selected.size})</Button>
                <Button disabled={!grant || busy !== null} onClick={() => void act('catchup', async () => {
                  const r = await catchUp(authedFetch, selected.size ? [...selected] : null);
                  setNotice({ tone: 'info', text: r.queued.length ? `Bringing new mail for ${r.queued.length} person(s).` : 'Nobody has a finished mail copy to catch up yet.' });
                  await load();
                })}>Bring new mail</Button>
              </div>
            }>
          <div className="mb-4 flex flex-wrap gap-x-5">
            {DATA_TYPES.map(t => (
              <Checkbox key={t} label={DATA_TYPE_LABEL[t]} checked={types.includes(t)}
                        onChange={() => setTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])} />
            ))}
          </div>
          {enrolled && (
            <Alert tone={enrolled.unmatched.length ? 'warn' : 'ok'} className="mb-4" onDismiss={() => setEnrolled(null)}>
              {enrolled.people} people in Google, {enrolled.matched} matched to a TatvaOS person.
              {(enrolled.sharedDrives ?? 0) > 0 && <> {enrolled.sharedDrives} shared drive(s) too - they land in the organisation&apos;s Space.</>}
              {enrolled.unmatched.length > 0 && <> Not matched (create them in TatvaOS first, then add again): {enrolled.unmatched.join(', ')}.</>}
            </Alert>
          )}
          {!people || people.people.length === 0 ? (
            <Empty title="Nobody added yet" hint={grant ? 'Add everyone from Google, then choose who to start with.' : 'Give access first.'} />
          ) : (
            <Table head={['', 'Google address', 'Lands with', ...DATA_TYPES.map(t => DATA_TYPE_LABEL[t])]}>
              {people.people.map(p => {
                const drive = sharedDriveName(p.googleAddress);
                return (
                <tr key={p.googleAddress}>
                  <Td><input type="checkbox" aria-label={`Select ${drive ? `shared drive ${drive}` : p.googleAddress}`} disabled={!p.targetUserId}
                             checked={selected.has(p.googleAddress)} onChange={() => toggle(p.googleAddress)} /></Td>
                  <Td className="break-all">{drive ? <><Badge tone="info">Shared drive</Badge> {drive}</> : p.googleAddress}</Td>
                  <Td>{drive ? <span className="text-ink-muted">The organisation&apos;s Space</span>
                             : p.targetEmail ?? <span className="text-ink-muted">No TatvaOS person</span>}</Td>
                  {DATA_TYPES.map(t => {
                    const j = p.types.find(x => x.dataType === t);
                    return (
                      <Td key={t}>
                        {j ? (
                          <div title={j.lastError ?? undefined}>
                            <Badge tone={STATE_TONE[j.state]}>{j.state}</Badge>
                            {(j.itemsDone > 0 || j.itemsTotal) && (
                              <div className="mt-1 text-xs text-ink-muted">
                                {j.itemsDone}{j.itemsTotal ? ` of ~${j.itemsTotal}` : ''}{j.itemsSkipped ? `, ${j.itemsSkipped} skipped` : ''}{j.itemsFailed ? `, ${j.itemsFailed} failed` : ''}
                              </div>
                            )}
                            {j.lastError && <div className="mt-1 max-w-[16rem] text-xs text-danger">{j.lastError}</div>}
                          </div>
                        ) : <span className="text-ink-muted">-</span>}
                      </Td>
                    );
                  })}
                </tr>
                );
              })}
            </Table>
          )}
        </Card>

      {confirmRevoke && (
        <Modal title="Remove TatvaOS's access?" onClose={() => setConfirmRevoke(false)} busy={busy === 'revoke'}
               footer={<>
                 <Button onClick={() => setConfirmRevoke(false)}>Keep access</Button>
                 <Button variant="danger" disabled={busy !== null} onClick={() => void act('revoke', async () => {
                   const r = await revokeAccess(authedFetch);
                   setConfirmRevoke(false);
                   setRemoveInGoogle(`${r.jobsCancelled} unfinished job(s) were stopped. ${r.removeInGoogle}`);
                   await load();
                 })}>Remove access</Button>
               </>}>
          <p className="text-sm">Unfinished moves stop. What has already arrived in TatvaOS stays. You will also need to remove TatvaOS in the Google Admin console - we will show you where.</p>
        </Modal>
      )}
    </>,
  );
}
