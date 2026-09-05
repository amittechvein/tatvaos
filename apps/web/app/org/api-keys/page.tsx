'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';

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
        <div className="d-flex gap-2">
          <a className="btn btn-secondary" href="/docs/TatvaOS-Mail-API-Integration-Guide.pdf" download>
            Integration guide (PDF)
          </a>
          <Button variant="primary" onClick={() => setCreating(true)}>
            New API key
          </Button>
        </div>
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

      {fresh && (
        <FreshKeyCard
          fresh={fresh}
          endpoint={endpoint}
          onDismiss={() => setFresh(null)}
        />
      )}

      <p className="fs-12 text-muted mb-3">
        A key lets a website form, a billing job or any other program of yours send
        mail as one of your mailboxes — the same path as webmail, with the same
        DKIM signature and the same verified-domain rule. It is not a login: a key
        can send and nothing else.
      </p>

      <Card padded={false} className="mb-3">
        {keys === null ? (
          <div className="d-flex justify-content-center py-5">
            <span className="d-inline-block animate-spin rounded-circle"
                  style={{ width: 30, height: 30, border: '3px solid rgba(0,0,0,.12)',
                           borderTopColor: '#6C3CE9' }} />
          </div>
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
                <Td><span className="fw-semibold">{k.label}</span></Td>
                <Td><code className="fs-12">{k.keyPrefix}…</code></Td>
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
                  <div className="d-flex gap-2 justify-content-end">
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
          <p className="fs-12 text-muted mb-0">
            Mail already accepted for delivery is not recalled. This cannot be
            undone — create a new key instead.
          </p>
        </Modal>
      )}
    </AdminShell>
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
    <Card className="mb-3 border-success">
      <div className="d-flex align-items-start justify-content-between gap-3 mb-2">
        <div>
          <div className="fw-semibold">Your new key for &quot;{fresh.label}&quot;</div>
          <div className="fs-12 text-danger fw-semibold">
            This is the only time it will be shown. Copy it now — once you leave this
            page it cannot be recovered, only replaced.
          </div>
        </div>
        <button type="button" className="btn-close" aria-label="Dismiss" onClick={onDismiss} />
      </div>

      <div className="input-group mb-3">
        <input className="form-control font-monospace" readOnly value={fresh.key}
               onFocus={(e) => e.currentTarget.select()} />
        <Button variant="primary" onClick={() => void copy('key', fresh.key)}>
          {copied === 'key' ? 'Copied' : 'Copy key'}
        </Button>
      </div>

      {fresh.allowed_sender_addresses && fresh.allowed_sender_addresses.length > 0 && (
        <div className="alert alert-info mb-2 fs-12">
          <strong>Allowed to send from:</strong> {fresh.allowed_sender_addresses.join(', ')}
        </div>
      )}

      <div className="fs-12 text-muted mb-1">
        A complete first send, with this key already filled in. Replace the two
        addresses and run it — <strong>202</strong> means it worked.
      </div>
      <pre className="bg-light rounded p-3 fs-12 mb-2" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
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
      <p className="fs-13 text-muted mb-3">
        Handing this to a developer? The{' '}
        <a href="/docs/TatvaOS-Mail-API-Integration-Guide.pdf" download>integration guide (PDF)</a>{' '}
        has everything on this page plus working examples in curl, Node.js, Python and PHP.
      </p>
      <ol className="ps-3 mb-4">
        <li className="mb-3">
          <div className="fw-semibold">Choose the sender</div>
          <div className="fs-13 text-muted">
            The <code>from</code> address must be in your key&apos;s allowed addresses. Create a key
            and select which mailboxes it can send from. Set one up under{' '}
            <Link href="/org/mailboxes">Shared mailboxes</Link>; verify the domain under{' '}
            <Link href="/org/domains">Domains</Link>.
          </div>
        </li>
        <li className="mb-3">
          <div className="fw-semibold">Create a key</div>
          <div className="fs-13 text-muted">
            One per program. Name it for what it does and select the email addresses it can send from.
            The key is shown once.
          </div>
        </li>
        <li className="mb-0">
          <div className="fw-semibold">Send</div>
          <div className="fs-13 text-muted mb-2">
            One <code>POST</code>, JSON body, the key in the <code>Authorization</code> header.
          </div>
          <pre className="bg-light rounded p-3 fs-12 mb-0" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
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

      <div className="row g-4">
        <div className="col-md-6">
          <div className="fw-semibold mb-2">Fields</div>
          <table className="table table-sm fs-13 mb-0">
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
        <div className="col-md-6">
          <div className="fw-semibold mb-2">What comes back</div>
          <table className="table table-sm fs-13 mb-0">
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

      <div className="alert alert-info fs-12 mt-4 mb-0">
        <strong>First messages from a new address often land in spam.</strong> That is the
        receiver&apos;s reputation system, not a fault here — every message is DKIM-signed and
        passes SPF and DMARC. Reputation builds with real mail people open and reply to.
      </div>
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
        <input
          className="form-control"
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
          <div className="text-muted fs-13">Loading mailboxes...</div>
        ) : mailboxes.length === 0 ? (
          <div className="alert alert-warning mb-0 fs-12">
            No active mailboxes found. Create mailboxes under{' '}
            <Link href="/org/mailboxes">Shared mailboxes</Link> first.
          </div>
        ) : (
          <div style={{ maxHeight: 250, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 4 }}>
            {mailboxes.map((addr) => (
              <label key={addr} className="d-block p-2 border-bottom" style={{ cursor: 'pointer', marginBottom: 0 }}>
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
                <code className="fs-13">{addr}</code>
              </label>
            ))}
          </div>
        )}
      </Field>

      <div className="alert alert-info mb-0 fs-12">
        The key is shown <strong>once</strong>, on the next screen. Have somewhere ready to paste it.
      </div>
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
      <p className="fs-13 text-muted mb-3">
        Select which email addresses this key can send from.
      </p>

      {loadingMailboxes ? (
        <div className="text-muted fs-13">Loading mailboxes...</div>
      ) : mailboxes.length === 0 ? (
        <div className="alert alert-warning mb-0 fs-12">No active mailboxes found.</div>
      ) : (
        <div style={{ maxHeight: 250, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 4 }}>
          {mailboxes.map((addr) => (
            <label key={addr} className="d-block p-2 border-bottom" style={{ cursor: 'pointer', marginBottom: 0 }}>
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
              <code className="fs-13">{addr}</code>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}
