'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, Spinner, Table, Td } from '@/components/ui/Kit';
import { Field, Input } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { bodyFrom, EmployeeForm } from '../_components/EmployeeForm';
import { STATUS_LABEL, TYPE_LABEL, usePeopleAccess, type Employee } from '../PeopleAccess';

interface Change { fromManagerId: string | null; toManagerId: string | null; changedBy: string; changedAt: string }

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

// ============================================================================
//  One employee: read for anyone who may see them (the API decides), edit,
//  record leaving and the manager history for People HR. The history is also
//  shown to the person themselves — "who changed my manager" is theirs to
//  know (setting a manager grants access; Mr. Singh, 9 Oct 2026).
// ============================================================================
export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  const { authedFetch } = useAuth();
  const { me } = usePeopleAccess();
  const [e, setE] = useState<Employee | null | 'missing'>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [history, setHistory] = useState<Change[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [exitOn, setExitOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authedFetch(`/people/employees/${id}`);
    if (!res.ok) { setE('missing'); return; }
    const emp: Employee = await res.json();
    setE(emp);
    // Names for "reports to" and the history: whoever this person may see.
    const all = await authedFetch('/people/employees');
    if (all.ok) setNames(new Map((await all.json() as Employee[]).map((x) => [x.id, x.fullName])));
    if (me.isHr || me.employee?.id === emp.id) {
      const h = await authedFetch(`/people/employees/${id}/reporting-changes`);
      setHistory(h.ok ? await h.json() : []);
    }
  }, [authedFetch, id, me.isHr, me.employee?.id]);

  useEffect(() => { void load(); }, [load]);

  async function recordLeaving() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/people/employees/${id}/exit`, { method: 'POST', body: JSON.stringify({ exitOn: exitOn || null }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not record this.');
      setLeaving(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record this.');
    } finally {
      setBusy(false);
    }
  }

  if (e === null) return <Spinner />;
  if (e === 'missing')
    return (
      <>
        <PageHeader title="Employee" breadcrumb={[{ label: 'People', href: '/people' }, { label: 'Not found' }]} />
        <Alert tone="info">There is no employee record here that you can see.</Alert>
      </>
    );

  const crumbs = [{ label: 'People', href: '/people' }, { label: e.fullName }];
  const name = (x: string | null) => (x ? (names.get(x) ?? 'someone you cannot see') : 'nobody');

  if (editing && me.isHr)
    return (
      <>
        <PageHeader title={`Edit ${e.fullName}`} breadcrumb={crumbs} />
        <EmployeeForm
          existing={e}
          submitLabel="Save"
          onSubmit={async (d) => {
            const res = await authedFetch(`/people/employees/${e.id}`, { method: 'PUT', body: JSON.stringify(bodyFrom(d, false)) });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return body.error ?? 'Could not save.';
            setEditing(false);
            await load();
            return null;
          }}
        />
      </>
    );

  return (
    <>
      <PageHeader
        title={e.fullName}
        subtitle={`${e.employeeCode} · ${TYPE_LABEL[e.employmentType]}`}
        breadcrumb={crumbs}
        actions={me.isHr && e.status !== 'exited' ? (
          <>
            <Button onClick={() => setLeaving(true)}>Record leaving</Button>
            <Button variant="primary" onClick={() => setEditing(true)}>Edit</Button>
          </>
        ) : undefined}
      />
      {error && !leaving && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <Card title="Record" className="mb-5">
        <dl className="grid gap-x-6 gap-y-3 text-[0.8125rem] sm:grid-cols-2">
          <div><dt className="text-ink-muted">Status</dt><dd><Badge tone={e.status === 'active' ? 'ok' : e.status === 'on_notice' ? 'warn' : 'neutral'}>{STATUS_LABEL[e.status]}</Badge></dd></div>
          <div><dt className="text-ink-muted">Reports to</dt><dd>{e.reportsTo ? name(e.reportsTo) : 'Nobody'}</dd></div>
          <div><dt className="text-ink-muted">Work email</dt><dd>{e.workEmail ?? '—'}</dd></div>
          <div><dt className="text-ink-muted">Joined on</dt><dd>{fmt(e.joinedOn)}</dd></div>
          {e.exitOn && <div><dt className="text-ink-muted">Last day</dt><dd>{fmt(e.exitOn)}</dd></div>}
          <div><dt className="text-ink-muted">Signs in to TatvaOS</dt><dd>{e.userId ? 'Yes' : 'No'}</dd></div>
        </dl>
      </Card>

      {history && (
        <Card title="Who they report to, over time" padded={false}>
          {history.length === 0 ? (
            <p className="p-4 text-[0.8125rem] text-ink-muted">No manager has been set.</p>
          ) : (
            <Table head={['When', 'Change']}>
              {history.map((h, i) => (
                <tr key={i}>
                  <Td>{fmt(h.changedAt)}</Td>
                  <Td>From {name(h.fromManagerId)} to {name(h.toManagerId)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {leaving && (
        <Modal title={`Record ${e.fullName} leaving`} onClose={() => setLeaving(false)} busy={busy}
               footer={<>
                 <Button variant="ghost" onClick={() => setLeaving(false)} disabled={busy}>Cancel</Button>
                 <Button variant="danger" onClick={() => void recordLeaving()} disabled={busy || !exitOn}>Record leaving</Button>
               </>}>
          {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
          <p className="mb-3 text-[0.8125rem] text-ink-muted">
            Their record is kept, marked as left. Anyone who reports to them must be moved to another
            manager first.
          </p>
          <Field label="Last day" required>
            <Input type="date" aria-label="Last day" value={exitOn} onChange={(ev) => setExitOn(ev.target.value)} />
          </Field>
        </Modal>
      )}
    </>
  );
}
