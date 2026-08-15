'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Shared mailboxes — admissions@, support@, accounts@
// ============================================================================
//
//  A mailbox with no person behind it, answered by several. Two separate
//  things happen on this screen and they are deliberately separate calls:
//
//    Core creates the mailbox      POST /org/mailboxes
//    Mail decides who may open it  PUT  /mail/mailboxes/{id}/permissions
//
//  A queue with no grants receives mail nobody can read, so the list says so
//  in the row rather than leaving an admin to notice.
// ============================================================================

const GB = 1024 ** 3;

interface SharedMailbox {
  id: string;
  address: string;
  localPart: string;
  displayName: string | null;
  isActive: boolean;
  quotaBytes: number;
  usedBytes: number;
  grantCount: number;
}

interface Grant {
  userId: string;
  displayName: string;
  email: string;
  permission: 'read' | 'send_as' | 'full';
  grantedAt: string;
}

interface DomainOpt { id: string; fqdn: string; isActive: boolean; ownershipVerified: boolean }
interface Person { id: string; displayName: string; email: string; status: string }

function fmt(b: number): string {
  return b >= GB ? `${Math.round(b / GB)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
}

export default function SharedMailboxesPage() {
  const { authedFetch } = useAuth();

  const [boxes, setBoxes] = useState<SharedMailbox[]>([]);
  const [domains, setDomains] = useState<DomainOpt[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<SharedMailbox | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, d, u] = await Promise.all([
        authedFetch('/org/mailboxes'),
        authedFetch('/org/domains'),
        authedFetch('/org/users'),
      ]);
      if (m.ok) setBoxes((await m.json()).mailboxes ?? []);
      if (d.ok) setDomains(await d.json());
      if (u.ok) setPeople((await u.json()).filter((p: Person) => p.status === 'active'));
    } catch {
      setError('Could not load shared mailboxes.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const usable = domains.filter((d) => d.ownershipVerified && d.isActive);

  async function deactivate(box: SharedMailbox) {
    if (!window.confirm(
      `Close ${box.address}? Delivery stops and everyone's access is revoked. `
      + 'The stored mail is kept.')) return;
    const res = await authedFetch(`/org/mailboxes/${box.id}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error ?? 'Could not close that mailbox.'); return; }
    setNotice(body.note ?? 'Mailbox closed.');
    await load();
  }

  return (
    <AdminShell
      scope="organisation"
      title="Shared mailboxes"
      subtitle="Queues answered by several people"
      actions={
        <Button variant="primary" onClick={() => setCreating(true)} disabled={usable.length === 0}>
          New shared mailbox
        </Button>
      }
    >
      {error && (
        <div className="alert alert-danger d-flex align-items-start mb-3">
          <div className="flex-fill">{error}</div>
          <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => setError(null)} />
        </div>
      )}
      {notice && (
        <div className="alert alert-success d-flex align-items-start mb-3">
          <div className="flex-fill">{notice}</div>
          <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => setNotice(null)} />
        </div>
      )}

      {usable.length === 0 && !loading && (
        <div className="alert alert-warning mb-3">
          No verified domain yet, so a shared mailbox would receive nothing.
          Verify one under <strong>Domains</strong> first.
        </div>
      )}

      <p className="fs-12 text-muted mb-3">
        A shared mailbox has no password and nobody signs into it. Mail sent from
        one goes out as the mailbox — so a reply reaches whoever is on shift, not
        the person who happened to answer last time.
      </p>

      <Card padded={false}>
        {loading ? (
          <div className="d-flex justify-content-center py-5">
            <span className="d-inline-block animate-spin rounded-circle"
                  style={{ width: 30, height: 30, border: '3px solid rgba(0,0,0,.12)',
                           borderTopColor: '#03b562' }} />
          </div>
        ) : boxes.length === 0 ? (
          <Empty
            title="No shared mailboxes yet"
            hint="admissions@, support@, accounts@ — an address a team answers together."
          />
        ) : (
          <Table head={['Mailbox', 'Name', 'Access', 'Storage', 'Status', '']}>
            {boxes.map((b) => (
              <tr key={b.id}>
                <Td><span className="fw-semibold">{b.address}</span></Td>
                <Td>{b.displayName ?? <span className="text-muted">—</span>}</Td>
                <Td>
                  {b.grantCount === 0 ? (
                    // The failure worth naming: mail arriving where nobody can read it.
                    <Badge tone="warn">nobody yet</Badge>
                  ) : (
                    `${b.grantCount} ${b.grantCount === 1 ? 'person' : 'people'}`
                  )}
                </Td>
                <Td>{fmt(b.usedBytes)} / {fmt(b.quotaBytes)}</Td>
                <Td>
                  <Badge tone={b.isActive ? 'ok' : 'neutral'}>
                    {b.isActive ? 'active' : 'closed'}
                  </Badge>
                </Td>
                <Td>
                  <div className="d-flex gap-2 justify-content-end">
                    <Button variant="ghost" onClick={() => setManaging(b)}>Access</Button>
                    {b.isActive && (
                      <Button variant="ghost" onClick={() => void deactivate(b)}>
                        <span className="text-danger">Close</span>
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {creating && (
        <CreateDialog
          domains={usable}
          onClose={() => setCreating(false)}
          onCreated={async (msg) => { setCreating(false); setNotice(msg); await load(); }}
          onError={setError}
        />
      )}

      {managing && (
        <AccessDialog
          box={managing}
          people={people}
          onClose={() => setManaging(null)}
          onChanged={load}
          onError={setError}
        />
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
function CreateDialog({ domains, onClose, onCreated, onError }: {
  domains: DomainOpt[];
  onClose: () => void;
  onCreated: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [localPart, setLocalPart] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [displayName, setDisplayName] = useState('');
  const [quotaGb, setQuotaGb] = useState(10);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const res = await authedFetch('/org/mailboxes', {
        method: 'POST',
        body: JSON.stringify({
          localPart: localPart.trim().toLowerCase(),
          domainId,
          displayName: displayName.trim() || null,
          quotaBytes: quotaGb * GB,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not create the mailbox.');
      onCreated(`${body.address} created. ${body.note ?? ''}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not create the mailbox.');
      setBusy(false);
    }
  }

  const domain = domains.find((d) => d.id === domainId);

  return (
    <Modal
      title="New shared mailbox"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create} disabled={busy || localPart.trim().length < 2}>
            {busy ? 'Creating…' : 'Create mailbox'}
          </Button>
        </>
      }
    >
      <Field label="Address" required hint="Letters, numbers, dots, hyphens or underscores.">
        <div className="input-group">
          <input className="form-control" value={localPart} placeholder="admissions"
                 onChange={(e) => setLocalPart(e.target.value)} />
          <span className="input-group-text">@{domain?.fqdn ?? '…'}</span>
        </div>
      </Field>

      {domains.length > 1 && (
        <Field label="Domain">
          <select className="form-select" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
            {domains.map((d) => <option key={d.id} value={d.id}>{d.fqdn}</option>)}
          </select>
        </Field>
      )}

      <Field
        label="Display name"
        hint="What recipients see in From — “Admissions Office” reads better than “admissions”."
      >
        <input className="form-control" value={displayName} placeholder="Admissions Office"
               onChange={(e) => setDisplayName(e.target.value)} />
      </Field>

      <Field label="Storage">
        <div className="input-group" style={{ maxWidth: 200 }}>
          <input type="number" className="form-control" min={1} max={5000} value={quotaGb}
                 onChange={(e) => setQuotaGb(Math.max(1, Number(e.target.value)))} />
          <span className="input-group-text">GB</span>
        </div>
      </Field>

      <div className="alert alert-info mb-0 fs-12">
        Nobody can open it until you grant access — that is the next step, on the
        <strong> Access</strong> button in the list.
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
/**
 * Who may open this queue, and what they may do in it.
 *
 * The levels are not a ladder the UI invents: `read` and `send_as` are
 * independent on purpose, so an account that should only answer cannot also
 * read a year of correspondence, and `full` is the one that implies both plus
 * managing the mailbox's own filters and signature.
 */
function AccessDialog({ box, people, onClose, onChanged, onError }: {
  box: SharedMailbox;
  people: Person[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<Grant['permission']>('read');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await authedFetch(`/mail/mailboxes/${box.id}/permissions`);
    if (res.ok) setGrants((await res.json()).permissions ?? []);
    else setGrants([]);
  }, [authedFetch, box.id]);

  useEffect(() => { void reload(); }, [reload]);

  async function run(fn: () => Promise<Response>) {
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'That did not work.');
      }
      await reload();
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Access to ${box.address}`}
      subtitle={box.displayName ?? undefined}
      onClose={onClose}
      busy={busy}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="d-flex gap-2 align-items-end mb-3 flex-wrap">
        <div className="flex-fill" style={{ minWidth: 180 }}>
          <label className="form-label fs-12 text-muted mb-1">Person</label>
          <select className="form-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose someone…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </div>
        <div>
          <label className="form-label fs-12 text-muted mb-1">May</label>
          <select className="form-select" value={permission}
                  onChange={(e) => setPermission(e.target.value as Grant['permission'])}>
            <option value="read">read</option>
            <option value="send_as">send as</option>
            <option value="full">full — read, send, and manage it</option>
          </select>
        </div>
        <Button variant="primary" disabled={busy || !userId}
                onClick={() => void run(() => authedFetch(`/mail/mailboxes/${box.id}/permissions`, {
                  method: 'POST',
                  body: JSON.stringify({ userId, permission }),
                }))}>
          Grant
        </Button>
      </div>

      <p className="fs-12 text-muted">
        Reading and sending are separate. Someone with <strong>read</strong> can
        see the queue but cannot answer it; <strong>send as</strong> lets them
        answer without reading. Grant both, or <strong>full</strong>.
      </p>

      <div className="border-top pt-2" style={{ maxHeight: 240, overflowY: 'auto' }}>
        {grants === null ? (
          <p className="fs-12 text-muted">Loading…</p>
        ) : grants.length === 0 ? (
          <p className="fs-12 text-muted mb-0">
            Nobody has access. Mail sent here arrives where no one can read it.
          </p>
        ) : grants.map((g) => (
          <div key={`${g.userId}-${g.permission}`} className="d-flex align-items-center gap-2 py-2">
            <span className="flex-fill min-w-0">
              <span className="d-block fw-semibold text-truncate">{g.displayName}</span>
              <span className="d-block fs-12 text-muted text-truncate">{g.email}</span>
            </span>
            <Badge tone="neutral">{g.permission}</Badge>
            <button type="button" className="btn btn-sm btn-link text-danger" disabled={busy}
                    onClick={() => void run(() => authedFetch(
                      `/mail/mailboxes/${box.id}/permissions/${g.userId}/${g.permission}`,
                      { method: 'DELETE' }))}>
              remove
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
