'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { Input, Switch, Textarea } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Designations — job titles
// ============================================================================
//
//  Phase 0 of Hire & People (24 September 2026). What a person is CALLED at
//  work, not what they may DO in TatvaOS — that is the role on the People
//  screen, and the two are kept apart on purpose. The page says so, because
//  an admin who thinks "Principal" grants admin rights will be surprised.
// ============================================================================

interface Designation {
  id: string;
  title: string;
  grade: string | null;
  level: number | null;
  description: string | null;
  isActive: boolean;
}

export default function DesignationsPage() {
  const { authedFetch } = useAuth();

  const [rows, setRows] = useState<Designation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Designation | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Designation | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/org/designations');
      if (!res.ok) throw new Error('Could not load designations.');
      setRows(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load designations.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function remove(row: Designation) {
    setDeletingBusy(true);
    try {
      const res = await authedFetch(`/org/designations/${row.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? 'Could not delete.'); return; }
      await load();
    } finally {
      setDeletingBusy(false);
      setDeleting(null);
    }
  }

  return (
    <AdminShell
      scope="organisation"
      title="Designations"
      subtitle="Job titles your organisation uses — for job openings and, later, employees"
      actions={<Button variant="primary" onClick={() => setEditing(null)}>Add designation</Button>}
    >
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <Alert tone="info">
        A designation is a job title only. It does not change what anyone can do in TatvaOS — that
        is set by their role on the People screen.
      </Alert>

      <Card padded={false}>
        {loading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty
            title="No designations yet"
            hint="Add the job titles you hire for. Job openings pick from this list."
            action={<Button variant="primary" onClick={() => setEditing(null)}>Add the first one</Button>}
          />
        ) : (
          <Table head={['Title', 'Grade', 'Level', 'Status', '']}>
            {rows.map((d) => (
              <tr key={d.id}>
                <Td className="font-medium text-ink">{d.title}</Td>
                <Td>{d.grade ?? '—'}</Td>
                <Td>{d.level ?? '—'}</Td>
                <Td>{d.isActive ? <Badge tone="ok">In use</Badge> : <Badge>Archived</Badge>}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => setEditing(d)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(d)}>Delete</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing !== undefined && (
        <DesignationDialog
          row={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => { setEditing(undefined); await load(); }}
        />
      )}

      {deleting && (
        <Modal
          title={`Delete ${deleting.title}?`}
          busy={deletingBusy}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={deletingBusy}>Cancel</Button>
              <Button variant="danger" onClick={() => void remove(deleting)} disabled={deletingBusy}>
                {deletingBusy ? 'Deleting…' : 'Delete designation'}
              </Button>
            </>
          }
        >
          <p className="mb-0 text-[0.8125rem] text-ink-muted">
            If you might need it again, edit it and switch off <strong>In use</strong> instead.
          </p>
        </Modal>
      )}
    </AdminShell>
  );
}

function DesignationDialog({ row, onClose, onSaved }: {
  row: Designation | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authedFetch } = useAuth();
  const [title, setTitle] = useState(row?.title ?? '');
  const [grade, setGrade] = useState(row?.grade ?? '');
  const [level, setLevel] = useState(row?.level?.toString() ?? '');
  const [description, setDescription] = useState(row?.description ?? '');
  const [isActive, setIsActive] = useState(row?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(row ? `/org/designations/${row.id}` : '/org/designations', {
        method: row ? 'PUT' : 'POST',
        body: JSON.stringify({
          title,
          grade,
          level: level.trim() === '' ? null : Number(level),
          description,
          isActive,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={row ? `Edit ${row.title}` : 'New designation'}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Title" required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100}
               placeholder="Senior Software Engineer" required autoFocus />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Grade or band" hint="Optional, such as L3">
          <Input value={grade} onChange={(e) => setGrade(e.target.value)} maxLength={20} />
        </Field>
        <Field label="Seniority" hint="Optional, 0–100. Higher lists first.">
          <Input type="number" min={0} max={100} value={level}
                 onChange={(e) => setLevel(e.target.value)} />
        </Field>
      </div>
      <Field label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={3} />
      </Field>
      <Switch label="In use" hint="Switch off to hide it from new choices without deleting it."
              checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
    </Modal>
  );
}
