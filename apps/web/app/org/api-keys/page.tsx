'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Mail API keys — the credential an organisation's own software uses to send
//  through POST /api/v1/mail/send.
//
//  Shaped on mail/settings/app-passwords, which solved the same problem: a
//  secret that renders ONCE, in the response to Create, and is never
//  retrievable afterwards. This screen's job is to make that one showing
//  count — big, monospaced, one copy button, and an unmissable line saying it
//  disappears when you leave.
//
//  The second job, added 3 Sept after the first real send: the page IS the
//  documentation. An admin who has never seen the API should be able to
//  create a key, read the three steps, copy the example, and get a 202 —
//  without a developer, a PDF, or a message to support. Every response code
//  the endpoint returns is explained here in the words it uses.
//
//  Unlike app passwords there can be MANY active keys: a website and a
//  billing job are different credentials with different revocation
//  lifetimes. So creating one does not revoke another.
// ============================================================================

interface KeyRow {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
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
  const [fresh, setFresh] = useState<{ key: string; label: string } | null>(null);
  const [endpoint, setEndpoint] = useState('https://core.tatvaos.com/api/v1/mail/send');

  // The endpoint is this same host — Caddy routes /api/* to the API. Read it
  // from the browser so local and production both show the address that
  // actually works from where the admin is sitting.
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
      setNotice(`“${k.label}” is revoked. Requests using it are refused from now on.`);
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
        <Button variant="primary" onClick={() => setCreating(true)}>
          New API key
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
                           borderTopColor: '#03b562' }} />
          </div>
        ) : keys.length === 0 ? (
          <Empty
            title="No API keys yet"
            hint="Create one per program that sends — a website form and a billing job are different keys, so revoking one never breaks the other."
            action={<Button variant="primary" onClick={() => setCreating(true)}>New API key</Button>}
          />
        ) : (
          <Table head={['What it is for', 'Key', 'Created', 'Last used', '']}>
            {keys.map((k) => (
              <tr key={k.id}>
                <Td><span className="fw-semibold">{k.label}</span></Td>
                <Td><code className="fs-12">{k.keyPrefix}…</code></Td>
                <Td>{when(k.createdAt)}</Td>
                <Td>
                  {/* NULL means never used, and it can be read that way —
                      this column has a writer (the send endpoint). */}
                  {k.lastUsedAt
                    ? when(k.lastUsedAt)
                    : <Badge tone="neutral">never</Badge>}
                </Td>
                <Td>
                  <div className="d-flex justify-content-end">
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

      {revoking && (
        <Modal
          title="Revoke this key?"
          onClose={() => setRevoking(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRevoking(null)}>Keep it</Button>
              <Button variant="primary" onClick={() => void revoke(revoking)}>
                Revoke “{revoking.label}”
              </Button>
            </>
          }
        >
          <p className="mb-2">
            Anything still using <strong>{revoking.label}</strong> (<code>{revoking.keyPrefix}…</code>)
            will get <code>401</code> from the next request onwards.
          </p>
          {/* Says exactly what revoking does and no more. Mail already handed
              to Postfix is not recalled, and a dialog that implies otherwise
              is the kind of half-true this codebase has spent a fortnight
              removing. */}
          <p className="fs-12 text-muted mb-0">
            Mail already accepted for delivery is not recalled. This cannot be
            undone — create a new key instead.
          </p>
        </Modal>
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
//  The one showing. Big, monospaced, copyable, and honest about the fact that
//  it is the last time anyone will see it.
// ---------------------------------------------------------------------------
function FreshKeyCard({ fresh, endpoint, onDismiss }: {
  fresh: { key: string; label: string };
  endpoint: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<'key' | 'example' | null>(null);

  const example = curlExample(endpoint, fresh.key);

  const copy = async (what: 'key' | 'example', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard can be refused (insecure context, permissions). The text is
      // on screen and selectable; nothing else to do.
    }
  };

  return (
    <Card className="mb-3 border-success">
      <div className="d-flex align-items-start justify-content-between gap-3 mb-2">
        <div>
          <div className="fw-semibold">Your new key for “{fresh.label}”</div>
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

// ---------------------------------------------------------------------------
//  The documentation, on the page, in the order someone actually does it.
// ---------------------------------------------------------------------------
function HowToUse({ endpoint }: { endpoint: string }) {
  return (
    <Card title="How to send mail with a key" subtitle="Three steps. The whole API is one request.">
      <ol className="ps-3 mb-4">
        <li className="mb-3">
          <div className="fw-semibold">Choose the sender</div>
          <div className="fs-13 text-muted">
            The <code>from</code> address must be a mailbox on this organisation, on a domain
            you have verified — a shared mailbox such as <code>noreply@</code> or{' '}
            <code>website@</code> is the usual choice. Set one up under{' '}
            <Link href="/org/mailboxes">Shared mailboxes</Link>; verify the domain under{' '}
            <Link href="/org/domains">Domains</Link>. Anything else is refused with a{' '}
            <code>400</code> that names the address.
          </div>
        </li>
        <li className="mb-3">
          <div className="fw-semibold">Create a key</div>
          <div className="fs-13 text-muted">
            One per program. Name it for what it does — the name is how you will know
            what to revoke later. The key is shown once.
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
              <tr><td><code>from</code></td><td>Required. A mailbox on this organisation.</td></tr>
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
                <td>Accepted for delivery. Our server has it and will deliver it. This is
                  not confirmation that it <em>arrived</em> — no mail API can promise that.</td>
              </tr>
              <tr>
                <td><Badge tone="warn">400</Badge></td>
                <td>Something in the request. The message says which field.</td>
              </tr>
              <tr>
                <td><Badge tone="warn">401</Badge></td>
                <td>The key is missing, wrong, or revoked. All three get the same answer on purpose.</td>
              </tr>
              <tr>
                <td><Badge tone="danger">502</Badge></td>
                <td>Our mail server refused it. The message carries its exact reason —
                  most often the sender’s domain is not verified.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="alert alert-info fs-12 mt-4 mb-0">
        <strong>First messages from a new address often land in spam.</strong> That is the
        receiver’s reputation system, not a fault here — every message is DKIM-signed and
        passes SPF and DMARC. Reputation builds with real mail people open and reply to.
        Send from an address you will keep using, write like a person, and start small.
      </div>
    </Card>
  );
}

function curlExample(endpoint: string, key: string): string {
  return `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"from":"website@your-domain.com","to":"you@example.com","subject":"Hello from TatvaOS","text":"It works."}'`;
}

// ---------------------------------------------------------------------------
function CreateDialog({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: (k: { key: string; label: string }) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const r = await authedFetch('/mail/api-keys', {
        method: 'POST', body: JSON.stringify({ label: label.trim() }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error ?? 'Could not create the key.');
      await onCreated({ key: b.key, label: b.label });
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
          <Button variant="primary" onClick={() => void create()} disabled={busy || label.trim().length === 0}>
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
        <input className="form-control" value={label} placeholder="Website contact form"
               maxLength={100} autoFocus
               onChange={(e) => setLabel(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) void create(); }} />
      </Field>

      <div className="alert alert-info mb-0 fs-12">
        The key is shown <strong>once</strong>, on the next screen. Have somewhere ready
        to paste it.
      </div>
    </Modal>
  );
}
