'use client';

/**
 * Meetings API keys — a school's ERP scheduling classes and handing students
 * the link to join them (Amit, 18 September 2026).
 *
 * ITS OWN PAGE, for the reason the People API has one: these credentials look
 * alike and are not alike. A mail key sends mail, a people key creates
 * sign-in identities, and these two put classes on teachers' calendars. One
 * screen with three sets of tick-boxes invites an administrator to think of
 * them as one thing with settings, which is the thought that ends in a single
 * key that can do everything.
 *
 * TWO SCOPES ON PURPOSE, and the page says why in the words an administrator
 * reads: the staff half of an ERP schedules, the student half only reads and
 * hands out links. A student portal carrying a key that could cancel every
 * class in the school is the failure this separation exists to prevent.
 */

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { Checkbox, Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

interface OrgKeyRow {
  id: string;
  label: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdByName: string | null;
}

/**
 * The two things a meetings key can be given. The hint on each says what it
 * CANNOT do, because that is the question a careful person asks about a
 * credential they are about to paste into somebody else's software.
 */
const MEETING_SCOPES: { scope: string; label: string; hint: string }[] = [
  {
    scope: 'meetings:schedule',
    label: 'Schedule meetings for people in this organisation',
    hint: 'Create, reschedule and cancel classes, each one hosted by a named teacher. It cannot add people, and it cannot end a meeting that is running.',
  },
  {
    scope: 'meetings:join',
    label: 'Read meetings and hand out join links',
    hint: 'For the half of your software students use. It can read the timetable and give out links. It cannot create, change or cancel anything.',
  },
];
const MEETING_SCOPE_SET = new Set(MEETING_SCOPES.map((s) => s.scope));

function scopeLabel(scope: string): string {
  return MEETING_SCOPES.find((s) => s.scope === scope)?.label ?? scope;
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function MeetingsApiKeysPage() {
  const { authedFetch } = useAuth();
  const [rows, setRows] = useState<OrgKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [endpoint, setEndpoint] = useState('https://core.tatvaos.com/api/v1/org/meetings');

  useEffect(() => {
    if (typeof window !== 'undefined') setEndpoint(`${window.location.origin}/api/v1/org/meetings`);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await authedFetch('/org/keys');
      if (!r.ok) throw new Error('Could not load the keys.');
      const all = (await r.json()) as OrgKeyRow[];
      // Only this page's keys. /org/keys returns every organisation key there
      // is, and a people key listed here — or a meetings key listed on the
      // People screen — would be described by the wrong page's words.
      setRows(all.filter((k) => k.scopes.some((s) => MEETING_SCOPE_SET.has(s))));
    } catch (e) { setError((e as Error).message); setRows([]); }
  }, [authedFetch]);
  useEffect(() => { void load(); }, [load]);

  const revoke = async (k: OrgKeyRow) => {
    setError(null);
    try {
      const r = await authedFetch(`/org/keys/${k.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Could not revoke the key.');
      if (fresh && fresh.label === k.label) setFresh(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const live = (rows ?? []).filter((k) => !k.revokedAt);
  const revoked = (rows ?? []).filter((k) => k.revokedAt);

  return (
    <AdminShell
      scope="organisation"
      title="Meetings API"
      subtitle="Let your own software schedule classes and hand out join links"
      actions={
        <div className="flex gap-2">
          {/* A real link, not a Button with href: Button renders a Next
              <Link>, which routes instead of opening the static page. */}
          <a href="/docs/meetings-api-guide.html" target="_blank" rel="noopener"
             className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink no-underline transition-colors hover:bg-canvas">
            Integration guide
          </a>
          <Button variant="primary" onClick={() => setCreating(true)}>New key</Button>
        </div>
      }
    >
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <p className="mb-4 text-[0.75rem] text-ink-muted">
        For a student information system, a timetable, or anything else of yours that already knows
        who teaches what and when. A meeting scheduled this way is hosted by the teacher you name,
        appears on <strong>their calendar</strong>, and can be edited in Connect exactly like one they
        created themselves.
      </p>

      {fresh && (
        <Card className="mb-4 border-ok">
          <div className="mb-1 font-semibold">Your new key for &quot;{fresh.label}&quot;</div>
          <div className="mb-3 text-[0.75rem] font-semibold text-danger">
            This is the only time it will be shown. Copy it now — it cannot be recovered, only replaced.
          </div>
          <div className="mb-4 flex items-stretch">
            <Input readOnly value={fresh.key} className="rounded-r-none" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="primary" className="rounded-l-none"
                    onClick={() => { void navigator.clipboard.writeText(fresh.key)
                      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
                      .catch(() => {}); }}>
              {copied ? 'Copied' : 'Copy key'}
            </Button>
          </div>
          <div className="mb-1 text-[0.75rem] text-ink-muted">Scheduling one class, from your own software:</div>
          <pre className="mb-0 rounded bg-canvas p-4 text-[0.75rem]" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
{`POST ${endpoint}
Authorization: Bearer ${fresh.key}
Content-Type: application/json

{
  "hostEmail": "teacher@yourschool.edu",
  "title":     "Physics — Class 10B",
  "startsAt":  "2026-09-21T09:00:00+05:30",
  "endsAt":    "2026-09-21T10:00:00+05:30"
}`}
          </pre>
        </Card>
      )}

      <Card padded={false} className="mb-4">
        {rows === null ? (
          <Spinner />
        ) : live.length === 0 ? (
          <Empty
            title="No keys yet"
            hint="Create one for the half of your software that schedules, and a separate one for the half students use."
            action={<Button variant="primary" onClick={() => setCreating(true)}>New key</Button>}
          />
        ) : (
          <Table head={['What it is for', 'Key', 'May do', 'Added by', 'Last used', '']}>
            {live.map((k) => (
              <tr key={k.id}>
                <Td><span className="font-semibold">{k.label}</span></Td>
                <Td><code className="text-[0.75rem]">{k.keyPrefix}…</code></Td>
                <Td><span className="text-[0.75rem]">{k.scopes.map(scopeLabel).join(', ')}</span></Td>
                <Td><span className="text-[0.75rem]">{k.createdByName ?? '—'}</span></Td>
                <Td><span className="text-[0.75rem]">{k.lastUsedAt ? when(k.lastUsedAt) : 'Never'}</span></Td>
                <Td>
                  <div className="flex justify-end">
                    <Button variant="ghost" onClick={() => void revoke(k)}>
                      <span className="text-danger">Revoke</span>
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {revoked.length > 0 && (
        <Card title="Revoked" subtitle="Kept for the record. Nothing can use these." padded={false} className="mb-4">
          <Table head={['What it was for', 'Key', 'Revoked']}>
            {revoked.map((k) => (
              <tr key={k.id}>
                <Td><span className="text-ink-muted">{k.label}</span></Td>
                <Td><code className="text-[0.75rem] text-ink-muted">{k.keyPrefix}…</code></Td>
                <Td><span className="text-[0.75rem] text-ink-muted">{when(k.revokedAt!)}</span></Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Card title="Two keys, not one" subtitle="The half that schedules and the half students use are different things.">
        <p className="text-[0.8125rem] text-ink-muted mb-3">
          Give the staff side of your software a key that may <strong>schedule</strong>, and the student
          side a separate key that may only <strong>read and hand out links</strong>. If one key did
          both, the copy sitting in a student portal could cancel every class in the school.
        </p>
        <ol className="ps-4 mb-4">
          <li className="mb-3">
            <div className="font-semibold">A teacher creates a class</div>
            <div className="text-[0.8125rem] text-ink-muted">
              One request naming the teacher by their address. It lands on that teacher&apos;s own
              calendar with the join link on it, and in their Connect list.
            </div>
          </li>
          <li className="mb-3">
            <div className="font-semibold">A student opens the link</div>
            <div className="text-[0.8125rem] text-ink-muted">
              A student who has a TatvaOS account signs in and walks in. Anyone else gives their name
              at the door. The join call tells you which it will be, so your software can say so first.
            </div>
          </li>
          <li className="mb-0">
            <div className="font-semibold">Changes follow</div>
            <div className="text-[0.8125rem] text-ink-muted">
              Rescheduling moves the calendar entry; cancelling takes it off. Nobody is left holding
              the old time.
            </div>
          </li>
        </ol>
        <p className="text-[0.8125rem] text-ink-muted mb-3">
          Handing this to a developer? The{' '}
          <a href="/docs/meetings-api-guide.html" target="_blank" rel="noopener">integration guide</a>{' '}
          has every field, working examples in curl, Node.js and Python, and what a key deliberately
          cannot do.
        </p>
        <div className="text-[0.8125rem] text-ink-muted mb-0">
          Answers you may see: <code>401</code> the key is not valid or was revoked,
          <code className="ms-1">403</code> the key is real but not allowed to do that,
          <code className="ms-1">409</code> the meeting is over or running,
          <code className="ms-1">400</code> with a sentence saying what was wrong.
        </div>
      </Card>

      {creating && (
        <NewKeyDialog
          onClose={() => setCreating(false)}
          onCreated={async (k) => { setCreating(false); setFresh(k); await load(); }}
          onError={setError}
        />
      )}
    </AdminShell>
  );
}

function NewKeyDialog({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: (k: { key: string; label: string }) => Promise<void>;
  onError: (m: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [label, setLabel] = useState('');
  // Nothing ticked by default. A meetings key is two quite different powers,
  // and the one that is pre-selected is the one nobody reads.
  const [scopes, setScopes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const r = await authedFetch('/org/keys', {
        method: 'POST',
        body: JSON.stringify({ label: label.trim(), scopes }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error ?? 'Could not create the key.');
      await onCreated({ key: b.key, label: b.label });
    } catch (e) { onError((e as Error).message); onClose(); } finally { setBusy(false); }
  }

  return (
    <Modal
      title="New Meetings API key"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}
                  disabled={busy || label.trim().length < 2 || scopes.length === 0}>
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </>
      }
    >
      <Field label="What is this key for?" required
             hint="The program that will use it. You will see this name when deciding what to revoke.">
        <Input value={label} placeholder="Timetable — staff" maxLength={100} autoFocus
               onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
        <p className="mb-2 text-sm font-semibold text-ink">What may this key do?</p>
        {MEETING_SCOPES.map((o) => (
          <Checkbox
            key={o.scope}
            label={o.label}
            hint={o.hint}
            checked={scopes.includes(o.scope)}
            onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, o.scope] : cur.filter((x) => x !== o.scope)))}
          />
        ))}
        <p className="mt-2 mb-0 text-[0.75rem] text-ink-muted">
          Ticking both makes one key that can do everything. Prefer two keys — one per half of your
          software — so the student-facing one cannot change anything.
        </p>
      </div>
    </Modal>
  );
}
