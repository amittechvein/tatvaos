'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { Input, InputSuffix, Select } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

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
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {usable.length === 0 && !loading && (
        <Alert tone="warn">
          No verified domain yet, so a shared mailbox would receive nothing.
          Verify one under <strong>Domains</strong> first.
        </Alert>
      )}

      <p className="text-[0.75rem] text-ink-muted mb-4">
        A shared mailbox has no password and nobody signs into it. Mail sent from
        one goes out as the mailbox — so a reply reaches whoever is on shift, not
        the person who happened to answer last time.
      </p>

      <Card padded={false}>
        {loading ? (
          <Spinner />
        ) : boxes.length === 0 ? (
          <Empty
            title="No shared mailboxes yet"
            hint="admissions@, support@, accounts@ — an address a team answers together."
          />
        ) : (
          <Table head={['Mailbox', 'Name', 'Access', 'Storage', 'Status', '']}>
            {boxes.map((b) => (
              <tr key={b.id}>
                <Td><span className="font-semibold">{b.address}</span></Td>
                <Td>{b.displayName ?? <span className="text-ink-muted">—</span>}</Td>
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
                  <div className="flex gap-2 justify-end">
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
        <InputSuffix
          suffix={`@${domain?.fqdn ?? '…'}`}
          value={localPart} placeholder="admissions"
          onChange={(e) => setLocalPart(e.target.value)}
        />
      </Field>

      {domains.length > 1 && (
        <Field label="Domain">
          <Select  value={domainId} onChange={(e) => setDomainId(e.target.value)}>
            {domains.map((d) => <option key={d.id} value={d.id}>{d.fqdn}</option>)}
          </Select>
        </Field>
      )}

      <Field
        label="Display name"
        hint="What recipients see in From — “Admissions Office” reads better than “admissions”."
      >
        <Input  value={displayName} placeholder="Admissions Office"
               onChange={(e) => setDisplayName(e.target.value)} />
      </Field>

      <Field label="Storage">
        <InputSuffix
          suffix="GB" type="number" min={1} max={5000} value={quotaGb}
          style={{ maxWidth: 200 }}
          onChange={(e) => setQuotaGb(Math.max(1, Number(e.target.value)))}
        />
      </Field>

      <Alert tone="info" className="mb-0 text-[0.75rem]">
        Nobody can open it until you grant access — that is the next step, on the
        <strong> Access</strong> button in the list.
      </Alert>
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
  const [busy, setBusy] = useState(false);

  // Three boxes, one per level — Google Groups' shape, and it fits ours
  // exactly because our three levels ARE three jobs:
  //
  //   Members  read     they answer nothing, they watch the queue
  //   Managers send_as  they answer as the mailbox
  //   Owners   full     they also decide who else gets in, and own its
  //                     filters and signature
  //
  // The previous screen was one person-picker plus a level dropdown, which
  // asked the admin to translate "who runs support@" into a permission name
  // before they could act. This asks the question they already have.
  const [picked, setPicked] = useState<Record<Grant['permission'], string[]>>({
    read: [], send_as: [], full: [],
  });

  const reload = useCallback(async () => {
    const res = await authedFetch(`/mail/mailboxes/${box.id}/permissions`);
    setGrants(res.ok ? (await res.json()).permissions ?? [] : []);
  }, [authedFetch, box.id]);

  useEffect(() => { void reload(); }, [reload]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await reload(); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  }

  /** Grant everything picked, then clear the boxes. */
  async function addAll() {
    await run(async () => {
      for (const level of ['read', 'send_as', 'full'] as const) {
        for (const userId of picked[level]) {
          const res = await authedFetch(`/mail/mailboxes/${box.id}/permissions`, {
            method: 'POST',
            body: JSON.stringify({ userId, permission: level }),
          });
          if (!res.ok) {
            const b = await res.json().catch(() => ({}));
            throw new Error(b.error ?? 'Could not grant access.');
          }
          // 'full' implies the other two, so the rows they would duplicate go.
          if (level === 'full') {
            await Promise.allSettled((['read', 'send_as'] as const).map((p) =>
              authedFetch(`/mail/mailboxes/${box.id}/permissions/${userId}/${p}`,
                          { method: 'DELETE' })));
          }
        }
      }
      setPicked({ read: [], send_as: [], full: [] });
    });
  }

  const anyPicked = picked.read.length + picked.send_as.length + picked.full.length > 0;

  // One line per person; their levels as chips.
  const byPerson = (grants ?? []).reduce<
    { userId: string; displayName: string; email: string; levels: Grant['permission'][] }[]
  >((acc, g) => {
    const row = acc.find((x) => x.userId === g.userId);
    if (row) row.levels.push(g.permission);
    else acc.push({ userId: g.userId, displayName: g.displayName, email: g.email, levels: [g.permission] });
    return acc;
  }, []);

  return (
    <Modal
      title={`Access to ${box.address}`}
      subtitle={box.displayName ?? undefined}
      onClose={onClose}
      busy={busy}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void addAll()} disabled={busy || !anyPicked}>
            {busy ? 'Adding…' : 'Add people'}
          </Button>
        </>
      }
    >
      <PickerBox
        label="Members"
        hint="Can read this mailbox. They cannot answer from it."
        people={people}
        picked={picked.read}
        onChange={(ids) => setPicked((p) => ({ ...p, read: ids }))}
      />
      <PickerBox
        label="Managers"
        hint="Can read and answer as this mailbox. Replies go out as the mailbox, so they come back to the queue."
        people={people}
        picked={picked.send_as}
        onChange={(ids) => setPicked((p) => ({ ...p, send_as: ids }))}
      />
      <PickerBox
        label="Owners"
        hint="Everything a manager can do, plus deciding who else has access and managing the mailbox's own filters and signature."
        people={people}
        picked={picked.full}
        onChange={(ids) => setPicked((p) => ({ ...p, full: ids }))}
      />

      <hr className="my-6" />

      <div className="text-[0.875rem] font-semibold mb-2">Who has access now</div>
      {grants === null ? (
        <p className="text-[0.75rem] text-ink-muted mb-0">Loading…</p>
      ) : byPerson.length === 0 ? (
        <p className="text-[0.75rem] text-ink-muted mb-0">
          Nobody yet. Mail sent here arrives where no one can read it.
        </p>
      ) : (
        <div style={{ maxHeight: 220, overflowY: 'auto' }}>
          {byPerson.map((p) => (
            <div key={p.userId} className="flex items-center gap-2 border-b border-line py-2">
              <span className="flex-auto min-w-0">
                <span className="block font-semibold truncate">{p.displayName}</span>
                <span className="block text-[0.75rem] text-ink-muted truncate">{p.email}</span>
              </span>
              {p.levels.map((lvl) => (
                <span key={lvl} className="inline-flex items-center gap-1">
                  <Badge tone="neutral">{LEVEL_LABEL[lvl]}</Badge>
                  {/* Each level removable on its own: taking away someone's
                      ability to answer should not also stop them reading. */}
                  <button type="button"
                          className="rounded px-1 leading-none text-danger hover:bg-danger/10 disabled:opacity-50"
                          disabled={busy} title={`Remove ${LEVEL_LABEL[lvl]}`}
                          aria-label={`Remove ${LEVEL_LABEL[lvl]}`}
                          onClick={() => void run(() => authedFetch(
                            `/mail/mailboxes/${box.id}/permissions/${p.userId}/${lvl}`,
                            { method: 'DELETE' }))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const LEVEL_LABEL: Record<Grant['permission'], string> = {
  read: 'member', send_as: 'manager', full: 'owner',
};

/**
 * One labelled box that collects people as chips — the Groups pattern.
 *
 * Deliberately not a <select multiple>: those hide what is selected behind a
 * scrollbar and lose the selection on a mis-click, which is a bad way to
 * discover you granted the wrong person access to a mailbox.
 */
function PickerBox({ label, hint, people, picked, onChange }: {
  label: string;
  hint: string;
  people: Person[];
  picked: string[];
  onChange: (ids: string[]) => void;
}) {
  const [term, setTerm] = useState('');

  const chosen = picked
    .map((id) => people.find((p) => p.id === id))
    .filter((p): p is Person => !!p);

  const hits = term.trim()
    ? people.filter((p) =>
        !picked.includes(p.id)
        && (p.displayName.toLowerCase().includes(term.trim().toLowerCase())
            || p.email.toLowerCase().includes(term.trim().toLowerCase())))
      .slice(0, 6)
    : [];

  return (
    <div className="mb-4">
      <label className="mb-1 block text-[0.8125rem] font-semibold text-ink">{label}</label>
      <div className="relative">
        {/* The same surface as an Input — it IS the field, it just holds chips
            and a bare typing slot instead of one value. */}
        <div className="flex w-full flex-wrap items-center gap-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/25"
             style={{ minHeight: 72, alignContent: 'flex-start', paddingTop: 8 }}>
          {chosen.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-1"
                  style={{ fontSize: 12 }}>
              {p.displayName}
              <button type="button" aria-label={`Remove ${p.displayName}`}
                      className="rounded px-0.5 leading-none text-danger hover:bg-danger/10"
                      onClick={() => onChange(picked.filter((id) => id !== p.id))}>×</button>
            </span>
          ))}
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={chosen.length === 0 ? 'Type a name or address' : ''}
            className="border-0 flex-auto"
            style={{ outline: 'none', minWidth: 140, fontSize: 13 }}
          />
        </div>

        {hits.length > 0 && (
          <div className="absolute w-full rounded-lg border border-line bg-surface shadow-raised"
               style={{ zIndex: 1400, top: '100%', marginTop: 2, overflow: 'hidden' }}>
            {hits.map((p) => (
              <button key={p.id} type="button"
                      // mousedown: click fires after blur, by which time the
                      // list has gone.
                      onMouseDown={(e) => { e.preventDefault(); onChange([...picked, p.id]); setTerm(''); }}
                      className="block w-full text-start border-0 bg-transparent px-4 py-2">
                <span className="block font-semibold" style={{ fontSize: 13 }}>{p.displayName}</span>
                <span className="block text-ink-muted" style={{ fontSize: 11 }}>{p.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="text-[0.75rem] text-ink-muted mt-1">{hint}</div>
    </div>
  );
}
