'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '@/lib/dates';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, IconButton, Meter, Table, Td, statusTone } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { UserPhoto } from '@/components/ui/UserPhoto';
import { PhotoPicker } from '@/components/ui/PhotoPicker';
import { AddManyPeople } from '@/components/org/AddManyPeople';
import { avatarObjectUrl, bustAvatar } from '@/lib/avatars';
import { Input, InputSuffix, Select, Switch } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';

const GB = 1024 ** 3;

interface Dept {
  id: string; parentId: string | null; name: string;
  effectiveQuotaBytes: number | null; canSendExternal: boolean;
  defaultRole: string; defaultProducts: string[]; colour: string;
  children: Dept[];
}

interface Person {
  id: string; email: string; displayName: string;
  mailboxAddress: string | null;
  departmentId: string | null; departmentName?: string;
  role: string; status: string; products: string[];
  quotaBytes: number; usedBytes: number;
  mfaEnabled: boolean; lastLoginAt: string | null;
  hasVerifiedRecoveryEmail?: boolean;
  hasAvatar?: boolean;
}

interface DomainOpt { id: string; fqdn: string; isActive: boolean; ownershipVerified: boolean }

/** Depth-first flatten, so a <select> can show the hierarchy with indentation. */
function flatten(nodes: Dept[], depth = 0): { d: Dept; depth: number }[] {
  return nodes.flatMap((d) => [{ d, depth }, ...flatten(d.children, depth + 1)]);
}

/**
 * Role choices, shared by both dialogs so they cannot drift apart.
 *
 * "Owner" appears only for someone who IS an owner — the server enforces the
 * same rule, this just avoids offering a choice that will be refused. An
 * admin editing an existing owner still sees the role, read-only.
 */
function roleOptions(canMakeOwner: boolean, currentRole?: string) {
  const roles: [string, string][] = [
    ['org_admin', 'Admin'], ['it_admin', 'IT admin'], ['manager', 'Manager'],
    ['employee', 'Employee'], ['auditor', 'Auditor'],
  ];
  if (canMakeOwner || currentRole === 'org_owner') roles.unshift(['org_owner', 'Owner']);
  return roles;
}

function fmt(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= GB) return `${Math.round(bytes / GB)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export default function PeoplePage() {
  const { authedFetch } = useAuth();

  const [people, setPeople] = useState<Person[]>([]);
  const [tree, setTree] = useState<Dept[]>([]);
  const [domains, setDomains] = useState<DomainOpt[]>([]);
  const [poolFloor, setPoolFloor] = useState<number>(15 * GB);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [filterDept, setFilterDept] = useState('all');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Person | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, d, dom] = await Promise.all([
        authedFetch('/org/users'),
        authedFetch('/org/departments'),
        authedFetch('/org/domains'),
      ]);
      if (u.ok) setPeople(await u.json());
      if (d.ok) {
        const body = await d.json();
        setTree(body.tree ?? []);
        setPoolFloor(body.storage?.perUserFloor ?? 15 * GB);
      }
      if (dom.ok) setDomains(await dom.json());
      setError(null);
    } catch {
      setError('Could not load people.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const flat = useMemo(() => flatten(tree), [tree]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => {
      const matchDept = filterDept === 'all' || p.departmentId === filterDept;
      const matchQ = !q
        || p.displayName.toLowerCase().includes(q)
        || p.email.toLowerCase().includes(q);
      return matchDept && matchQ;
    });
  }, [people, filterDept, query]);

  // Mailboxes can only be created on a domain that is verified AND routing
  // here. Offering an unverified one produces an account whose mail silently
  // goes nowhere, which looks like our bug rather than incomplete setup.
  const usable = domains.filter((d) => d.ownershipVerified && d.isActive);

  return (
    <AdminShell
      scope="organisation"
      title="People"
      subtitle={`${people.length} in this organisation`}
      actions={
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setAdding(true)} disabled={usable.length === 0}>
            Add many
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)} disabled={usable.length === 0}>
            Add person
          </Button>
        </div>
      }
    >
      {adding && (
        <AddManyPeople
          departments={flat.map(({ d, depth }) => ({ id: d.id, name: d.name, depth }))}
          domains={usable}
          onClose={() => setAdding(false)}
          onDone={async (msg) => { setAdding(false); setNotice(msg); await load(); }}
        />
      )}
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {usable.length === 0 && !loading && (
        <Alert tone="warn">
          No verified domain yet, so mailboxes cannot be created. Add and verify one
          under <strong>Domains</strong> first — people created on an unverified
          domain would have addresses that receive nothing.
        </Alert>
      )}

      <div className="flex gap-2 mb-4 flex-wrap items-end">
        <div style={{ minWidth: 240 }}>
          <label className="mb-1 block text-[0.75rem] font-medium text-ink-muted" htmlFor="tv-dept-filter">
            Department
          </label>
          <Select id="tv-dept-filter" value={filterDept}
                  onChange={(e) => setFilterDept(e.target.value)}>
            <option value="all">All departments</option>
            {flat.map(({ d, depth }) => (
              <option key={d.id} value={d.id}>
                {' '.repeat(depth * 3)}{depth > 0 ? '└ ' : ''}{d.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="ms-auto" style={{ minWidth: 260 }}>
          <Input  placeholder="Search name or address"
                 value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <Card padded={false}>
        {loading ? (
          <div className="flex justify-center py-12">
            {/* Tokens, not literals: this spinner carried the brand violet as
                a hex, which is the copy that gets missed when it changes. */}
            <span className="inline-block h-[30px] w-[30px] animate-spin rounded-full border-[3px] border-line border-t-brand-600" />
          </div>
        ) : filtered.length === 0 ? (
          <Empty
            title={people.length === 0 ? 'Nobody yet' : 'Nobody matches that filter'}
            hint={people.length === 0
              ? 'Add your colleagues. Each one gets a mailbox and inherits storage from their department.'
              : undefined}
          />
        ) : (
          <Table head={['Person', 'Department', 'Role', 'Storage', 'MFA', 'Status', 'Last sign-in', 'Recovery']}>
            {filtered.map((p) => {
              const dept = flat.find((f) => f.d.id === p.departmentId)?.d;
              return (
                <tr key={p.id} style={{ cursor: 'pointer' }}
                    onClick={() => setEditing(p)}
                    title="Edit this person">
                  <Td>
                    <div className="flex items-center gap-2">
                      <UserPhoto userId={p.id} hasAvatar={p.hasAvatar}
                                 name={p.displayName} email={p.email} size={36} />
                      <div style={{ minWidth: 0 }}>
                        <div className="text-[0.875rem] font-semibold">{p.displayName}</div>
                        <div className="text-[0.75rem] text-ink-muted">{p.email}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {dept ? (
                      <div className="flex items-center gap-2">
                        <span className="rounded-full flex-shrink-0"
                              style={{ width: 8, height: 8, background: dept.colour }} />
                        <span className="text-[0.875rem]">{dept.name}</span>
                      </div>
                    ) : (
                      <span className="text-[0.75rem] text-ink-muted">Unassigned</span>
                    )}
                  </Td>
                  <Td>
                    <span className="text-[0.875rem] capitalize">{p.role.replace(/_/g, ' ')}</span>
                  </Td>
                  <Td>
                    {p.mailboxAddress ? (
                      <>
                        <span className="text-[0.75rem]">
                          {fmt(p.usedBytes)} <span className="text-ink-muted">/ {fmt(p.quotaBytes)}</span>
                        </span>
                        <div style={{ width: 110, marginTop: 4 }}>
                          <Meter used={p.usedBytes} total={p.quotaBytes} />
                        </div>
                      </>
                    ) : (
                      <span className="text-[0.75rem] text-ink-muted">No mailbox</span>
                    )}
                  </Td>
                  <Td>
                    {p.mfaEnabled
                      ? <Badge tone="ok">On</Badge>
                      : <span className="text-[0.75rem] text-ink-muted">Off</span>}
                  </Td>
                  <Td><Badge tone={statusTone(p.status)}>{p.status}</Badge></Td>
                  <Td>
                    <span className="text-[0.8125rem]">
                      {p.lastLoginAt ? formatDateTime(p.lastLoginAt) : 'Never'}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[0.8125rem]">
                      {p.hasVerifiedRecoveryEmail ? 'Verified' : '\u2014'}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <p className="text-[0.75rem] text-ink-muted block mt-4 mb-0">
        You can create people and reset their passwords. You cannot read their mail —
        administrative power over an account never implies access to its contents.
      </p>

      {editing && (
        <EditPerson
          person={editing}
          people={people}
          departments={flat}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => { setEditing(null); setNotice(msg); await load(); }}
          onError={setError}
        />
      )}

      {creating && (
        <AddPerson
          departments={flat}
          domains={usable}
          poolFloor={poolFloor}
          onClose={() => setCreating(false)}
          onCreated={async (msg) => { setCreating(false); setNotice(msg); await load(); }}
          onError={setError}
        />
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
function AddPerson({ departments, domains, poolFloor, onClose, onCreated, onError }: {
  departments: { d: Dept; depth: number }[];
  domains: DomainOpt[];
  poolFloor: number;
  onClose: () => void;
  onCreated: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const { authedFetch, user: me } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [localPart, setLocalPart] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [departmentId, setDepartmentId] = useState('');
  const [role, setRole] = useState('');    // '' = the department's default
  const [override, setOverride] = useState(false);
  const [quotaGb, setQuotaGb] = useState(15);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoWarning, setPhotoWarning] = useState<string | null>(null);

  const dept = departments.find((f) => f.d.id === departmentId)?.d;
  const inherited = dept?.effectiveQuotaBytes ?? poolFloor;
  const domain = domains.find((d) => d.id === domainId);

  async function create() {
    setBusy(true);
    try {
      const res = await authedFetch('/org/users', {
        method: 'POST',
        body: JSON.stringify({
          displayName: displayName.trim(),
          localPart: localPart.trim().toLowerCase(),
          domainId,
          departmentId: departmentId || null,
          role: role || null,
          quotaBytes: override ? quotaGb * GB : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not create this person.');

      // Shown once, never stored recoverably. A retrievable password is a
      // stored plaintext password.
      // Deliberately a second call: it keeps the create request lean, and a
      // photo that fails to attach must not fail the person — they already
      // exist by this point, so this surfaces as a warning, not an error.
      if (photo) {
        try {
          const put = await authedFetch(`/org/users/${body.id}/avatar`, {
            method: 'PUT',
            body: JSON.stringify({ dataUrl: photo }),
          });
          if (!put.ok) {
            // The server still validates type and size, so this can fail even
            // on a file we resized happily. Reported rather than thrown: the
            // person already exists by now, and losing them over a photo would
            // be the worse outcome.
            const pb = await put.json().catch(() => ({}));
            setPhotoWarning(pb.error ?? 'The photo could not be saved.');
          }
        } catch {
          setPhotoWarning('The photo could not be saved.');
        }
      }

      setCreated({ email: body.email, password: body.temporaryPassword });
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not create this person.');
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal
        title={`${created.email} is ready`}
        onClose={() => onCreated(`${created.email} created.`)}
        footer={
          <Button variant="primary" onClick={() => onCreated(`${created.email} created.`)}>
            Done
          </Button>
        }
      >
        {photoWarning && (
          <p className="text-[0.875rem] text-warn mb-4">
            {photoWarning} You can add it from their profile.
          </p>
        )}
        <Alert tone="warn">
          This password is shown once and cannot be retrieved later. Copy it now —
          if it is lost, reset it rather than asking us for it.
        </Alert>
        <div className="flex gap-2 items-center">
          <div className="flex-auto font-mono rounded bg-canvas"
               style={{ padding: 12, fontSize: 15 }}>
            {created.password}
          </div>
          <IconButton
            label="Copy password"
            onClick={() => void navigator.clipboard.writeText(created.password)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 012-2h10" />
            </svg>
          </IconButton>
        </div>
        <p className="text-[0.75rem] text-ink-muted mt-4 mb-0">
          They will be asked to change it when they first sign in.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Add a person"
      subtitle="They get a sign-in and a mailbox, and inherit their department's settings."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={create}
                  disabled={busy || displayName.trim().length < 2 || localPart.length < 1 || !domain}>
            {busy ? 'Creating…' : 'Create person'}
          </Button>
        </>
      }
    >
      <div className="mb-4">
        <PhotoPicker preview={photo} name={displayName} onPick={setPhoto}
                     onRemove={() => setPhoto(null)} disabled={busy} />
      </div>

      <Field label="Full name" required>
        <Input  value={displayName}
               onChange={(e) => setDisplayName(e.target.value)} />
      </Field>

      <div className="flex gap-2 items-start">
        <div className="flex-auto">
          <Field label="Email address" required>
            {/* The @ is part of the control rather than text floating beside
                it, so the address reads as one thing. */}
            <InputSuffix
              suffix="@"
              value={localPart}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setLocalPart(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ''))}
            />
          </Field>
        </div>
        <div style={{ minWidth: 200 }}>
          <Field label="Domain">
            <Select  value={domainId}
                    onChange={(e) => setDomainId(e.target.value)}>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.fqdn}</option>)}
            </Select>
          </Field>
        </div>
      </div>

      <Field label="Department"
             hint="Sets their role, storage and whether they can email outsiders">
        <Select  value={departmentId}
                onChange={(e) => { setDepartmentId(e.target.value); setOverride(false); }}>
          <option value="">No department — organisation defaults</option>
          {departments.map(({ d, depth }) => (
            <option key={d.id} value={d.id}>
              {' '.repeat(depth * 3)}{depth > 0 ? '└ ' : ''}{d.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Role"
             hint="What they can administer. Leave on the default unless this person runs things.">
        <Select  value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">
            {dept ? `Department default (${dept.defaultRole.replace(/_/g, ' ')})` : 'Default (employee)'}
          </option>
          {roleOptions(me?.role === 'org_owner' || me?.role === 'super_admin').map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </Select>
      </Field>

      {/* Storage. The inherited value is shown BEFORE the override, so the
          common case needs no decision at all — and the number is visible
          rather than something the admin has to go and look up. */}
      {/* The tint was a hard-coded rgba of the OLD green brand — the kind of
          literal that survives a palette change and quietly contradicts it. */}
      <div className="rounded border border-line bg-canvas p-4 mb-2">
        <div className="text-[0.875rem] font-semibold mb-2">Storage</div>

        <Switch
          id="tv-inherit-quota"
          checked={!override}
          onChange={(e) => setOverride(!e.target.checked)}
          className="mb-0"
          label={
            <>
              Use <strong>{fmt(inherited)}</strong>
              {dept ? ` from ${dept.name}` : ' from the organisation default'}
            </>
          }
        />

        {/* Plain conditional rendering replaces MUI's Collapse. The animation
            carried no meaning, and one fewer dependency is worth more. */}
        {override && (
          <div style={{ width: 240, marginTop: 12 }}>
            <Field label="Storage for this person" hint="Applies to this person only">
              <InputSuffix
                suffix="GB"
                type="number"
                min={1}
                max={5000}
                value={quotaGb}
                onChange={(e) => setQuotaGb(Math.max(1, Number(e.target.value)))}
              />
            </Field>
          </div>
        )}
      </div>

      {dept && !dept.canSendExternal && (
        <Alert tone="info" className="mt-4 mb-0">
          {dept.name} is internal-only, so this person will be able to email colleagues
          but not the outside world.
        </Alert>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function EditPerson({ person, people, departments, onClose, onSaved, onError }: {
  person: Person;
  people: Person[];
  departments: { d: Dept; depth: number }[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const { authedFetch, user: me } = useAuth();

  const [displayName, setDisplayName] = useState(person.displayName);
  const [departmentId, setDepartmentId] = useState(person.departmentId ?? '');
  const [role, setRole] = useState(person.role);
  const [quotaGb, setQuotaGb] = useState(Math.max(1, Math.round(person.quotaBytes / GB)));
  const [busy, setBusy] = useState(false);
  const [tempPassword, setTempPassword] = useState<{ password: string; mailbox: boolean } | null>(null);
  // undefined = untouched, null = remove, string = a newly picked photo.
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  const [storedPhoto, setStoredPhoto] = useState<string | null>(null);

  useEffect(() => {
    if (!person.hasAvatar) return;
    let alive = true;
    avatarObjectUrl(authedFetch, person.id).then((u) => { if (alive) setStoredPhoto(u); });
    return () => { alive = false; };
  }, [authedFetch, person.id, person.hasAvatar]);
  const [armDelete, setArmDelete] = useState(false);

  // ---- Offboarding -----------------------------------------------------
  //  Delete answers "remove this account". Offboarding answers "this person
  //  is LEAVING" — the same teardown, plus the question deletion silently
  //  skips: what happens to mail still sent to their address?
  const [offboarding, setOffboarding] = useState(false);
  const [forwardTo, setForwardTo] = useState('');
  const successors = useMemo(
    () => people
      .filter((p) => p.id !== person.id && p.status === 'active' && p.mailboxAddress)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [people, person.id],
  );

  async function offboard() {
    setBusy(true);
    try {
      const res = await authedFetch(`/org/users/${person.id}/offboard`, {
        method: 'POST',
        body: JSON.stringify({ forwardToUserId: forwardTo || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'That did not work.');
      const successor = successors.find((p) => p.id === forwardTo);
      onSaved(successor
        ? `${person.displayName} offboarded. Mail to ${person.mailboxAddress} now reaches ${successor.displayName}.`
        : `${person.displayName} offboarded. Sign-in and access are closed; their stored mail is retained.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'That did not work.');
      setBusy(false);
    }
  }

  const editingSelf = me?.id === person.id;
  const canMakeOwner = me?.role === 'org_owner' || me?.role === 'super_admin';
  // The server refuses an admin acting on an owner; don't offer the buttons.
  const targetLocked = person.role === 'org_owner' && !canMakeOwner;

  /** Suspend / reactivate / delete / reset — small POSTs sharing one shape. */
  async function act(path: string, method: string, done: (body: Record<string, unknown>) => void) {
    setBusy(true);
    try {
      const res = await authedFetch(`/org/users/${person.id}${path}`, { method });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'That did not work.');
      done(body);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'That did not work.');
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await authedFetch(`/org/users/${person.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          // Only what changed. The API treats null as "leave alone", so a
          // field this form never touched can never be blanked by it.
          displayName: displayName.trim() !== person.displayName ? displayName.trim() : null,
          departmentId: departmentId !== (person.departmentId ?? '')
            // '' means "no department" — the API's Guid.Empty sentinel.
            ? (departmentId === '' ? '00000000-0000-0000-0000-000000000000' : departmentId)
            : null,
          role: role !== person.role ? role : null,
          // No mailbox check: a person with no email still has an allowance,
          // because they will have files.
          quotaBytes: quotaGb * GB !== person.quotaBytes ? quotaGb * GB : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save the changes.');

      if (photo !== undefined) {
        if (photo === null) {
          await authedFetch(`/org/users/${person.id}/avatar`, { method: 'DELETE' });
        } else {
          const put = await authedFetch(`/org/users/${person.id}/avatar`, {
            method: 'PUT',
            body: JSON.stringify({ dataUrl: photo }),
          });
          if (!put.ok) {
            const pb = await put.json().catch(() => ({}));
            throw new Error(pb.error ?? 'The photo could not be saved.');
          }
        }
        // Release the cached object URL so the list re-reads the new photo.
        bustAvatar(person.id);
      }

      onSaved(`${displayName.trim()} updated.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save the changes.');
      setBusy(false);
    }
  }

  // The one-time password view. Same contract as at creation: shown once,
  // never retrievable, and closing the dialog is an explicit "I have copied
  // it" step rather than something a stray click can do.
  if (tempPassword) {
    const closed = tempPassword.mailbox
      ? `Mailbox password reset for ${person.email}.`
      : `Password reset for ${person.email}.`;
    return (
      <Modal
        title={tempPassword.mailbox
          ? `New mailbox password for ${person.displayName}`
          : `New password for ${person.displayName}`}
        onClose={() => onSaved(closed)}
        footer={
          <Button variant="primary" onClick={() => onSaved(closed)}>
            Done
          </Button>
        }
      >
        <Alert tone="warn">
          {tempPassword.mailbox
            ? 'Shown once — copy it now and pass it to them directly. This is '
              + 'the password their mail apps (Outlook, phones) sign in with. '
              + 'How they sign in to TatvaOS is unchanged, and existing mail '
              + 'clients will stop working until reconfigured with this one.'
            : 'Shown once — copy it now and pass it to them directly. They '
              + 'must change it at first sign-in, and every session they had '
              + 'is already signed out.'}
        </Alert>
        <div className="flex gap-2 items-center">
          <div className="flex-auto font-mono rounded bg-canvas"
               style={{ padding: 12, fontSize: 15 }}>
            {tempPassword.password}
          </div>
          <IconButton
            label="Copy password"
            onClick={() => void navigator.clipboard.writeText(tempPassword.password)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 012-2h10" />
            </svg>
          </IconButton>
        </div>
      </Modal>
    );
  }

  // One dialog, four sections, in the order questions actually arrive:
  // who they are, what they can do, what they are using, and — separated
  // below a visible line — the actions that end things.
  const sectionTitle = (t: string) => (
    <div className="text-[0.8125rem] font-semibold uppercase text-ink-muted mb-2" style={{ letterSpacing: '0.04em' }}>{t}</div>
  );

  return (
    <Modal
      title={`Edit ${person.displayName}`}
      subtitle={person.email}
      onClose={onClose}
      busy={busy}
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}
                  disabled={busy || targetLocked || displayName.trim().length < 2}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      {/* Two columns on a desktop, stacked on a phone. The dialog is wide
          so everything is visible at once — a section hidden behind a
          scrollbar may as well not exist, and this dialog will keep
          growing as products are added. */}
      <div className="grid gap-6 md:grid-cols-2">
      <div>
      {/* ---- Profile -------------------------------------------------- */}
      {sectionTitle('Profile')}
      <div className="mb-4">
        <PhotoPicker
          preview={photo !== undefined ? photo : storedPhoto}
          name={person.displayName}
          email={person.email}
          onPick={setPhoto}
          onRemove={() => setPhoto(null)}
          disabled={busy}
        />
      </div>

      <Field label="Full name" required>
        <Input  value={displayName}
               onChange={(e) => setDisplayName(e.target.value)} />
      </Field>

      <Field label="Department">
        <Select  value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">No department — organisation defaults</option>
          {departments.map(({ d, depth }) => (
            <option key={d.id} value={d.id}>
              {' '.repeat(depth * 3)}{depth > 0 ? '└ ' : ''}{d.name}
            </option>
          ))}
        </Select>
      </Field>

      </div>
      <div>
      {/* ---- Access --------------------------------------------------- */}
      {sectionTitle('Access')}
      {/* The facts an admin opens this dialog to check, previously not
          shown anywhere: can they sign in, is a second factor protecting
          the account, and when were they last here. */}
      <div className="flex flex-wrap gap-6 mb-4">
        <div>
          <div className="text-[0.75rem] text-ink-muted">Status</div>
          <Badge tone={statusTone(person.status)}>{person.status}</Badge>
        </div>
        <div>
          <div className="text-[0.75rem] text-ink-muted">Two-step verification</div>
          {person.mfaEnabled
            ? <Badge tone="ok">On</Badge>
            : <span className="text-[0.8125rem]">Off — their choice to enable</span>}
        </div>
        <div>
          <div className="text-[0.75rem] text-ink-muted">Last sign-in</div>
          <span className="text-[0.8125rem]">
            {person.lastLoginAt
              ? formatDateTime(person.lastLoginAt)
              : 'Never'}
          </span>
        </div>
      </div>

      <Field
        label="Role"
        hint={editingSelf
          ? 'You cannot change your own role — ask another owner.'
          : targetLocked
            ? 'Only an organisation owner can manage an owner.'
            : 'What they can administer. Mail access is unaffected.'}
      >
        <Select  value={role}
                disabled={editingSelf || targetLocked}
                onChange={(e) => setRole(e.target.value)}>
          {roleOptions(canMakeOwner, person.role).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </Select>
      </Field>

      {!editingSelf && !targetLocked && person.status !== 'deleted' && (
        <Button variant="ghost" disabled={busy}
                onClick={() => void act('/reset-password', 'POST',
                  (body) => { setTempPassword({ password: String(body.temporaryPassword), mailbox: false }); setBusy(false); })}>
          Reset password
        </Button>
      )}

      <hr className="my-6" />

      {/* ---- Mail & storage ------------------------------------------- */}
      {sectionTitle('Mail & storage')}
      <div className="mb-2">
        <div className="text-[0.75rem] text-ink-muted">Mailbox</div>
        {person.mailboxAddress
          ? <span className="text-[0.8125rem] font-mono">{person.mailboxAddress}</span>
          : <span className="text-[0.8125rem] text-ink-muted">None — this person has no email</span>}
      </div>

      {/* The other reset. "Reset password" above changes how they SIGN IN;
          this one changes what their mail apps authenticate with. They are
          separate credentials on purpose — and until this button existed,
          the only reset an admin could reach was the wrong one for mail. */}
      {person.mailboxAddress && !targetLocked && person.status !== 'deleted' && (
        <Button variant="ghost" disabled={busy}
                onClick={() => void act('/reset-mailbox-password', 'POST',
                  (body) => { setTempPassword({ password: String(body.temporaryPassword), mailbox: true }); setBusy(false); })}>
          Reset mailbox password
        </Button>
      )}

      {/* ONE allowance, spent across every product. It used to be the
          mailbox's quota, which is why "you have 30 GB" was only ever true of
          email — their files were counted somewhere else entirely. */}
      <div className="mb-2" style={{ maxWidth: 320 }}>
        <Meter used={person.usedBytes} total={person.quotaBytes} />
        <div className="text-[0.75rem] text-ink-muted mt-1">
          Using {fmt(person.usedBytes)} of {fmt(person.quotaBytes)} across all products
        </div>
      </div>

      <Field
        label="Storage allowance"
        hint="Their total for mail, files and everything else. It will not shrink
              below what they already use. Shared mailboxes and organisation
              files are not counted against a person."
      >
        <InputSuffix
          suffix="GB"
          type="number"
          min={1}
          max={5000}
          value={quotaGb}
          style={{ maxWidth: 200 }}
          onChange={(e) => setQuotaGb(Math.max(1, Number(e.target.value)))}
        />
      </Field>
      </div>
      </div>

      {/* ---- Leaving and removal -------------------------------------- */}
      {/* Not offered against yourself — suspending or deleting the account
          you are signed in with is a support ticket in the making, and the
          server refuses it anyway. */}
      {!editingSelf && !targetLocked && (
        <>
          <hr className="my-6" />
          {sectionTitle('Leaving and removal')}
          {person.status === 'suspended' && (
            <p className="text-[0.75rem] text-ink-muted mb-4">
              Suspended — cannot sign in, mailbox rejecting mail, data retained.
            </p>
          )}
          {person.status === 'deleted' && (
            <p className="text-[0.75rem] text-ink-muted mb-4">
              This account is closed. Create the person again if they return.
            </p>
          )}

          {person.status !== 'deleted' && (
          <div className="flex gap-2 flex-wrap">
            {person.status === 'suspended' ? (
              <Button variant="ghost" disabled={busy}
                      onClick={() => void act('/reactivate', 'POST',
                        () => onSaved(`${person.displayName} is active again.`))}>
                Reactivate
              </Button>
            ) : (
              <Button variant="ghost" disabled={busy}
                      onClick={() => void act('/suspend', 'POST',
                        () => onSaved(`${person.displayName} deactivated. Their mail is retained.`))}>
                Deactivate
              </Button>
            )}

            {!offboarding && (
              <Button variant="ghost" disabled={busy} onClick={() => setOffboarding(true)}>
                Offboard&hellip;
              </Button>
            )}

            {/* Two clicks, both on the same button, second one labelled in
                plain words. A nested confirm dialog gets clicked through;
                a button that changes its mind out loud does not. */}
            <Button variant="ghost" disabled={busy}
                    onClick={() => {
                      if (!armDelete) { setArmDelete(true); return; }
                      void act('', 'DELETE',
                        () => onSaved(`${person.email} deleted. Sign-in and mail are closed; stored mail is retained.`));
                    }}>
              <span className="text-danger" style={{ fontWeight: armDelete ? 700 : 500 }}>
                {armDelete ? 'Click again — this deletes their account' : 'Delete person'}
              </span>
            </Button>
          </div>
          )}

          {/* ----------------------------------------------------------
              Offboarding panel. One decision — where does their mail go —
              then one action that closes sign-in, revokes access, and
              deactivates the mailbox together. Forwarding is real routing:
              mail from ANYONE to their address, colleagues or customers,
              is delivered to the successor from the moment this runs. */}
          {offboarding && person.status !== 'deleted' && (
            <div className="border rounded p-4 mt-4">
              <div className="text-[0.875rem] font-semibold mb-1">Offboard {person.displayName}</div>
              <p className="text-[0.75rem] text-ink-muted mb-2">
                Closes sign-in and all access, and deactivates their mailbox.
                Their stored mail is retained. Choose what happens to mail
                still sent to {person.mailboxAddress ?? 'their address'}:
              </p>
              <Select className="mb-2" value={forwardTo}
                      disabled={busy}
                      onChange={(e) => setForwardTo(e.target.value)}>
                <option value="">No forwarding — new mail to their address bounces</option>
                {successors.map((p) => (
                  <option key={p.id} value={p.id}>
                    Forward to {p.displayName} ({p.mailboxAddress})
                  </option>
                ))}
              </Select>
              <div className="flex gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void offboard()}>
                  {busy ? 'Working…' : `Offboard ${person.displayName}`}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setOffboarding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
