'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Input, Select } from '@/components/ui/Form';
import { Alert, PageHeader, Toolbar } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { STATUS_LABEL, TYPE_LABEL, usePeopleAccess, type Employee } from './PeopleAccess';

// ============================================================================
//  Employees (HR) or My team (everyone else).
//
//  WHAT EACH SENTENCE PROMISES, CHECKED AGAINST THE CODE (handover §5.2):
//    * HR sees every record — PeopleAccess.VisibleAsync returns all for HR.
//    * Anyone else sees themselves and everyone below them through "reports
//      to" — the same method's recursive query. Not a role: giving someone
//      the Manager role in TatvaOS grants nothing here.
//    * An administrator sees no records until they add themselves as People
//      HR, and that is recorded — /people/hr PUT writes people_hr.added with
//      appointedThemselves (Amit, 9 Oct 2026).
// ============================================================================

export default function PeoplePage() {
  const { authedFetch, user } = useAuth();
  const { me, reload } = usePeopleAccess();
  const [rows, setRows] = useState<Employee[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (q.trim()) qs.set('q', q.trim());
    if (status) qs.set('status', status);
    const res = await authedFetch(`/people/employees${qs.size ? `?${qs}` : ''}`);
    if (!res.ok) { setError('Could not load employee records.'); setRows([]); return; }
    setRows(await res.json());
  }, [authedFetch, q, status]);

  useEffect(() => { void load(); }, [load]);

  // Someone with no record who is neither HR nor an administrator has only
  // the directory here; "My team" would be an empty page.
  const router = useRouter();
  useEffect(() => {
    if (!me.isHr && !me.canNameHr && !me.employee && me.canSeeDirectory) router.replace('/people/directory');
  }, [me, router]);

  async function nameMyselfHr() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/people/hr/${user.id}`, { method: 'PUT' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not add you.');
      await reload();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add you.');
    } finally {
      setBusy(false);
    }
  }

  const names = new Map((rows ?? []).map((e) => [e.id, e.fullName]));

  return (
    <>
      <PageHeader
        title={me.isHr ? 'Employees' : 'My team'}
        subtitle={me.isHr
          ? 'Everyone in your organisation with an employee record'
          : 'Your own record, and the people who report to you'}
        actions={me.isHr ? <Button variant="primary" href="/people/new">Add employee</Button> : undefined}
      />

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      {!me.isHr && me.canNameHr && (
        <Alert tone="info" title="You are an administrator, not People HR"
               action={<Button size="sm" variant="primary" onClick={() => void nameMyselfHr()} disabled={busy}>Add me as People HR</Button>}>
          People HR see every employee record and can add and change them. Administrators do not see
          employee records until they add themselves — and adding yourself is recorded, with the date.
        </Alert>
      )}

      {!me.isHr && me.employee && (
        <Alert tone="info">
          You see your own record{me.directReports > 0 ? ' and the people who report to you, directly or further down' : ''}.
          Who reports to whom is set by People HR.
        </Alert>
      )}

      <Toolbar className="mb-4">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or employee ID"
               aria-label="Search" className="max-w-xs" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="max-w-[12rem]">
          <option value="">Everyone</option>
          <option value="active">Active</option>
          <option value="on_notice">On notice</option>
          <option value="exited">Left</option>
        </Select>
      </Toolbar>

      <Card padded={false}>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty
            title={me.isHr ? 'No employee records yet' : 'Nothing to show'}
            hint={me.isHr ? 'Add the first person, and choose who they report to.' : undefined}
            action={me.isHr ? <Button variant="primary" href="/people/new">Add employee</Button> : undefined}
          />
        ) : (
          <Table head={['Name', 'Employee ID', 'Reports to', 'Type', 'Status']}>
            {rows.map((e) => (
              <tr key={e.id}>
                <Td>
                  <Link href={`/people/${e.id}`} className="font-medium text-ink hover:underline">{e.fullName}</Link>
                  {e.workEmail && <div className="text-xs text-ink-muted">{e.workEmail}</div>}
                </Td>
                <Td className="font-mono text-xs">{e.employeeCode}</Td>
                <Td>{e.reportsTo ? (names.get(e.reportsTo) ?? '—') : '—'}</Td>
                <Td>{TYPE_LABEL[e.employmentType]}</Td>
                <Td><Badge tone={e.status === 'active' ? 'ok' : e.status === 'on_notice' ? 'warn' : 'neutral'}>{STATUS_LABEL[e.status]}</Badge></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
