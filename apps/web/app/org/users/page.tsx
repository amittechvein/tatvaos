'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
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
import { useAuth } from '@/lib/auth';

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
}

interface DomainOpt { id: string; fqdn: string; isActive: boolean; ownershipVerified: boolean }

/** Depth-first flatten, so a <select> can show the hierarchy with indentation. */
function flatten(nodes: Dept[], depth = 0): { d: Dept; depth: number }[] {
  return nodes.flatMap((d) => [{ d, depth }, ...flatten(d.children, depth + 1)]);
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
      {error && <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 3 }} onClose={() => setNotice(null)}>{notice}</Alert>}

      {usable.length === 0 && !loading && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          No verified domain yet, so mailboxes cannot be created. Add and verify one
          under <strong>Domains</strong> first — people created on an unverified
          domain would have addresses that receive nothing.
        </Alert>
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
          <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
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
                <tr key={p.id}>
                  <Td>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{p.displayName}</Typography>
                    <Typography variant="caption" color="text.secondary">{p.email}</Typography>
                  </Td>
                  <Td>
                    {dept ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: dept.colour }} />
                        <Typography variant="body2">{dept.name}</Typography>
                      </Box>
                    ) : (
                      <Typography variant="caption" color="text.disabled">Unassigned</Typography>
                    )}
                  </Td>
                  <Td>
                    <Typography variant="body2" sx={{ textTransform: 'capitalize' }}>
                      {p.role.replace(/_/g, ' ')}
                    </Typography>
                  </Td>
                  <Td>
                    {p.mailboxAddress ? (
                      <>
                        <Typography variant="caption">
                          {fmt(p.usedBytes)} <Box component="span" sx={{ color: 'text.disabled' }}>
                            / {fmt(p.quotaBytes)}
                          </Box>
                        </Typography>
                        <Box sx={{ width: 110, mt: 0.5 }}>
                          <Meter used={p.usedBytes} total={p.quotaBytes} />
                        </Box>
                      </>
                    ) : (
                      <Typography variant="caption" color="text.disabled">No mailbox</Typography>
                    )}
                  </Td>
                  <Td>
                    {p.mfaEnabled
                      ? <Chip label="On" size="small" color="success" />
                      : <Typography variant="caption" color="text.disabled">Off</Typography>}
                  </Td>
                  <Td><Badge tone={statusTone(p.status)}>{p.status}</Badge></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        You can create people and reset their passwords. You cannot read their mail —
        administrative power over an account never implies access to its contents.
      </Typography>

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
  const { authedFetch } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [localPart, setLocalPart] = useState('');
  const [domainId, setDomainId] = useState(domains[0]?.id ?? '');
  const [departmentId, setDepartmentId] = useState('');
  const [override, setOverride] = useState(false);
  const [quotaGb, setQuotaGb] = useState(15);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

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
          quotaBytes: override ? quotaGb * GB : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not create this person.');

      // Shown once, never stored recoverably. A retrievable password is a
      // stored plaintext password.
      setCreated({ email: body.email, password: body.temporaryPassword });
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not create this person.');
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Dialog open onClose={() => onCreated(`${created.email} created.`)} maxWidth="sm" fullWidth>
        <DialogTitle>{created.email} is ready</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2.5 }}>
            This password is shown once and cannot be retrieved later. Copy it now —
            if it is lost, reset it rather than asking us for it.
          </Alert>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Box sx={{ flex: 1, p: 1.5, borderRadius: 1.5, fontFamily: 'monospace',
                       fontSize: 15, bgcolor: 'background.default' }}>
              {created.password}
            </Box>
            <Tooltip title="Copy">
              <IconButton onClick={() => void navigator.clipboard.writeText(created.password)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.8" strokeLinecap="round">
                  <rect x="9" y="9" width="12" height="12" rx="2" />
                  <path d="M5 15V5a2 2 0 012-2h10" />
                </svg>
              </IconButton>
            </Tooltip>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            They will be asked to change it when they first sign in.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button variant="primary" onClick={() => onCreated(`${created.email} created.`)}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
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
        <TextField autoFocus fullWidth label="Full name" required value={displayName}
                   onChange={(e) => setDisplayName(e.target.value)} sx={{ mt: 1, mb: 2.5 }} />

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
