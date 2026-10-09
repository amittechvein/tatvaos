'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Select } from '@/components/ui/Form';
import { Field, Modal } from '@/components/ui/Modal';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { usePeopleAccess } from '../PeopleAccess';

interface Member { userId: string; name: string | null; createdAt: string }
interface Person { id: string; displayName: string; email: string }

// ============================================================================
//  People HR — who sees every employee record (decision 0018 §4).
//
//  Administrators name them, themselves included; nobody is People HR by
//  role. Each addition is audited, and an administrator adding themselves is
//  recorded as exactly that (Amit, 9 Oct 2026). The page's sentence says what
//  the code grants: PeopleAccess.VisibleAsync gives HR every record, and the
//  employee endpoints let only HR write.
// ============================================================================
export default function PeopleHrPage() {
  const { authedFetch, user } = useAuth();
  const { me, reload } = usePeopleAccess();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authedFetch('/people/hr');
    if (!res.ok) { setError('Could not load People HR.'); setMembers([]); return; }
    setMembers(await res.json());
    if (me.canNameHr) {
      const u = await authedFetch('/org/users');
      if (u.ok) {
        const body = await u.json();
        const list = (Array.isArray(body) ? body : body.items ?? body.users ?? []) as Person[];
        setPeople(list.map((p) => ({ id: p.id, displayName: p.displayName, email: p.email })));
      }
    }
  }, [authedFetch, me.canNameHr]);

  useEffect(() => { void load(); }, [load]);

  async function change(userId: string, method: 'PUT' | 'DELETE') {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/people/hr/${userId}`, { method });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save.');
      setAdding(false);
      setPick('');
      await load();
      if (userId === user?.id) await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const onList = new Set((members ?? []).map((m) => m.userId));

  return (
    <>
      <PageHeader
        title="People HR"
        subtitle="Who can see and change every employee record"
        actions={me.canNameHr ? <Button variant="primary" onClick={() => setAdding(true)}>Add someone</Button> : undefined}
      />
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      <Alert tone="info">
        People HR see every employee record in your organisation and can add, change and record people
        leaving. Administrators are not People HR unless they add themselves; every addition is recorded.
        {!me.canNameHr && ' Only an administrator can change this list.'}
      </Alert>

      <Card padded={false}>
        {members === null ? <Spinner /> : members.length === 0 ? (
          <Empty title="Nobody is People HR yet" hint="Until someone is, nobody can see or add employee records." />
        ) : (
          <Table head={['Name', 'Since', '']}>
            {members.map((m) => (
              <tr key={m.userId}>
                <Td>{m.name ?? 'Unknown'}{m.userId === user?.id ? ' (you)' : ''}</Td>
                <Td>{new Date(m.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</Td>
                <Td className="text-right">
                  {me.canNameHr && <Button size="sm" variant="ghost" onClick={() => void change(m.userId, 'DELETE')} disabled={busy}>Remove</Button>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {adding && (
        <Modal title="Add to People HR" onClose={() => setAdding(false)} busy={busy}
               footer={<>
                 <Button variant="ghost" onClick={() => setAdding(false)} disabled={busy}>Cancel</Button>
                 <Button variant="primary" onClick={() => void change(pick, 'PUT')} disabled={busy || !pick}>Add</Button>
               </>}>
          <Field label="Person" hint="They will see every employee record. This is recorded.">
            <Select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose…</option>
              {people.filter((p) => !onList.has(p.id)).map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}{p.id === user?.id ? ' (you)' : ''} — {p.email}</option>
              ))}
            </Select>
          </Field>
        </Modal>
      )}
    </>
  );
}
