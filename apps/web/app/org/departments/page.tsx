'use client';

import { useCallback, useEffect, useState } from 'react';
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
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

import { AdminShell } from '@/components/admin/AdminShell';
import { Button, Card, Empty, Stat } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Departments — what Google calls Organisational Units
// ============================================================================
//
//  The screen has one job beyond CRUD: make inheritance visible. An admin who
//  cannot see that Backend's 30 GB came from Engineering will set it again on
//  every team, and the tree stops being worth having the moment they do.
// ============================================================================

const GB = 1024 ** 3;

interface Node {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  defaultRole: string;
  defaultProducts: string[];
  canSendExternal: boolean;
  colour: string;
  ownQuotaBytes: number | null;
  effectiveQuotaBytes: number | null;
  quotaInherited: boolean;
  userCount: number;
  descendantUserCount: number;
  children: Node[];
}

interface Storage {
  storageModel: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  perUserFloor: number;
  userCount: number;
  maxUsers: number | null;
}

const ROLES = ['employee', 'manager', 'org_admin'];

function fmt(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= GB) return `${Math.round(bytes / GB)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export default function DepartmentsPage() {
  const { authedFetch } = useAuth();

  const [tree, setTree] = useState<Node[]>([]);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [unassigned, setUnassigned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Node | null>(null);
  const [addingUnder, setAddingUnder] = useState<Node | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/org/departments');
      if (!res.ok) throw new Error('Could not load departments.');
      const body = await res.json();
      setTree(body.tree ?? []);
      setStorage(body.storage ?? null);
      setUnassigned(body.unassignedUsers ?? 0);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load departments.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function remove(node: Node) {
    const res = await authedFetch(`/org/departments/${node.id}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error ?? 'Could not delete.'); return; }
    await load();
  }

  const pct = storage && storage.totalBytes > 0
    ? Math.min(100, Math.round((storage.usedBytes / storage.totalBytes) * 100))
    : 0;

  return (
    <AdminShell
      scope="organisation"
      title="Departments"
      subtitle="Groups that carry storage and permissions, and pass them down"
      actions={<Button variant="primary" onClick={() => setAddingUnder(null)}>Add department</Button>}
    >
      {error && <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>{error}</Alert>}

      {storage && (
        <Box sx={{ display: 'grid', gap: 2, mb: 3,
                   gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' } }}>
          <Stat label="People" caption={storage.maxUsers ? `of ${storage.maxUsers} seats` : 'No seat limit'}
                value={String(storage.userCount)} />
          <Stat label="Storage used" caption={`of ${fmt(storage.totalBytes)}`}
                value={fmt(storage.usedBytes)} />
          <Stat label="Default per person" caption="Where inheritance bottoms out"
                value={fmt(storage.perUserFloor)} />
        </Box>
      )}

      {storage && storage.totalBytes > 0 && (
        <Box sx={{ mb: 3 }}>
          <LinearProgress variant="determinate" value={pct}
                          color={pct >= 95 ? 'error' : pct >= 80 ? 'warning' : 'primary'} />
          <Typography variant="caption" color="text.secondary">
            {pct}% of the pool used · {fmt(storage.availableBytes)} free
          </Typography>
        </Box>
      )}

      <Card padded={false}>
        {loading ? (
          <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}><CircularProgress /></Box>
        ) : tree.length === 0 ? (
          <Empty
            title="No departments yet"
            hint="A department carries storage and permissions for everyone in it — and passes them down to any sub-department underneath."
            action={<Button variant="primary" onClick={() => setAddingUnder(null)}>Add the first one</Button>}
          />
        ) : (
          <Box sx={{ py: 1 }}>
            {tree.map((n) => (
              <Row key={n.id} node={n} depth={0}
                   onAddChild={setAddingUnder} onEdit={setEditing} onDelete={remove} />
            ))}
          </Box>
        )}
      </Card>

      {unassigned > 0 && (
        <Alert severity="info" sx={{ mt: 3 }}>
          {unassigned} {unassigned === 1 ? 'person is' : 'people are'} in no department, so
          they get the organisation default of {fmt(storage?.perUserFloor ?? null)} and no
          departmental permissions.
        </Alert>
      )}

      {(editing || addingUnder !== undefined) && (
        <DeptDialog
          node={editing}
          parent={addingUnder ?? null}
          storage={storage}
          onClose={() => { setEditing(null); setAddingUnder(undefined); }}
          onSaved={async () => { setEditing(null); setAddingUnder(undefined); await load(); }}
          onError={setError}
        />
      )}
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
function Row({ node, depth, onAddChild, onEdit, onDelete }: {
  node: Node; depth: number;
  onAddChild: (n: Node) => void;
  onEdit: (n: Node) => void;
  onDelete: (n: Node) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: 1.5, py: 1.25, pr: 2,
          pl: 2 + depth * 3,
          '&:hover': { bgcolor: 'background.default' },
          '&:hover .dept-actions': { opacity: 1 },
        }}
      >
        <IconButton size="small" onClick={() => setOpen((v) => !v)}
                    sx={{ visibility: hasChildren ? 'visible' : 'hidden', p: 0.25 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.4" strokeLinecap="round"
               style={{ transform: open ? 'rotate(90deg)' : 'none', transition: '.15s' }}>
            <path d="M9 6l6 6-6 6" />
          </svg>
        </IconButton>

        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: node.colour, flexShrink: 0 }} />

        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{node.name}</Typography>
            {!node.canSendExternal && (
              <Tooltip title="Members can email inside the organisation only">
                <Chip label="internal only" size="small" variant="outlined" />
              </Tooltip>
            )}
          </Box>
          <Typography variant="caption" color="text.secondary">
            {node.userCount} direct
            {node.descendantUserCount !== node.userCount && ` · ${node.descendantUserCount} including sub-departments`}
            {node.description && ` · ${node.description}`}
          </Typography>
        </Box>

        {/* The whole reason this screen exists: showing WHERE the number came
            from. An admin who cannot see that 30 GB was inherited will set it
            again on every team, and the tree stops earning its keep. */}
        <Box sx={{ textAlign: 'right', minWidth: 130 }}>
          <Typography variant="body2">{fmt(node.effectiveQuotaBytes)}</Typography>
          <Typography variant="caption"
                      color={node.quotaInherited ? 'text.disabled' : 'primary.main'}>
            {node.quotaInherited ? 'inherited' : 'set here'}
          </Typography>
        </Box>

        <Box className="dept-actions" sx={{ display: 'flex', gap: 0.5, opacity: 0, transition: '.15s' }}>
          <Tooltip title="Add sub-department">
            <IconButton size="small" onClick={() => onAddChild(node)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </IconButton>
          </Tooltip>
          <Tooltip title="Edit">
            <IconButton size="small" onClick={() => onEdit(node)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
              </svg>
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton size="small" onClick={() => onDelete(node)} sx={{ color: 'error.main' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round">
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
              </svg>
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {hasChildren && (
        <Collapse in={open} unmountOnExit>
          {node.children.map((c) => (
            <Row key={c.id} node={c} depth={depth + 1}
                 onAddChild={onAddChild} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </Collapse>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function DeptDialog({ node, parent, storage, onClose, onSaved, onError }: {
  node: Node | null;
  parent: Node | null;
  storage: Storage | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const { authedFetch } = useAuth();
  const editing = !!node;

  const [name, setName] = useState(node?.name ?? '');
  const [description, setDescription] = useState(node?.description ?? '');
  const [role, setRole] = useState(node?.defaultRole ?? 'employee');
  const [external, setExternal] = useState(node?.canSendExternal ?? false);
  const [colour, setColour] = useState(node?.colour ?? '#7367f0');

  // Two separate pieces of state, because "inherit" and "a number" are
  // different answers — a single field with 0 meaning inherit would make
  // "actually zero" unsayable.
  const [inherit, setInherit] = useState(node ? node.quotaInherited : true);
  const [quotaGb, setQuotaGb] = useState(
    node?.ownQuotaBytes ? Math.round(node.ownQuotaBytes / GB) : 15,
  );

  const [busy, setBusy] = useState(false);

  const inheritedFrom = parent?.effectiveQuotaBytes ?? storage?.perUserFloor ?? null;

  async function save() {
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        parentId: editing ? undefined : parent?.id ?? null,
        defaultRole: role,
        defaultQuotaBytes: inherit ? null : quotaGb * GB,
        canSendExternal: external,
        colour,
      };

      const res = await authedFetch(
        editing ? `/org/departments/${node!.id}` : '/org/departments',
        { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        {editing ? `Edit ${node!.name}` : parent ? `New department in ${parent.name}` : 'New department'}
        {!editing && (
          <Typography variant="body2" color="text.secondary">
            {parent
              ? 'It inherits storage and settings from its parent unless you override them.'
              : 'A top-level department. Everyone in it gets these settings.'}
          </Typography>
        )}
      </DialogTitle>

      <DialogContent>
        <TextField autoFocus fullWidth label="Name" required value={name}
                   onChange={(e) => setName(e.target.value)}
                   placeholder="Engineering" sx={{ mt: 1, mb: 2.5 }} />

        <TextField fullWidth label="Description" value={description}
                   onChange={(e) => setDescription(e.target.value)} sx={{ mb: 2.5 }} />

        <Box sx={{ display: 'flex', gap: 2, mb: 2.5, flexWrap: 'wrap' }}>
          <TextField select label="Default role" value={role}
                     onChange={(e) => setRole(e.target.value)}
                     sx={{ flex: 1, minWidth: 180 }}
                     helperText="Given to new people added here">
            {ROLES.map((r) => (
              <MenuItem key={r} value={r} sx={{ textTransform: 'capitalize' }}>
                {r.replace('_', ' ')}
              </MenuItem>
            ))}
          </TextField>

          <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box component="input" type="color" value={colour}
                 onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColour(e.target.value)}
                 sx={{ width: 44, height: 40, p: 0.5, cursor: 'pointer',
                       border: '1px solid', borderColor: 'divider', borderRadius: 1,
                       bgcolor: 'transparent' }} />
            <Typography variant="caption" color="text.secondary">Colour</Typography>
          </Box>
        </Box>

        {/* ---- Storage ---- */}
        <Box sx={{ p: 2, borderRadius: 2, mb: 2.5,
                   bgcolor: (t) => alpha(t.palette.primary.main, 0.05) }}>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 1.5 }}>
            Storage per person
          </Typography>

          <FormControlLabel
            control={<Switch checked={inherit} onChange={(e) => setInherit(e.target.checked)} />}
            label={
              <Typography variant="body2">
                Inherit {inheritedFrom !== null && <strong>{fmt(inheritedFrom)}</strong>}
                {parent ? ` from ${parent.name}` : ' from the organisation default'}
              </Typography>
            }
          />

          <Collapse in={!inherit}>
            <TextField
              type="number" label="Storage per person" value={quotaGb}
              onChange={(e) => setQuotaGb(Math.max(1, Number(e.target.value)))}
              sx={{ mt: 1.5, width: 220 }}
              slotProps={{
                input: { endAdornment: <InputAdornment position="end">GB</InputAdornment> },
                htmlInput: { min: 1, max: 5000 },
              }}
              helperText="Applies here and to every sub-department that inherits"
            />
          </Collapse>

          {storage && !inherit && (
            <Typography variant="caption" color="text.secondary"
                        sx={{ display: 'block', mt: 1 }}>
              {fmt(storage.availableBytes)} free in the pool.
              {storage.storageModel === 'per_user'
                ? ' Per-user plan — each person is capped individually.'
                : ' Pooled plan — everyone draws from the same total.'}
            </Typography>
          )}
        </Box>

        {/* ---- Permission ---- */}
        <FormControlLabel
          control={<Switch checked={external} onChange={(e) => setExternal(e.target.checked)} />}
          label={
            <Box>
              <Typography variant="body2">Can email outside the organisation</Typography>
              <Typography variant="caption" color="text.secondary">
                Off means they can only email colleagues. This does <strong>not</strong> inherit —
                it is chosen per department, so a new one is never accidentally permissive.
              </Typography>
            </Box>
          }
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={busy || name.trim().length < 2}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create department'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
