'use client';

/**
 * Applications — the relying parties an organisation admin registers so
 * their other software signs people in with TatvaOS (decision 0004, stage 4).
 *
 * Register (client id shown, secret shown ONCE), list, the "allowed for
 * everyone" switch, and revoke. The API is stage 1's /api/org/applications;
 * this is the screen 0004 calls the Applications screen.
 *
 * WHAT THE REVOKE DIALOG SAYS is specified by 0004, word for word where it
 * matters: revocation stops new sign-ins, refresh tokens and access tokens at
 * once, and it cannot recall an ID token already delivered or end the
 * application's own session — "People already signed in to <app> stay
 * signed in there until <app> signs them out."
 */

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, IconButton, Spinner, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { Checkbox, Input, Switch, Textarea } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

interface Declared {
  description: string | null;
  operatorName: string | null;
  clientUri: string | null;
  policyUri: string | null;
  tosUri: string | null;
  contacts: string | null;
}

interface AppRow {
  id: string;
  clientId: string;
  name: string;
  clientType: 'confidential' | 'public' | string;
  redirectUris: string[];
  scopes: string[];
  allowedForEveryone: boolean;
  secretPrefix: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** What whoever registered it says about it. Checked by nobody. */
  declared: Declared;
  /** Our copy of the logo, or null. Never the application's own address. */
  logoUri: string | null;
}

/**
 * What an application may receive, in the words an administrator chooses
 * between. The same three the API offers (OidcApplicationEndpoints.Offerable);
 * `openid` is not here because signing in is the point, not an extra.
 *
 * THESE TICKS ARE REAL. An unticked scope is never written as a permission
 * and the provider refuses a request that asks for it, so unticking "work
 * email address" genuinely stops the application receiving it.
 *
 * offline_access is off by default and is described by what it does. It is
 * the most powerful of the three and must not read as the mildest (CTO,
 * 18 Sept 2026).
 */
const OFFERABLE: { scope: string; label: string; hint: string; defaultOn: boolean }[] = [
  { scope: 'profile', label: 'View their name', hint: 'The display name on their TatvaOS account.', defaultOn: true },
  { scope: 'email', label: 'View their work email address', hint: 'Their address in your organisation.', defaultOn: true },
  {
    scope: 'offline_access',
    label: 'Access their information when they are not using the application',
    hint: 'The application can reach their name, email and organisation for up to fourteen days at a time while they are elsewhere. Only tick this if it genuinely needs to work in the background.',
    defaultOn: false,
  },
];

function scopeLabel(scope: string): string {
  return OFFERABLE.find((o) => o.scope === scope)?.label ?? scope;
}

interface Fresh {
  id: string;
  clientId: string;
  clientSecret: string | null;
  name: string;
  clientType: string;
  redirectUris: string[];
  /** A regenerated secret has no new URIs to show, only the secret itself. */
  secretOnly?: boolean;
}

const SCOPES = 'openid profile email offline_access';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

/** See the same helper on the consent screen: logoUri is the real path. */
function logoSrc(path: string): string {
  return API_BASE.endsWith('/api') ? API_BASE.slice(0, -4) + path : path;
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ApplicationsPage() {
  const { authedFetch } = useAuth();

  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AppRow | null>(null);
  const [regenerating, setRegenerating] = useState<AppRow | null>(null);
  const [editing, setEditing] = useState<AppRow | null>(null);
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [origin, setOrigin] = useState('https://core.tatvaos.com');

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await authedFetch('/org/applications');
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not load the applications.');
      setApps((await r.json()) as AppRow[]);
    } catch (e) {
      setError((e as Error).message);
      setApps([]);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const setConsent = async (a: AppRow, allowedForEveryone: boolean) => {
    setError(null);
    try {
      const r = await authedFetch(`/org/applications/${a.id}/consent`, {
        method: 'POST',
        body: JSON.stringify({ allowedForEveryone }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not change the setting.');
      setNotice(allowedForEveryone
        ? `"${a.name}" is allowed for everyone: people are no longer asked before it receives their name, email and organisation. This change is in the audit trail.`
        : `"${a.name}" asks each person the first time again.`);
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const regenerate = async (a: AppRow) => {
    setError(null);
    try {
      const r = await authedFetch(`/org/applications/${a.id}/secret`, { method: 'POST' });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error ?? 'Could not make a new secret.');
      setRegenerating(null);
      setNotice(null);
      setFresh({ ...b, name: a.name, clientType: a.clientType, redirectUris: a.redirectUris, secretOnly: true });
      await load();
    } catch (e) { setError((e as Error).message); setRegenerating(null); }
  };

  const revoke = async (a: AppRow) => {
    setError(null);
    try {
      const r = await authedFetch(`/org/applications/${a.id}/revoke`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not revoke the application.');
      setRevoking(null);
      setNotice(`"${a.name}" is revoked. New sign-ins, refresh tokens and access tokens are refused from now.`);
      if (fresh && fresh.id === a.id) setFresh(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const live = (apps ?? []).filter((a) => !a.revokedAt);
  const revoked = (apps ?? []).filter((a) => a.revokedAt);

  return (
    <AdminShell
      scope="organisation"
      title="Applications"
      subtitle="Let your other software sign people in with their TatvaOS account"
      actions={
        <div className="flex gap-2">
          {/* A real link, not a Button with href: Button renders a Next <Link>,
              which routes instead of opening the static page. */}
          <a href="/docs/sso-integration-guide.html" target="_blank" rel="noopener"
             className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink no-underline transition-colors hover:bg-canvas">
            Integration guide
          </a>
          <Button variant="primary" onClick={() => setCreating(true)}>
            New application
          </Button>
        </div>
      }
    >
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {fresh && <FreshCard fresh={fresh} origin={origin} onDismiss={() => setFresh(null)} />}

      <p className="text-[0.75rem] text-ink-muted mb-4">
        An application is a program of yours — payroll, accounting, HR — that signs its users
        in with TatvaOS instead of keeping passwords of its own. It receives a person&apos;s name,
        work email address and which organisation they belong to, and nothing else. Removing a
        person in TatvaOS ends their access to every application at their next sign-in.
      </p>

      <Card padded={false} className="mb-4">
        {apps === null ? (
          <Spinner />
        ) : live.length === 0 ? (
          <Empty
            title="No applications yet"
            hint="Register one per program. Each gets its own client id, so revoking one never breaks another."
            action={<Button variant="primary" onClick={() => setCreating(true)}>New application</Button>}
          />
        ) : (
          <Table head={['Application', 'Client id', 'Can receive', 'Secret', 'Returns to', 'Asks people', 'Since', '']}>
            {live.map((a) => (
              <tr key={a.id}>
                <Td>
                  <div className="flex items-center gap-2">
                    {a.logoUri ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logoSrc(a.logoUri)} alt="" className="h-6 w-6 rounded border border-line object-contain" />
                    ) : (
                      <span className="grid h-6 w-6 place-items-center rounded bg-canvas text-[0.625rem] font-bold text-ink-muted" aria-hidden="true">
                        {a.name.trim().charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="font-semibold">{a.name}</span>
                  </div>
                </Td>
                <Td><code className="text-[0.75rem]">{a.clientId}</code></Td>
                <Td>
                  <ul className="m-0 list-none p-0 text-[0.75rem]">
                    <li>Sign them in</li>
                    {a.scopes.filter((s) => s !== 'openid').map((s) => <li key={s}>{scopeLabel(s)}</li>)}
                  </ul>
                </Td>
                {/* Dots, never the value, and no Copy button: the secret is
                    hashed on the row and cannot be read back by anyone,
                    including us. A Copy button here would be a promise we
                    could only keep by storing it in a recoverable form
                    (CTO, 18 Sept 2026). */}
                <Td>
                  {a.clientType === 'confidential' ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[0.75rem] tracking-widest text-ink-muted" aria-label="hidden">•••••••••</span>
                      <Button variant="ghost" onClick={() => setRegenerating(a)}>New secret</Button>
                    </div>
                  ) : (
                    <span className="text-[0.75rem] text-ink-muted">None — uses PKCE</span>
                  )}
                </Td>
                <Td>
                  <span className="text-[0.75rem]">{a.redirectUris.map((u) => hostOf(u)).join(', ')}</span>
                </Td>
                <Td>
                  <Switch
                    label={<span className="text-[0.75rem]">{a.allowedForEveryone ? 'No — allowed for everyone' : 'Yes, the first time'}</span>}
                    checked={a.allowedForEveryone}
                    onChange={(e) => void setConsent(a, e.target.checked)}
                    className="mb-0"
                  />
                </Td>
                <Td>{when(a.createdAt)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" onClick={() => setEditing(a)}>Details</Button>
                    <Button variant="ghost" onClick={() => setRevoking(a)}>
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
        <Card title="Revoked" subtitle="Kept for the record. Nothing can sign in through these." padded={false} className="mb-4">
          <Table head={['Application', 'Client id', 'Revoked']}>
            {revoked.map((a) => (
              <tr key={a.id}>
                <Td><span className="text-ink-muted">{a.name}</span></Td>
                <Td><code className="text-[0.75rem] text-ink-muted">{a.clientId}</code></Td>
                <Td><Badge tone="neutral">{when(a.revokedAt!)}</Badge></Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <HowToConnect origin={origin} />

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={async (f) => {
            setCreating(false);
            setFresh(f);
            setNotice(null);
            await load();
          }}
          onError={setError}
        />
      )}

      {editing && (
        <DetailsDialog
          key={editing.id}
          app={editing}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => { setEditing(null); setNotice(msg); await load(); }}
          onError={setError}
        />
      )}

      {regenerating && (
        <Modal
          title={`Make a new secret for "${regenerating.name}"?`}
          onClose={() => setRegenerating(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRegenerating(null)}>Keep the current secret</Button>
              <Button variant="primary" onClick={() => void regenerate(regenerating)}>
                Make a new secret
              </Button>
            </>
          }
        >
          <p className="mb-2">
            <strong>{regenerating.name} will stop working the moment you do this</strong>, and nobody
            will be able to sign in to it until someone puts the new secret into its configuration.
          </p>
          <p className="mb-2">
            Do this if the secret has been seen by someone who should not have it, or if it has been
            lost. Have whoever looks after {regenerating.name} ready to paste the new one.
          </p>
          <p className="text-[0.75rem] text-ink-muted mb-0">
            The new secret is shown once, here, and cannot be shown again.
          </p>
        </Modal>
      )}

      {revoking && (
        <Modal
          title={`Revoke "${revoking.name}"?`}
          onClose={() => setRevoking(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRevoking(null)}>Keep it</Button>
              <Button variant="primary" onClick={() => void revoke(revoking)}>
                Revoke &quot;{revoking.name}&quot;
              </Button>
            </>
          }
        >
          <p className="mb-2">
            From now, nobody can sign in to <strong>{revoking.name}</strong> with TatvaOS, its
            refresh tokens stop working, and its access tokens are refused on their next call.
          </p>
          <p className="mb-2">
            People already signed in to <strong>{revoking.name}</strong> stay signed in there
            until <strong>{revoking.name}</strong> signs them out. That session belongs to the
            application, and TatvaOS cannot reach into it.
          </p>
          <p className="text-[0.75rem] text-ink-muted mb-0">
            An identity token it received in the last five minutes stays valid until it expires;
            that is why they live five minutes. This cannot be undone — register the application
            again instead, with a new client id.
          </p>
        </Modal>
      )}
    </AdminShell>
  );
}

function hostOf(uri: string): string {
  try { return new URL(uri).host; } catch { return uri; }
}

function FreshCard({ fresh, origin, onDismiss }: { fresh: Fresh; origin: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard can be refused */ }
  };

  return (
    <Card className="mb-4 border-ok">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <div className="font-semibold">
            {fresh.secretOnly ? <>A new secret for &quot;{fresh.name}&quot;</> : <>&quot;{fresh.name}&quot; is registered</>}
          </div>
          {fresh.clientSecret ? (
            <div className="text-[0.75rem] text-danger font-semibold">
              The client secret is shown this once. Put it in the application&apos;s own
              configuration now — it cannot be shown again, only replaced by registering again.
            </div>
          ) : (
            <div className="text-[0.75rem] text-ink-muted">
              A phone or browser application has no secret. It proves itself with PKCE on every sign-in.
            </div>
          )}
        </div>
        <IconButton label="Dismiss" className="h-8 w-8 border-0 bg-transparent" onClick={onDismiss}>✕</IconButton>
      </div>

      {fresh.secretOnly && (
        <p className="mb-3 text-[0.8125rem] text-danger">
          The previous secret stopped working just now. {fresh.name} cannot sign anyone in until this
          one is in its configuration.
        </p>
      )}

      <div className="text-[0.75rem] text-ink-muted mb-1">Client id</div>
      <div className="flex items-stretch mb-3">
        <Input readOnly value={fresh.clientId} className="rounded-r-none" onFocus={(e) => e.currentTarget.select()} />
        <Button variant="primary" className="rounded-l-none" onClick={() => void copy('id', fresh.clientId)}>
          {copied === 'id' ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {fresh.clientSecret && (
        <>
          <div className="text-[0.75rem] text-ink-muted mb-1">Client secret</div>
          <div className="flex items-stretch mb-3">
            <Input readOnly value={fresh.clientSecret} className="rounded-r-none" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="primary" className="rounded-l-none" onClick={() => void copy('secret', fresh.clientSecret!)}>
              {copied === 'secret' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </>
      )}

      <div className="text-[0.75rem] text-ink-muted mb-1">
        Give the application these, in whatever form its settings ask for them. Its developer
        will want the <a href="/docs/sso-integration-guide.html" target="_blank" rel="noopener">integration guide</a>.
      </div>
      <pre className="bg-canvas rounded p-4 text-[0.75rem] mb-0" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {`Provider / issuer:  ${origin}
Discovery:          ${origin}/.well-known/openid-configuration
Client id:          ${fresh.clientId}
Scopes:             ${SCOPES}
Redirect URI:       ${fresh.redirectUris.join('\n                    ')}
PKCE:               required, S256`}
      </pre>
    </Card>
  );
}

function HowToConnect({ origin }: { origin: string }) {
  return (
    <Card title="How an application connects" subtitle="Standard OpenID Connect. Most software has a settings page for exactly this.">
      <p className="text-[0.8125rem] text-ink-muted mb-4">
        Handing this to a developer? The{' '}
        <a href="/docs/sso-integration-guide.html" target="_blank" rel="noopener">integration guide</a>{' '}
        has every value, the flow request by request, the ID token&apos;s claims, and configuration
        for ASP.NET Core, Node.js and Python.
      </p>
      <ol className="ps-4 mb-4">
        <li className="mb-3">
          <div className="font-semibold">Register it here</div>
          <div className="text-[0.8125rem] text-ink-muted">
            A name, the https address it returns people to (matched exactly — no wildcards, no
            trailing slash unless it really is there), and whether it is a server application
            (gets a secret) or a phone or browser application (no secret, PKCE instead).
          </div>
        </li>
        <li className="mb-3">
          <div className="font-semibold">Give the application the client id and, for a server application, the secret</div>
          <div className="text-[0.8125rem] text-ink-muted">
            Plus the issuer, <code>{origin}</code>. Everything else it needs is in the discovery
            document at <code>{origin}/.well-known/openid-configuration</code>.
          </div>
        </li>
        <li className="mb-0">
          <div className="font-semibold">People sign in</div>
          <div className="text-[0.8125rem] text-ink-muted">
            The application sends them to TatvaOS; they sign in if they are not already; the first
            time, they are asked to allow the application — unless you switch that off for
            everyone in the organisation, which is recorded in the audit trail.
          </div>
        </li>
      </ol>
      <div className="text-[0.8125rem] text-ink-muted mb-0">
        What an application receives: the person&apos;s user id, name, work email address and
        organisation id. Never a password. Revoking an application here stops it at once;
        a person can also remove their own consent from their account page.
      </div>
    </Card>
  );
}

/**
 * What the application says about itself, and its logo.
 *
 * NONE OF THIS IS VERIFIED and the consent screen says so where a person
 * reads it. The logo is UPLOADED rather than linked: an address would mean
 * the consent screen fetches from the application's own server, handing it
 * every viewer's IP address before they agree to anything, and letting the
 * image change after approval (CTO, 18 Sept 2026).
 */
function DetailsDialog({ app, onClose, onSaved, onError }: {
  app: AppRow;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const { authedFetch } = useAuth();
  const d = app.declared ?? {} as Declared;
  const [description, setDescription] = useState(d.description ?? '');
  const [operatorName, setOperatorName] = useState(d.operatorName ?? '');
  const [clientUri, setClientUri] = useState(d.clientUri ?? '');
  const [policyUri, setPolicyUri] = useState(d.policyUri ?? '');
  const [tosUri, setTosUri] = useState(d.tosUri ?? '');
  const [contacts, setContacts] = useState(d.contacts ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await authedFetch(`/org/applications/${app.id}/identity`, {
        method: 'POST',
        body: JSON.stringify({ description, operatorName, clientUri, policyUri, tosUri, contacts }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not save.');
      await onSaved(`Saved what "${app.name}" says about itself.`);
    } catch (e) { onError((e as Error).message); onClose(); } finally { setBusy(false); }
  }

  async function upload(file: File) {
    setBusy(true);
    try {
      const r = await authedFetch(`/org/applications/${app.id}/logo`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not upload the logo.');
      await onSaved(`Logo updated for "${app.name}".`);
    } catch (e) { onError((e as Error).message); onClose(); } finally { setBusy(false); }
  }

  async function removeLogo() {
    setBusy(true);
    try {
      const r = await authedFetch(`/org/applications/${app.id}/logo`, { method: 'DELETE' });
      if (!r.ok) throw new Error('Could not remove the logo.');
      await onSaved(`Logo removed from "${app.name}".`);
    } catch (e) { onError((e as Error).message); onClose(); } finally { setBusy(false); }
  }

  return (
    <Modal
      title={`Details for "${app.name}"`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-[0.75rem] text-ink-muted">
        People see this on the sign-in screen, under &quot;What {app.name} says about itself&quot;, marked
        as unchecked. TatvaOS does not verify any of it — only that a web address looks like one.
      </p>

      <Field label="Logo" hint="PNG, JPEG or WebP, up to 64 KB. Kept by TatvaOS and served from here, never fetched from the application.">
        <div className="flex items-center gap-3">
          {app.logoUri ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoSrc(app.logoUri)} alt="" className="h-12 w-12 rounded-lg border border-line object-contain" />
          ) : (
            <span className="grid h-12 w-12 place-items-center rounded-lg border border-line bg-canvas text-ink-muted" aria-hidden="true">
              {app.name.trim().charAt(0).toUpperCase()}
            </span>
          )}
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy}
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
                 className="text-[0.75rem]" />
          {app.logoUri && <Button variant="ghost" onClick={() => void removeLogo()} disabled={busy}>Remove</Button>}
        </div>
      </Field>

      <Field label="What it does" hint="One or two sentences.">
        <Textarea value={description} rows={2} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Operated by" hint="The company or team that runs it.">
        <Input value={operatorName} maxLength={200} placeholder="Techvein IT Solutions Pvt. Ltd." onChange={(e) => setOperatorName(e.target.value)} />
      </Field>
      <Field label="Website">
        <Input value={clientUri} maxLength={500} placeholder="https://payroll.example.com" onChange={(e) => setClientUri(e.target.value)} />
      </Field>
      <Field label="Privacy policy">
        <Input value={policyUri} maxLength={500} placeholder="https://payroll.example.com/privacy" onChange={(e) => setPolicyUri(e.target.value)} />
      </Field>
      <Field label="Terms">
        <Input value={tosUri} maxLength={500} placeholder="https://payroll.example.com/terms" onChange={(e) => setTosUri(e.target.value)} />
      </Field>
      <Field label="Support email" hint="One or more addresses, separated by commas.">
        <Input value={contacts} maxLength={500} placeholder="support@example.com" onChange={(e) => setContacts(e.target.value)} />
      </Field>
    </Modal>
  );
}

function CreateDialog({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: (f: Fresh) => Promise<void>;
  onError: (m: string) => void;
}) {
  const { authedFetch } = useAuth();
  const [name, setName] = useState('');
  const [uris, setUris] = useState('');
  const [confidential, setConfidential] = useState(true);
  const [scopes, setScopes] = useState<string[]>(OFFERABLE.filter((o) => o.defaultOn).map((o) => o.scope));
  const [busy, setBusy] = useState(false);

  const redirectUris = uris.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const ready = name.trim().length >= 2 && redirectUris.length > 0 && !busy;

  async function create() {
    setBusy(true);
    try {
      const r = await authedFetch('/org/applications', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), redirectUris, confidential, scopes }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error ?? 'Could not register the application.');
      await onCreated(b as Fresh);
    } catch (e) {
      onError((e as Error).message);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New application"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={!ready}>
            {busy ? 'Registering…' : 'Register'}
          </Button>
        </>
      }
    >
      <Field label="Name" required hint="What people will see when they are asked to allow it.">
        <Input value={name} placeholder="Payroll" maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Redirect URIs" required hint="One per line. The https address the application returns people to, matched exactly.">
        <Textarea value={uris} rows={3} placeholder="https://payroll.example.com/auth/callback" onChange={(e) => setUris(e.target.value)} />
      </Field>
      <Checkbox
        label="Server application (gets a client secret)"
        hint="Untick for a phone or browser application, which cannot keep a secret and uses PKCE instead."
        checked={confidential}
        onChange={(e) => setConfidential(e.target.checked)}
      />

      <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
        <p className="mb-1 text-sm font-semibold text-ink">What may this application receive?</p>
        <p className="mb-3 text-[0.75rem] text-ink-muted">
          Give it the least it needs. Anything unticked is refused, even if the application asks for it.
        </p>
        <p className="mb-2 text-[0.8125rem] text-ink">Sign them in <span className="text-ink-muted">— always</span></p>
        {OFFERABLE.map((o) => (
          <Checkbox
            key={o.scope}
            label={o.label}
            hint={o.hint}
            checked={scopes.includes(o.scope)}
            onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, o.scope] : cur.filter((s) => s !== o.scope)))}
          />
        ))}
      </div>
    </Modal>
  );
}
