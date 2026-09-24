'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Modal, Field } from '@/components/ui/Modal';
import { Input, Switch } from '@/components/ui/Form';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Locations — where an organisation works
// ============================================================================
//
//  Phase 0 of Hire & People (24 September 2026). A flat list: every job
//  opening, and later every employee, names one. "Remote" is a location too,
//  flagged as not being a place, because attendance will need to know.
//
//  Archive rather than delete once anything uses a row. Switching "In use"
//  off hides it from new choices and leaves everything that already names it
//  alone; the API will refuse a delete once jobs reference locations.
// ============================================================================

interface Location {
  id: string;
  name: string;
  code: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  isRemote: boolean;
  isActive: boolean;
}

function place(l: Location): string {
  if (l.isRemote) return 'Remote';
  return [l.city, l.state, l.country].filter(Boolean).join(', ');
}

export default function LocationsPage() {
  const { authedFetch } = useAuth();

  const [rows, setRows] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // undefined = closed, null = adding, a row = editing
  const [editing, setEditing] = useState<Location | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Location | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/org/locations');
      if (!res.ok) throw new Error('Could not load locations.');
      setRows(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load locations.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function remove(row: Location) {
    setDeletingBusy(true);
    try {
      const res = await authedFetch(`/org/locations/${row.id}`, { method: 'DELETE' });
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
      title="Locations"
      subtitle="Offices, campuses and remote work — what job openings and people are placed at"
      actions={<Button variant="primary" onClick={() => setEditing(null)}>Add location</Button>}
    >
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <Card padded={false}>
        {loading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty
            title="No locations yet"
            hint="Add each office or campus once. Job openings pick from this list, so candidates see where a role is."
            action={<Button variant="primary" onClick={() => setEditing(null)}>Add the first one</Button>}
          />
        ) : (
          <Table head={['Name', 'Place', 'Code', 'Status', '']}>
            {rows.map((l) => (
              <tr key={l.id}>
                <Td className="font-medium text-ink">{l.name}</Td>
                <Td>{place(l) || '—'}</Td>
                <Td>{l.code ?? '—'}</Td>
                <Td>{l.isActive ? <Badge tone="ok">In use</Badge> : <Badge>Archived</Badge>}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => setEditing(l)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(l)}>Delete</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {editing !== undefined && (
        <LocationDialog
          row={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => { setEditing(undefined); await load(); }}
        />
      )}

      {deleting && (
        <Modal
          title={`Delete ${deleting.name}?`}
          busy={deletingBusy}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={deletingBusy}>Cancel</Button>
              <Button variant="danger" onClick={() => void remove(deleting)} disabled={deletingBusy}>
                {deletingBusy ? 'Deleting…' : 'Delete location'}
              </Button>
            </>
          }
        >
          <p className="mb-0 text-[0.8125rem] text-ink-muted">
            If you might need it again, edit it and switch off <strong>In use</strong> instead — it
            disappears from new choices and nothing else changes.
          </p>
        </Modal>
      )}
    </AdminShell>
  );
}

function LocationDialog({ row, onClose, onSaved }: {
  row: Location | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authedFetch } = useAuth();
  const [name, setName] = useState(row?.name ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [addressLine, setAddressLine] = useState(row?.addressLine ?? '');
  const [city, setCity] = useState(row?.city ?? '');
  const [state, setState] = useState(row?.state ?? '');
  const [postalCode, setPostalCode] = useState(row?.postalCode ?? '');
  const [country, setCountry] = useState(row?.country ?? 'IN');
  const [isRemote, setIsRemote] = useState(row?.isRemote ?? false);
  const [isActive, setIsActive] = useState(row?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(row ? `/org/locations/${row.id}` : '/org/locations', {
        method: row ? 'PUT' : 'POST',
        body: JSON.stringify({
          name, code, addressLine, city, state, postalCode, country, isRemote, isActive,
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
      title={row ? `Edit ${row.name}` : 'New location'}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Name" required>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
               placeholder="Pune office" required autoFocus />
      </Field>
      <Switch label="Remote — not a physical place" checked={isRemote}
              onChange={(e) => setIsRemote(e.target.checked)} />
      {!isRemote && (
        <>
          <Field label="Address">
            <Input value={addressLine} onChange={(e) => setAddressLine(e.target.value)} maxLength={300} />
          </Field>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="City">
              <Input value={city} onChange={(e) => setCity(e.target.value)} maxLength={100} />
            </Field>
            <Field label="State">
              <Input value={state} onChange={(e) => setState(e.target.value)} maxLength={100} />
            </Field>
            <Field label="PIN / postal code">
              <Input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} maxLength={20} />
            </Field>
            <Field label="Country" hint="Two-letter code, such as IN">
              <Input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} />
            </Field>
          </div>
        </>
      )}
      <Field label="Code" hint="Optional — a short code you already use, such as PNQ-1">
        <Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} />
      </Field>
      <Switch label="In use" hint="Switch off to hide it from new choices without deleting it."
              checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
    </Modal>
  );
}
