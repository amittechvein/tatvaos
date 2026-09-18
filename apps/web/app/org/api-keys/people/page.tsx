'use client';

/**
 * People API keys — a customer's own software adding their people
 * (Amit, 18 September 2026).
 *
 * ITS OWN PAGE, not a section on the mail-key screen. The two credentials
 * look alike and are not alike: a mail key sends mail, and this one creates
 * sign-in identities. Sharing a screen invited an administrator to think of
 * them as one thing with two settings, which is exactly the thought that ends
 * with one key that can do both.
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
 * The one thing a key can be given today, in the words an administrator reads.
 * The hint says what it CANNOT do, because that is the question a careful
 * person asks about a credential that creates accounts.
 */
const ORG_SCOPES: { scope: string; label: string; hint: string }[] = [
  {
    scope: 'people:admit',
    label: 'Add people to this organisation',
    hint: 'Creates the person and sends them an invitation. It cannot make anyone an administrator, and it cannot set anyone a password.',
  },
];
function scopeLabel(scope: string): string {
  return ORG_SCOPES.find((s) => s.scope === scope)?.label ?? scope;
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function PeopleApiKeysPage() {
  const { authedFetch } = useAuth();
  const [rows, setRows] = useState<OrgKeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [endpoint, setEndpoint] = useState('https://core.tatvaos.com/api/v1/org/people');

  useEffect(() => {
    if (typeof window !== 'undefined') setEndpoint(`${window.location.origin}/api/v1/org/people`);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await authedFetch('/org/keys');
      if (!r.ok) throw new Error('Could not load the keys.');
      setRows((await r.json()) as OrgKeyRow[]);
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
      title="People API"
      subtitle="Let your own software add people to this organisation"
      actions={<Button variant="primary" onClick={() => setCreating(true)}>New key</Button>}
    >
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <p className="mb-4 text-[0.75rem] text-ink-muted">
        For a student information system, an HR package, or anything else of yours that knows who
        joins. Each person added this way gets an invitation to set their own password, exactly as if
        you had added them here. <strong>A key can add ordinary people. It cannot make anyone an
        administrator, and it never sets anyone&apos;s password.</strong>
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
          <div className="mb-1 text-[0.75rem] text-ink-muted">Adding one person, from your own software:</div>
          <pre className="mb-0 rounded bg-canvas p-4 text-[0.75rem]" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
{`POST ${endpoint}
Authorization: Bearer ${fresh.key}
Content-Type: application/json

{
  "localPart":     "asha.rao",
  "displayName":   "Asha Rao",
  "recoveryEmail": "asha@example.com"
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
            hint="Create one per program that adds people. Revoking one never affects another."
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

      <Card title="How your software adds a person" subtitle="One request. The person does the rest.">
        <ol className="ps-4 mb-4">
          <li className="mb-3">
            <div className="font-semibold">Create a key here</div>
            <div className="text-[0.8125rem] text-ink-muted">
              One per program, named for what it does. It is shown once.
            </div>
          </li>
          <li className="mb-3">
            <div className="font-semibold">Send one request per person</div>
            <div className="text-[0.8125rem] text-ink-muted">
              <code>localPart</code> becomes their address on your verified domain.
              <code className="ms-1">recoveryEmail</code> or <code>recoveryPhone</code> is where their
              invitation goes — one of the two is required, because an account nobody can enter is
              worse than no account.
            </div>
          </li>
          <li className="mb-0">
            <div className="font-semibold">They set their own password</div>
            <div className="text-[0.8125rem] text-ink-muted">
              From the invitation. Your software never handles it, and neither do you.
            </div>
          </li>
        </ol>
        <div className="text-[0.8125rem] text-ink-muted mb-0">
          Answers you may see: <code>401</code> the key is not valid or was revoked,
          <code className="ms-1">403</code> the key is real but not allowed to add people,
          <code className="ms-1">409</code> that address already exists,
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
  const [scopes, setScopes] = useState<string[]>(['people:admit']);
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
      title="New People API key"
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
        <Input value={label} placeholder="Student information system" maxLength={100} autoFocus
               onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
        <p className="mb-2 text-sm font-semibold text-ink">What may this key do?</p>
        {ORG_SCOPES.map((o) => (
          <Checkbox
            key={o.scope}
            label={o.label}
            hint={o.hint}
            checked={scopes.includes(o.scope)}
            onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, o.scope] : cur.filter((x) => x !== o.scope)))}
          />
        ))}
      </div>
    </Modal>
  );
}
