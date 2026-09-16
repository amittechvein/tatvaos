'use client';

import { useCallback, useEffect, useId, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Button, Card, Empty, Meter, Stat } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { Input, Select } from '@/components/ui/Form';

// ============================================================================
//  Departments — what Google calls Organisational Units
// ============================================================================
//
//  The screen has one job beyond CRUD: make inheritance visible. An admin who
//  cannot see that Backend's 30 GB came from Engineering will set it again on
//  every team, and the tree stops being worth having the moment they do.
//
//  Rendered in YZEN's own Bootstrap markup rather than MUI, like every other
//  console screen. Two component libraries fighting over the same elements is
//  what produced the empty stat cards and orange buttons earlier; there is now
//  exactly one, and it is the licensed theme.
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
  const [deleting, setDeleting] = useState<Node | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

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
    setDeletingBusy(true);
    try {
      const res = await authedFetch(`/org/departments/${node.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? 'Could not delete.'); return; }
      await load();
    } finally {
      setDeletingBusy(false);
      setDeleting(null);
    }
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
      {error && (
        <div className="alert alert-danger !flex !items-center !justify-between" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => setError(null)} />
        </div>
      )}

      {storage && (
        <div className="!mb-[1.5rem] grid !gap-[1rem] sm:grid-cols-3">
          <Stat label="People" caption={storage.maxUsers ? `of ${storage.maxUsers} seats` : 'No seat limit'}
                value={String(storage.userCount)} />
          <Stat label="Storage used" caption={`of ${fmt(storage.totalBytes)}`}
                value={fmt(storage.usedBytes)} />
          <Stat label="Default per person" caption="Where inheritance bottoms out"
                value={fmt(storage.perUserFloor)} />
        </div>
      )}

      {storage && storage.totalBytes > 0 && (
        <div className="!mb-[1.5rem]">
          <Meter used={storage.usedBytes} total={storage.totalBytes} />
          <div className="!text-[0.75rem] !text-ink-muted mt-1">
            {pct}% of the pool used · {fmt(storage.availableBytes)} free
          </div>
        </div>
      )}

      <Card padded={false}>
        {loading ? (
          <div className="grid place-items-center !py-[3rem]">
            <span className="block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
          </div>
        ) : tree.length === 0 ? (
          <Empty
            title="No departments yet"
            hint="A department carries storage and permissions for everyone in it — and passes them down to any sub-department underneath."
            action={<Button variant="primary" onClick={() => setAddingUnder(null)}>Add the first one</Button>}
          />
        ) : (
          <div className="py-2">
            {tree.map((n) => (
              <Row key={n.id} node={n} depth={0}
                   onAddChild={setAddingUnder} onEdit={setEditing} onDelete={setDeleting} />
            ))}
          </div>
        )}
      </Card>

      {unassigned > 0 && (
        <div className="alert alert-info !mt-[1.5rem]" role="note">
          {unassigned} {unassigned === 1 ? 'person is' : 'people are'} in no department, so
          they get the organisation default of {fmt(storage?.perUserFloor ?? null)} and no
          departmental permissions.
        </div>
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

      {/* Deleting a node in a tree is not a small action — anything underneath
          it moves or goes with it. The old screen deleted on the first click. */}
      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          busy={deletingBusy}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={deletingBusy}>Cancel</Button>
              <Button variant="danger" onClick={() => void remove(deleting)} disabled={deletingBusy}>
                {deletingBusy ? 'Deleting…' : 'Delete department'}
              </Button>
            </>
          }
        >
          <p className="!text-[0.8125rem] !text-ink-muted mb-0">
            {deleting.children.length > 0
              ? `It has ${deleting.children.length} sub-department${deleting.children.length === 1 ? '' : 's'} underneath it. `
              : ''}
            {deleting.descendantUserCount > 0
              ? `${deleting.descendantUserCount} ${deleting.descendantUserCount === 1 ? 'person' : 'people'} would lose these settings and fall back to the organisation default. `
              : 'Nobody is in it. '}
            No mailbox or file is deleted.
          </p>
        </Modal>
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
      <div
        className="group flex items-center gap-2 py-2 !pe-[1rem] hover:bg-canvas"
        style={{ paddingInlineStart: 16 + depth * 24 }}
      >
        <button
          type="button"
          className="btn btn-icon btn-sm btn-light border-0 bg-transparent"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={open}
          style={{ visibility: hasChildren ? 'visible' : 'hidden', width: 24, height: 24, padding: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.4" strokeLinecap="round"
               style={{ transform: open ? 'rotate(90deg)' : 'none', transition: '.15s' }}>
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>

        <span className="flex-shrink-0 !rounded-[50%]"
              style={{ width: 10, height: 10, background: node.colour }} />

        <div className="min-w-0 !flex-auto">
          <div className="!flex !items-center gap-2 flex-wrap">
            <span className="!font-semibold !text-[0.875rem]">{node.name}</span>
            {!node.canSendExternal && (
              <span className="badge bg-light !text-ink-muted"
                    title="Members can email inside the organisation only">
                internal only
              </span>
            )}
          </div>
          <div className="!text-[0.75rem] !text-ink-muted">
            {node.userCount} direct
            {node.descendantUserCount !== node.userCount && ` · ${node.descendantUserCount} including sub-departments`}
            {node.description && ` · ${node.description}`}
          </div>
        </div>

        {/* The whole reason this screen exists: showing WHERE the number came
            from. An admin who cannot see that 30 GB was inherited will set it
            again on every team, and the tree stops earning its keep. */}
        <div className="text-end flex-shrink-0" style={{ minWidth: 130 }}>
          <div className="!text-[0.875rem]">{fmt(node.effectiveQuotaBytes)}</div>
          <div className={`!text-[0.6875rem] ${node.quotaInherited ? '!text-ink-muted' : '!text-brand-500 !font-medium'}`}>
            {node.quotaInherited ? 'inherited' : 'set here'}
          </div>
        </div>

        {/* Hidden until the row is hovered, so a deep tree reads as a tree and
            not as three icons per line. Focus reveals them too — keyboard users
            never hover, and buttons they cannot see are buttons they cannot use.

            THE REVEAL CARRIES `!`, AND IT MUST. Bootstrap declares
            `.opacity-0{opacity:0!important}`, so a plain group-hover:opacity-100
            never won: from the day this was written until 15 Sept 2026 the
            buttons stayed invisible even on hover, and Amit found the only
            way in was the browser's "Edit" tooltip over an invisible button.
            A touch screen has no hover at all, so there they are always shown —
            otherwise a phone could never edit or delete a department. */}
        <div className="!flex gap-1 flex-shrink-0 opacity-0 transition group-hover:!opacity-100 focus-within:!opacity-100 [@media(hover:none)]:!opacity-100">
          <button type="button" className="btn btn-icon btn-sm btn-light"
                  title="Add sub-department" aria-label={`Add a sub-department in ${node.name}`}
                  onClick={() => onAddChild(node)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button type="button" className="btn btn-icon btn-sm btn-light"
                  title="Edit" aria-label={`Edit ${node.name}`}
                  onClick={() => onEdit(node)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
            </svg>
          </button>
          <button type="button" className="btn btn-icon btn-sm btn-light text-danger"
                  title="Delete" aria-label={`Delete ${node.name}`}
                  onClick={() => onDelete(node)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </svg>
          </button>
        </div>
      </div>

      {hasChildren && open && node.children.map((c) => (
        <Row key={c.id} node={c} depth={depth + 1}
             onAddChild={onAddChild} onEdit={onEdit} onDelete={onDelete} />
      ))}
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
  const uid = useId();

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
    <Modal
      title={editing ? `Edit ${node!.name}` : parent ? `New department in ${parent.name}` : 'New department'}
      subtitle={
        editing
          ? undefined
          : parent
            ? 'It inherits storage and settings from its parent unless you override them.'
            : 'A top-level department. Everyone in it gets these settings.'
      }
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || name.trim().length < 2}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create department'}
          </Button>
        </>
      }
    >
      <Field label="Name" required>
        <Input  autoFocus placeholder="Engineering"
               value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Description">
        <Input  value={description}
               onChange={(e) => setDescription(e.target.value)} />
      </Field>

      {/* Flex rather than an arbitrary grid template: overrides.css can only
          re-assert the enumerated grid-cols-* utilities after neutralising
          YZEN's own .grid rule, so a custom template silently collapses. */}
      <div className="!flex !gap-[1rem] flex-wrap !items-start">
        <div className="!flex-auto" style={{ minWidth: 180 }}>
          <Field label="Default role" hint="Given to new people added here">
            <Select  value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r} style={{ textTransform: 'capitalize' }}>
                  {r.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Colour">
          <Input type="color"  value={colour}
                 onChange={(e) => setColour(e.target.value)}
                 title="Colour used for this department" />
        </Field>
      </div>

      {/* ---- Storage ---- */}
      <div className="rounded-card border border-line bg-canvas !p-[1rem] !mb-[1rem]">
        <div className="!font-semibold !text-[0.875rem] mb-2">Storage per person</div>

        <div className="form-check form-switch">
          <input className="form-check-input" type="checkbox" role="switch"
                 id={`${uid}-inherit`} checked={inherit}
                 onChange={(e) => setInherit(e.target.checked)} />
          <label className="form-check-label !text-[0.8125rem]" htmlFor={`${uid}-inherit`}>
            Inherit {inheritedFrom !== null && <strong>{fmt(inheritedFrom)}</strong>}
            {parent ? ` from ${parent.name}` : ' from the organisation default'}
          </label>
        </div>

        {!inherit && (
          <div className="!mt-[1rem]">
            <Field label="Storage per person"
                   hint="Applies here and to every sub-department that inherits">
              <div className="input-group" style={{ maxWidth: 220 }}>
                <Input type="number"  min={1} max={5000} value={quotaGb}
                       onChange={(e) => setQuotaGb(Math.max(1, Number(e.target.value)))} />
                <span className="input-group-text">GB</span>
              </div>
            </Field>
          </div>
        )}

        {storage && !inherit && (
          <div className="!text-[0.75rem] !text-ink-muted">
            {fmt(storage.availableBytes)} free in the pool.
            {storage.storageModel === 'per_user'
              ? ' Per-user plan — each person is capped individually.'
              : ' Pooled plan — everyone draws from the same total.'}
          </div>
        )}
      </div>

      {/* ---- Permission ---- */}
      <div className="form-check form-switch">
        <input className="form-check-input" type="checkbox" role="switch"
               id={`${uid}-external`} checked={external}
               onChange={(e) => setExternal(e.target.checked)} />
        <label className="form-check-label" htmlFor={`${uid}-external`}>
          <span className="!block !text-[0.875rem]">Can email outside the organisation</span>
          <span className="!block !text-[0.75rem] !text-ink-muted">
            Off means they can only email colleagues. This does <strong>not</strong> inherit —
            it is chosen per department, so a new one is never accidentally permissive.
          </span>
        </label>
      </div>
    </Modal>
  );
}
