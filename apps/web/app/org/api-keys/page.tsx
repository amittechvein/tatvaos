'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, IconButton, Spinner, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { Checkbox, Input } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

interface KeyRow {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  allowedAddresses?: string[];
  allowedCount?: number;
}

const MAX_RECIPIENTS = 5;

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ApiKeysPage() {
  const { authedFetch } = useAuth();

  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<KeyRow | null>(null);
  const [editingKey, setEditingKey] = useState<KeyRow | null>(null);
  const [fresh, setFresh] = useState<{ key: string; label: string; allowed_sender_addresses?: string[] } | null>(null);
  const [endpoint, setEndpoint] = useState('https://core.tatvaos.com/api/v1/mail/send');

  useEffect(() => {
    if (typeof window !== 'undefined') setEndpoint(`${window.location.origin}/api/v1/mail/send`);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await authedFetch('/mail/api-keys');
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not load API keys.');
      setKeys((await r.json()).keys);
    } catch (e) {
      setError((e as Error).message);
      setKeys([]);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (k: KeyRow) => {
    setError(null);
    try {
      const r = await authedFetch(`/mail/api-keys/${k.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not revoke the key.');
      setRevoking(null);
      setNotice(`"${k.label}" is revoked. Requests using it are refused from now on.`);
      if (fresh && fresh.label === k.label) setFresh(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <AdminShell
      scope="organisation"
      title="Mail API keys"
      subtitle="Let your own software send mail through TatvaOS"
      actions={
        <div className="flex gap-2">
          {/* A real download link, not a Button with href: Button renders a
              Next <Link>, which routes instead of downloading the file. */}
          <a href="/docs/TatvaOS-Mail-API-Integration-Guide.pdf" download
             className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink no-underline transition-colors hover:bg-canvas">
            Integration guide (PDF)
          </a>
          <Button variant="primary" onClick={() => setCreating(true)}>
            New API key
          </Button>
        </div>
      }
    >
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {fresh && (
        <FreshKeyCard
          fresh={fresh}
          endpoint={endpoint}
          onDismiss={() => setFresh(null)}
        />
      )}

      <p className="text-[0.75rem] text-ink-muted mb-4">
        A key lets a website form, a billing job or any other program of yours send
        mail as one of your mailboxes — the same path as webmail, with the same
        DKIM signature and the same verified-domain rule. It is not a login: a key
        can send and nothing else.
      </p>

      <OrgKeysCard onError={setError} />

      <h2 className="mb-1 mt-8 text-lg font-semibold text-ink">Mail API keys</h2>
      <p className="mb-3 text-[0.75rem] text-ink-muted">
        A separate kind of key, for sending mail. It cannot add people, and an organisation key
        cannot send mail — two keys, two blast radiuses.
      </p>

      <Card padded={false} className="mb-4">
        {keys === null ? (
          <Spinner />
        ) : keys.length === 0 ? (
          <Empty
            title="No API keys yet"
            hint="Create one per program that sends — a website form and a billing job are different keys, so revoking one never breaks the other."
            action={<Button variant="primary" onClick={() => setCreating(true)}>New API key</Button>}
          />
        ) : (
          <Table head={['What it is for', 'Key', 'Created', 'Last used', 'Restrictions', '']}>
            {keys.map((k) => (
              <tr key={k.id}>
                <Td><span className="font-semibold">{k.label}</span></Td>
                <Td><code className="text-[0.75rem]">{k.keyPrefix}…</code></Td>
                <Td>{when(k.createdAt)}</Td>
                <Td>
                  {k.lastUsedAt
                    ? when(k.lastUsedAt)
                    : <Badge tone="neutral">never</Badge>}
                </Td>
                <Td>
                  {k.allowedCount && k.allowedCount > 0 && (
                    <span title={k.allowedAddresses?.join(', ')}>
                      🔒 {k.allowedCount}
                    </span>
                  )}
                </Td>
                <Td>
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" onClick={() => setEditingKey(k)}>
                      Edit addresses
                    </Button>
                    <Button variant="ghost" onClick={() => setRevoking(k)}>
                      <span className="text-danger">Revoke</span>
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <HowToUse endpoint={endpoint} />

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={async (k) => {
            setCreating(false);
            setFresh(k);
            setNotice(null);
            await load();
          }}
          onError={setError}
        />
      )}

      {editingKey && (
        <EditDialog
          key={editingKey.id}
          keyRow={editingKey}
          onClose={() => setEditingKey(null)}
          onUpdated={async () => {
            setEditingKey(null);
            setNotice('Allowed addresses updated.');
            await load();
          }}
          onError={setError}
        />
      )}

      {revoking && (
        <Modal
          title="Revoke this key?"
          onClose={() => setRevoking(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRevoking(null)}>Keep it</Button>
              <Button variant="primary" onClick={() => void revoke(revoking)}>
                Revoke &quot;{revoking.label}&quot;
              </Button>
            </>
          }
        >
          <p className="mb-2">
            Anything still using <strong>{revoking.label}</strong> (<code>{revoking.keyPrefix}…</code>)
            will get <code>401</code> from the next request onwards.
          </p>
          <p className="text-[0.75rem] text-ink-muted mb-0">
            Mail already accepted for delivery is not recalled. This cannot be
            undone — create a new key instead.
          </p>
        </Modal>
      )}
    </AdminShell>
  );
}

/**
 * Organisation API keys — a customer's own software adding their people
 * (Amit, 18 September 2026).
 *
 * DELIBERATELY ITS OWN SECTION, above the mail keys and not mixed with them.
 * The two look alike and are not alike: this one creates sign-in identities.
 * An administrator choosing between them should see that in the words, not
 * work it out from a scope name.
 */
function OrgKeysCard({ onError }: { onError: (m: string) => void }) {
  const { authedFetch } = useAuth();
  const [rows, setRows] = useState<OrgKeyRow[] | null>(null);
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
      if (!r.ok) throw new Error('Could not load the organisation keys.');
      setRows((await r.json()) as OrgKeyRow[]);
    } catch (e) { onError((e as Error).message); setRows([]); }
  }, [authedFetch, onError]);
  useEffect(() => { void load(); }, [load]);

  const revoke = async (k: OrgKeyRow) => {
    try {
      const r = await authedFetch(`/org/keys/${k.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Could not revoke the key.');
      if (fresh && fresh.label === k.label) setFresh(null);
      await load();
    } catch (e) { onError((e as Error).message); }
  };

  const live = (rows ?? []).filter((k) => !k.revokedAt);

  return (
    <>
      <div className="mb-1 mt-2 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-ink">Organisation API keys</h2>
        <Button variant="primary" onClick={() => setCreating(true)}>New organisation key</Button>
      </div>
      <p className="mb-3 text-[0.75rem] text-ink-muted">
        Lets your own software — a student system, an HR package — add people to this organisation
        without anyone typing them in. Each person added this way gets an invitation to set their own
        password, exactly as if you had added them here. <strong>A key can add ordinary people and
        cannot make anyone an administrator.</strong>
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
                    onClick={() => { void navigator.clipboard.writeText(fresh.key).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); }}>
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
            title="No organisation keys yet"
            hint="Create one per program that adds people. Revoking one never affects another."
            action={<Button variant="primary" onClick={() => setCreating(true)}>New organisation key</Button>}
          />
        ) : (
          <Table head={['What it is for', 'Key', 'May do', 'Added by', 'Last used', '']}>
            {live.map((k) => (
              <tr key={k.id}>
                <Td><span className="font-semibold">{k.label}</span></Td>
                <Td><code className="text-[0.75rem]">{k.keyPrefix}…</code></Td>
                <Td><span className="text-[0.75rem]">{k.scopes.map(orgScopeLabel).join(', ')}</span></Td>
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

      {creating && (
        <NewOrgKeyDialog
          onClose={() => setCreating(false)}
          onCreated={async (k) => { setCreating(false); setFresh(k); await load(); }}
          onError={onError}
        />
      )}
    </>
  );
}

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

/** The one scope that exists, in the words an administrator reads. */
const ORG_SCOPES: { scope: string; label: string; hint: string }[] = [
  {
    scope: 'people:admit',
    label: 'Add people to this organisation',
    hint: 'Creates the person and sends them an invitation. It cannot make anyone an administrator, and it cannot set anyone a password.',
  },
];
function orgScopeLabel(scope: string): string {
  return ORG_SCOPES.find((s) => s.scope === scope)?.label ?? scope;
}

function NewOrgKeyDialog({ onClose, onCreated, onError }: {
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
      title="New organisation key"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy || label.trim().length < 2 || scopes.length === 0}>
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </>
      }
    >
      <Field label="What is this key for?" required hint="The program that will use it. You will see this name when deciding what to revoke.">
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

function FreshKeyCard({ fresh, endpoint, onDismiss }: {
  fresh: { key: string; label: string; allowed_sender_addresses?: string[] };
  endpoint: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<'key' | 'example' | null>(null);

  const example = curlExample(endpoint, fresh.key, fresh.allowed_sender_addresses?.[0] || 'website@your-domain.com');

  const copy = async (what: 'key' | 'example', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard can be refused
    }
  };

  return (
    <Card className="mb-4 border-ok">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <div className="font-semibold">Your new key for &quot;{fresh.label}&quot;</div>
          <div className="text-[0.75rem] text-danger font-semibold">
            This is the only time it will be shown. Copy it now — once you leave this
            page it cannot be recovered, only replaced.
          </div>
        </div>
        <IconButton label="Dismiss" className="h-8 w-8 border-0 bg-transparent" onClick={onDismiss}>
          ✕
        </IconButton>
      </div>

      {/* The field and its Copy button are one control, so the button cannot
          wrap away from the key it copies. */}
      <div className="flex items-stretch mb-4">
        <Input readOnly value={fresh.key} className="rounded-r-none"
               onFocus={(e) => e.currentTarget.select()} />
        <Button variant="primary" className="rounded-l-none"
                onClick={() => void copy('key', fresh.key)}>
          {copied === 'key' ? 'Copied' : 'Copy key'}
        </Button>
      </div>

      {fresh.allowed_sender_addresses && fresh.allowed_sender_addresses.length > 0 && (
        <Alert tone="info" className="mb-2 text-[0.75rem]">
          <strong>Allowed to send from:</strong> {fresh.allowed_sender_addresses.join(', ')}
        </Alert>
      )}

      <div className="text-[0.75rem] text-ink-muted mb-1">
        A complete first send, with this key already filled in. Replace the two
        addresses and run it — <strong>202</strong> means it worked.
      </div>
      <pre className="bg-canvas rounded p-4 text-[0.75rem] mb-2" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {example}
      </pre>
      <Button variant="secondary" onClick={() => void copy('example', example)}>
        {copied === 'example' ? 'Copied' : 'Copy example'}
      </Button>
    </Card>
  );
}

function HowToUse({ endpoint }: { endpoint: string }) {
  return (
    <Card title="How to send mail with a key" subtitle="Three steps. The whole API is one request.">
      <p className="text-[0.8125rem] text-ink-muted mb-4">
        Handing this to a developer? The{' '}
        <a href="/docs/TatvaOS-Mail-API-Integration-Guide.pdf" download>integration guide (PDF)</a>{' '}
        has everything on this page plus working examples in curl, Node.js, Python and PHP.
      </p>
      <ol className="ps-4 mb-6">
        <li className="mb-4">
          <div className="font-semibold">Choose the sender</div>
          <div className="text-[0.8125rem] text-ink-muted">
            The <code>from</code> address must be in your key&apos;s allowed addresses. Create a key
            and select which mailboxes it can send from. Set one up under{' '}
            <Link href="/org/mailboxes">Shared mailboxes</Link>; verify the domain under{' '}
            <Link href="/org/domains">Domains</Link>.
          </div>
        </li>
        <li className="mb-4">
          <div className="font-semibold">Create a key</div>
          <div className="text-[0.8125rem] text-ink-muted">
            One per program. Name it for what it does and select the email addresses it can send from.
            The key is shown once.
          </div>
        </li>
        <li className="mb-0">
          <div className="font-semibold">Send</div>
          <div className="text-[0.8125rem] text-ink-muted mb-2">
            One <code>POST</code>, JSON body, the key in the <code>Authorization</code> header.
          </div>
          <pre className="bg-canvas rounded p-4 text-[0.75rem] mb-0" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {`POST ${endpoint}
Authorization: Bearer tvos_…
Content-Type: application/json

{
  "from":    "website@your-domain.com",
  "to":      "someone@example.com",
  "subject": "Thanks for getting in touch",
  "text":    "We received your message and will reply within a day.",
  "html":    "<p>We received your message and will reply within a day.</p>"
}`}
          </pre>
        </li>
      </ol>

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <div className="font-semibold mb-2">Fields</div>
          <table className="w-full border-collapse text-[0.8125rem] mb-0 [&_td]:border-b [&_td]:border-line [&_td]:py-1.5 [&_td]:pr-3 [&_td]:align-top">
            <tbody>
              <tr><td><code>from</code></td><td>Required. Must be in your key&apos;s allowed addresses.</td></tr>
              <tr><td><code>to</code></td><td>Required. Up to {MAX_RECIPIENTS} addresses, separated by commas.</td></tr>
              <tr><td><code>subject</code></td><td>Required.</td></tr>
              <tr><td><code>text</code></td><td>Plain-text body. Give <code>text</code>, <code>html</code>, or both.</td></tr>
              <tr><td><code>html</code></td><td>HTML body. Both together is best — each receiver picks.</td></tr>
              <tr><td><code>replyTo</code></td><td>Optional. Where replies should go if not the sender.</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <div className="font-semibold mb-2">What comes back</div>
          <table className="w-full border-collapse text-[0.8125rem] mb-0 [&_td]:border-b [&_td]:border-line [&_td]:py-1.5 [&_td]:pr-3 [&_td]:align-top">
            <tbody>
              <tr>
                <td><Badge tone="ok">202</Badge></td>
                <td>Accepted for delivery. Our server has it and will deliver it.</td>
              </tr>
              <tr>
                <td><Badge tone="warn">400</Badge></td>
                <td>Something in the request. The message says which field, or which addresses the key allows.</td>
              </tr>
              <tr>
                <td><Badge tone="warn">401</Badge></td>
                <td>The key is missing, wrong, or revoked.</td>
              </tr>
              <tr>
                <td><Badge tone="danger">502</Badge></td>
                <td>Our mail server refused it. Usually the sender&apos;s domain is not verified.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <Alert tone="info" className="text-[0.75rem] mt-6 mb-0">
        <strong>First messages from a new address often land in spam.</strong> That is the
        receiver&apos;s reputation system, not a fault here — every message is DKIM-signed and
        passes SPF and DMARC. Reputation builds with real mail people open and reply to.
      </Alert>
    </Card>
  );
}

function curlExample(endpoint: string, key: string, from: string): string {
  return `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"from":"${from}","to":"you@example.com","subject":"Hello from TatvaOS","text":"It works."}'`;
}

function CreateDialog({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: (k: { key: string; label: string; allowed_sender_addresses?: string[] }) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [label, setLabel] = useState('');
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>([]);
  const [mailboxes, setMailboxes] = useState<string[]>([]);
  const [loadingMailboxes, setLoadingMailboxes] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const loadMailboxes = async () => {
      setLoadingMailboxes(true);
      try {
        const r = await authedFetch('/org/mailboxes');
        if (r.ok) {
          const data = await r.json();
          setMailboxes((data.mailboxes || []).map((m: { address: string }) => m.address).sort());
        }
      } catch (e) {
        console.error('Failed to load mailboxes:', e);
      } finally {
        setLoadingMailboxes(false);
      }
    };
    void loadMailboxes();
  }, [authedFetch]);

  async function create() {
    if (selectedAddresses.length === 0) {
      onError('Select at least one email address.');
      return;
    }

    setBusy(true);
    try {
      const r = await authedFetch('/mail/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          label: label.trim(),
          allowedSenderAddresses: selectedAddresses,
        }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error ?? 'Could not create the key.');
      await onCreated({
        key: b.key,
        label: b.label,
        allowed_sender_addresses: b.allowed_sender_addresses,
      });
    } catch (e) {
      onError((e as Error).message);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New API key"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void create()}
            disabled={busy || label.trim().length === 0 || selectedAddresses.length === 0}
          >
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </>
      }
    >
      <Field
        label="What is this key for?"
        required
        hint="The program that will use it. You will see this name when deciding what to revoke."
      >
        <Input
          
          value={label}
          placeholder="Website contact form"
          maxLength={100}
          autoFocus
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && label.trim() && selectedAddresses.length > 0 && !busy) {
              void create();
            }
          }}
        />
      </Field>

      <Field
        label="Send from addresses"
        required
        hint="Select at least one email address this key can send from. The key will only work with these addresses."
      >
        {loadingMailboxes ? (
          <div className="text-ink-muted text-[0.8125rem]">Loading mailboxes...</div>
        ) : mailboxes.length === 0 ? (
          <Alert tone="warn" className="mb-0 text-[0.75rem]">
            No active mailboxes found. Create mailboxes under{' '}
            <Link href="/org/mailboxes">Shared mailboxes</Link> first.
          </Alert>
        ) : (
          <div className="rounded-lg border border-line" style={{ maxHeight: 250, overflowY: 'auto' }}>
            {mailboxes.map((addr) => (
              <label key={addr} className="block border-b border-line p-2 last:border-0" style={{ cursor: 'pointer', marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={selectedAddresses.includes(addr)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedAddresses([...selectedAddresses, addr]);
                    } else {
                      setSelectedAddresses(selectedAddresses.filter((a) => a !== addr));
                    }
                  }}
                  className="me-2"
                />
                <code className="text-[0.8125rem]">{addr}</code>
              </label>
            ))}
          </div>
        )}
      </Field>

      <Alert tone="info" className="mb-0 text-[0.75rem]">
        The key is shown <strong>once</strong>, on the next screen. Have somewhere ready to paste it.
      </Alert>
    </Modal>
  );
}

function EditDialog({ keyRow, onClose, onUpdated, onError }: {
  keyRow: KeyRow;
  onClose: () => void;
  onUpdated: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [selectedAddresses, setSelectedAddresses] = useState<string[]>(keyRow.allowedAddresses || []);
  const [mailboxes, setMailboxes] = useState<string[]>([]);
  const [loadingMailboxes, setLoadingMailboxes] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const loadMailboxes = async () => {
      setLoadingMailboxes(true);
      try {
        const r = await authedFetch('/org/mailboxes');
        if (r.ok) {
          const data = await r.json();
          setMailboxes((data.mailboxes || []).map((m: { address: string }) => m.address).sort());
        }
      } catch (e) {
        console.error('Failed to load mailboxes:', e);
      } finally {
        setLoadingMailboxes(false);
      }
    };
    void loadMailboxes();
  }, [authedFetch]);

  async function update() {
    if (selectedAddresses.length === 0) {
      onError('Select at least one email address.');
      return;
    }

    setBusy(true);
    try {
      const r = await authedFetch(`/mail/api-keys/${keyRow.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          allowedSenderAddresses: selectedAddresses,
        }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error ?? 'Could not update the key.');
      onClose();
      await onUpdated();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit allowed addresses for "${keyRow.label}"`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void update()}
            disabled={busy || selectedAddresses.length === 0}
          >
            {busy ? 'Updating…' : 'Update'}
          </Button>
        </>
      }
    >
      <p className="text-[0.8125rem] text-ink-muted mb-4">
        Select which email addresses this key can send from.
      </p>

      {loadingMailboxes ? (
        <div className="text-ink-muted text-[0.8125rem]">Loading mailboxes...</div>
      ) : mailboxes.length === 0 ? (
        <Alert tone="warn" className="mb-0 text-[0.75rem]">No active mailboxes found.</Alert>
      ) : (
        <div className="rounded-lg border border-line" style={{ maxHeight: 250, overflowY: 'auto' }}>
          {mailboxes.map((addr) => (
            <label key={addr} className="block border-b border-line p-2 last:border-0" style={{ cursor: 'pointer', marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={selectedAddresses.includes(addr)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedAddresses([...selectedAddresses, addr]);
                  } else {
                    setSelectedAddresses(selectedAddresses.filter((a) => a !== addr));
                  }
                }}
                className="me-2"
              />
              <code className="text-[0.8125rem]">{addr}</code>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}
