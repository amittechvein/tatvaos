'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import Divider from '@mui/material/Divider';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Meter, Table, Td, statusTone } from '@/components/ui/Kit';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { UserPhoto } from '@/components/ui/UserPhoto';
import { PhotoPicker } from '@/components/ui/PhotoPicker';
import { avatarObjectUrl, bustAvatar } from '@/lib/avatars';

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
        <Button variant="primary" onClick={() => setCreating(true)} disabled={usable.length === 0}>
          Add person
        </Button>
      }
    >
      {error && (
        <div className="alert alert-danger d-flex align-items-start mb-3">
          <div className="flex-fill">{error}</div>
          <button type="button" className="btn-close" aria-label="Dismiss"
                  onClick={() => setError(null)} />
        </div>
      )}
      {notice && (
        <div className="alert alert-success d-flex align-items-start mb-3">
          <div className="flex-fill">{notice}</div>
          <button type="button" className="btn-close" aria-label="Dismiss"
                  onClick={() => setNotice(null)} />
        </div>
      )}

      {usable.length === 0 && !loading && (
        <div className="alert alert-warning mb-3">
          No verified domain yet, so mailboxes cannot be created. Add and verify one
          under <strong>Domains</strong> first — people created on an unverified
          domain would have addresses that receive nothing.
        </div>
      )}

      <Box sx={{ display: 'flex', gap: 1.5, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField select size="small" label="Department" value={filterDept}
                   onChange={(e) => setFilterDept(e.target.value)} sx={{ minWidth: 240 }}>
          <MenuItem value="all">All departments</MenuItem>
          {flat.map(({ d, depth }) => (
            <MenuItem key={d.id} value={d.id}>
              {' '.repeat(depth * 3)}{depth > 0 ? '└ ' : ''}{d.name}
            </MenuItem>
          ))}
        </TextField>

        <TextField size="small" placeholder="Search name or address" value={query}
                   onChange={(e) => setQuery(e.target.value)} sx={{ ml: 'auto', minWidth: 260 }} />
      </Box>

      <Card padded={false}>
        {loading ? (
          <div className="d-flex justify-content-center py-5">
            <span className="d-inline-block animate-spin rounded-circle"
                  style={{ width: 30, height: 30, border: '3px solid rgba(0,0,0,.12)',
                           borderTopColor: '#03b562' }} />
          </div>
        ) : filtered.length === 0 ? (
          <Empty
            title={people.length === 0 ? 'Nobody yet' : 'Nobody matches that filter'}
            hint={people.length === 0
              ? 'Add your colleagues. Each one gets a mailbox and inherits storage from their department.'
              : undefined}
          />
        ) : (
          <Table head={['Person', 'Department', 'Role', 'Storage', 'MFA', 'Status']}>
            {filtered.map((p) => {
              const dept = flat.find((f) => f.d.id === p.departmentId)?.d;
              return (
                <tr key={p.id} style={{ cursor: 'pointer' }}
                    onClick={() => setEditing(p)}
                    title="Edit this person">
                  <Td>
                    <div className="d-flex align-items-center gap-2">
                      <UserPhoto userId={p.id} hasAvatar={p.hasAvatar}
                                 name={p.displayName} email={p.email} size={36} />
                      <div style={{ minWidth: 0 }}>
                        <div className="fs-14 fw-semibold">{p.displayName}</div>
                        <div className="fs-12 text-muted">{p.email}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {dept ? (
                      <div className="d-flex align-items-center gap-2">
                        <span className="rounded-circle flex-shrink-0"
                              style={{ width: 8, height: 8, background: dept.colour }} />
                        <span className="fs-14">{dept.name}</span>
                      </div>
                    ) : (
                      <span className="fs-12 text-muted">Unassigned</span>
                    )}
                  </Td>
                  <Td>
                    <span className="fs-14 text-capitalize">{p.role.replace(/_/g, ' ')}</span>
                  </Td>
                  <Td>
                    {p.mailboxAddress ? (
                      <>
                        <span className="fs-12">
                          {fmt(p.usedBytes)} <span className="text-muted">/ {fmt(p.quotaBytes)}</span>
                        </span>
                        <div style={{ width: 110, marginTop: 4 }}>
                          <Meter used={p.usedBytes} total={p.quotaBytes} />
                        </div>
                      </>
                    ) : (
                      <span className="fs-12 text-muted">No mailbox</span>
                    )}
                  </Td>
                  <Td>
                    {p.mfaEnabled
                      ? <Badge tone="ok">On</Badge>
                      : <span className="fs-12 text-muted">Off</span>}
                  </Td>
                  <Td><Badge tone={statusTone(p.status)}>{p.status}</Badge></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <p className="fs-12 text-muted d-block mt-3 mb-0">
        You can create people and reset their passwords. You cannot read their mail —
        administrative power over an account never implies access to its contents.
      </p>

      {editing && (
        <EditPerson
          person={editing}
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
          <p className="fs-14 text-warning mb-3">
            {photoWarning} You can add it from their profile.
          </p>
        )}
        <div className="alert alert-warning mb-3">
          This password is shown once and cannot be retrieved later. Copy it now —
          if it is lost, reset it rather than asking us for it.
        </div>
        <div className="d-flex gap-2 align-items-center">
          <div className="flex-fill font-monospace bg-light rounded"
               style={{ padding: 12, fontSize: 15 }}>
            {created.password}
          </div>
          {/* title= replaces MUI's Tooltip: no library needed for one hint,
              and the native tooltip is keyboard-reachable for free. */}
          <button
            type="button"
            className="btn btn-light btn-icon"
            title="Copy"
            aria-label="Copy password"
            onClick={() => void navigator.clipboard.writeText(created.password)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 012-2h10" />
            </svg>
          </button>
        </div>
        <p className="fs-12 text-muted mt-3 mb-0">
          They will be asked to change it when they first sign in.
        </p>
      </Modal>
    );
  }

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        Add a person
        <Typography variant="body2" color="text.secondary">
          They get a sign-in and a mailbox, and inherit their department&apos;s settings.
        </Typography>
      </DialogTitle>

      <DialogContent>
        <Box sx={{ mt: 1, mb: 2.5 }}>
          <PhotoPicker preview={photo} name={displayName} onPick={setPhoto}
                       onRemove={() => setPhoto(null)} disabled={busy} />
        </Box>

        <TextField fullWidth label="Full name" required value={displayName}
                   onChange={(e) => setDisplayName(e.target.value)} sx={{ mb: 2.5 }} />

        <Box sx={{ display: 'flex', gap: 1.5, mb: 2.5, alignItems: 'flex-start' }}>
          <TextField label="Email address" required value={localPart}
                     onChange={(e) => setLocalPart(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ''))}
                     sx={{ flex: 1 }}
                     slotProps={{
                       input: { endAdornment: <InputAdornment position="end">@</InputAdornment> },
                       htmlInput: { autoCapitalize: 'none', spellCheck: false },
                     }} />
          <TextField select label="Domain" value={domainId} sx={{ minWidth: 200 }}
                     onChange={(e) => setDomainId(e.target.value)}>
            {domains.map((d) => (
              <MenuItem key={d.id} value={d.id}>{d.fqdn}</MenuItem>
            ))}
          </TextField>
        </Box>

        <TextField select fullWidth label="Department" value={departmentId} sx={{ mb: 2.5 }}
                   onChange={(e) => { setDepartmentId(e.target.value); setOverride(false); }}
                   helperText="Sets their role, storage and whether they can email outsiders">
          <MenuItem value="">
            <em>No department — organisation defaults</em>
          </MenuItem>
          {departments.map(({ d, depth }) => (
            <MenuItem key={d.id} value={d.id}>
              {' '.repeat(depth * 3)}{depth > 0 ? '└ ' : ''}{d.name}
            </MenuItem>
          ))}
        </TextField>

        <TextField select fullWidth label="Role" value={role} sx={{ mb: 2.5 }}
                   onChange={(e) => setRole(e.target.value)}
                   helperText="What they can administer. Leave on the default unless this person runs things.">
          <MenuItem value="">
            <em>{dept ? `Department default (${dept.defaultRole.replace(/_/g, ' ')})` : 'Default (employee)'}</em>
          </MenuItem>
          {roleOptions(me?.role === 'org_owner' || me?.role === 'super_admin').map(([v, label]) => (
            <MenuItem key={v} value={v}>{label}</MenuItem>
          ))}
        </TextField>

        {/* Storage. The inherited value is shown BEFORE the override, so the
            common case needs no decision at all — and the number is visible
            rather than something the admin has to go and look up. */}
        <Box sx={{ p: 2, borderRadius: 2, mb: 1,
                   bgcolor: (t) => alpha(t.palette.primary.main, 0.05) }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>Storage</Typography>

          <FormControlLabel
            control={<Switch checked={!override} onChange={(e) => setOverride(!e.target.checked)} />}
            label={
              <Typography variant="body2">
                Use <strong>{fmt(inherited)}</strong>
                {dept ? ` from ${dept.name}` : ' from the organisation default'}
              </Typography>
            }
          />

          <Collapse in={override}>
            <TextField type="number" label="Storage for this person" value={quotaGb}
                       onChange={(e) => setQuotaGb(Math.max(1, Number(e.target.value)))}
                       sx={{ mt: 1.5, width: 240 }}
                       slotProps={{
                         input: { endAdornment: <InputAdornment position="end">GB</InputAdornment> },
                         htmlInput: { min: 1, max: 5000 },
                       }}
                       helperText="Applies to this person only" />
          </Collapse>
        </Box>

        {dept && !dept.canSendExternal && (
          <Alert severity="info" sx={{ mt: 2 }}>
            {dept.name} is internal-only, so this person will be able to email colleagues
            but not the outside world.
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={create}
                disabled={busy || displayName.trim().length < 2 || localPart.length < 1 || !domain}>
          {busy ? 'Creating…' : 'Create person'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
function EditPerson({ person, departments, onClose, onSaved, onError }: {
  person: Person;
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
  const [tempPassword, setTempPassword] = useState<string | null>(null);
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
          quotaBytes: person.mailboxAddress && quotaGb * GB !== person.quotaBytes
            ? quotaGb * GB : null,
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
    return (
      <Dialog open maxWidth="sm" fullWidth>
        <DialogTitle>New password for {person.displayName}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2.5 }}>
            Shown once — copy it now and pass it to them directly. They must
            change it at first sign-in, and every session they had is already
            signed out.
          </Alert>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Box sx={{ flex: 1, p: 1.5, borderRadius: 1.5, fontFamily: 'monospace',
                       fontSize: 15, bgcolor: 'background.default' }}>
              {tempPassword}
            </Box>
            <Tooltip title="Copy">
              <IconButton onClick={() => void navigator.clipboard.writeText(tempPassword)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.8" strokeLinecap="round">
                  <rect x="9" y="9" width="12" height="12" rx="2" />
                  <path d="M5 15V5a2 2 0 012-2h10" />
                </svg>
              </IconButton>
            </Tooltip>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button variant="primary" onClick={() => onSaved(`Password reset for ${person.email}.`)}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        Edit {person.displayName}
        <Typography variant="body2" color="text.secondary">{person.email}</Typography>
      </DialogTitle>

      <DialogContent>
        <Box sx={{ mt: 1, mb: 2.5 }}>
          <PhotoPicker
            preview={photo !== undefined ? photo : storedPhoto}
            name={person.displayName}
            email={person.email}
            onPick={setPhoto}
            onRemove={() => setPhoto(null)}
            disabled={busy}
          />
        </Box>

        <TextField fullWidth label="Full name" required value={displayName}
                   onChange={(e) => setDisplayName(e.target.value)} sx={{ mb: 2.5 }} />

        <TextField select fullWidth label="Department" value={departmentId} sx={{ mb: 2.5 }}
                   onChange={(e) => setDepartmentId(e.target.value)}>
          <MenuItem value="">
            <em>No department — organisation defaults</em>
          </MenuItem>
          {departments.map(({ d, depth }) => (
            <MenuItem key={d.id} value={d.id}>
              {'\u00A0'.repeat(depth * 3)}{depth > 0 ? '└ ' : ''}{d.name}
            </MenuItem>
          ))}
        </TextField>

        <TextField select fullWidth label="Role" value={role} sx={{ mb: 2.5 }}
                   onChange={(e) => setRole(e.target.value)}
                   disabled={editingSelf || targetLocked}
                   helperText={editingSelf
                     ? 'You cannot change your own role — ask another owner.'
                     : targetLocked
                       ? 'Only an organisation owner can manage an owner.'
                       : 'What they can administer. Mail access is unaffected.'}>
          {roleOptions(canMakeOwner, person.role).map(([v, label]) => (
            <MenuItem key={v} value={v}>{label}</MenuItem>
          ))}
        </TextField>

        {person.mailboxAddress ? (
          <TextField type="number" fullWidth label="Mailbox storage" value={quotaGb}
                     onChange={(e) => setQuotaGb(Math.max(1, Number(e.target.value)))}
                     slotProps={{
                       input: { endAdornment: <InputAdornment position="end">GB</InputAdornment> },
                       htmlInput: { min: 1, max: 5000 },
                     }}
                     helperText={`Currently using ${fmt(person.usedBytes)} — the quota will not shrink below that.`} />
        ) : (
          <Alert severity="info">No mailbox — storage does not apply to this person.</Alert>
        )}

        {/* ------------------------------------------------------------
            Account actions. Not offered against yourself — suspending or
            deleting the account you are signed in with is a support ticket
            in the making, and the server refuses it anyway. */}
        {!editingSelf && !targetLocked && (
          <>
            <Divider sx={{ my: 3 }} />
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>Account</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Status: <strong>{person.status}</strong>
              {person.status === 'suspended' &&
                ' — cannot sign in, mailbox rejecting mail, data retained'}
              {person.status === 'deleted' &&
                ' — this account is closed. Create the person again if they return.'}
            </Typography>

            {person.status !== 'deleted' && (
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
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

              <Button variant="ghost" disabled={busy}
                      onClick={() => void act('/reset-password', 'POST',
                        (body) => { setTempPassword(String(body.temporaryPassword)); setBusy(false); })}>
                Reset password
              </Button>

              {/* Two clicks, both on the same button, second one labelled in
                  plain words. A nested confirm dialog gets clicked through;
                  a button that changes its mind out loud does not. */}
              <Button variant="ghost" disabled={busy}
                      onClick={() => {
                        if (!armDelete) { setArmDelete(true); return; }
                        void act('', 'DELETE',
                          () => onSaved(`${person.email} deleted. Sign-in and mail are closed; stored mail is retained.`));
                      }}>
                <Box component="span" sx={{ color: 'error.main', fontWeight: armDelete ? 700 : 500 }}>
                  {armDelete ? 'Click again — this deletes their account' : 'Delete person'}
                </Box>
              </Button>
            </Box>
            )}
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save}
                disabled={busy || targetLocked || displayName.trim().length < 2}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
