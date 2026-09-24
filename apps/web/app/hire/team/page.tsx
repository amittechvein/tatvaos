'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Field, Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Form';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { useHireAccess } from '../HireAccess';

// ============================================================================
//  The hiring team (Amit, 24 September 2026)
//
//  Recruiters: every job opening. Hiring managers: only the jobs that name
//  them. Administrators need no entry. Only administrators change this list;
//  recruiters see it read-only. It is a Hire role and changes nothing about
//  what the person can do anywhere else in TatvaOS — the page says so.
// ============================================================================

type Role = 'recruiter' | 'hiring_manager';

interface Member {
  userId: string;
  displayName: string;
  email: string;
  active: boolean;
  role: Role;
}

interface Person { id: string; displayName: string; email: string }

const ROLE_LABEL: Record<Role, string> = { recruiter: 'Recruiter', hiring_manager: 'Hiring manager' };
const ROLE_HINT: Record<Role, string> = {
  recruiter: 'Sees and manages every job opening.',
  hiring_manager: 'Sees and manages only the jobs where they are the hiring manager.',
};

export default function HireTeamPage() {
  const { authedFetch } = useAuth();
  const me = useHireAccess();
  const canEdit = me.canManageTeam;

  const [members, setMembers] = useState<Member[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [t, o] = await Promise.all([authedFetch('/hire/team'), authedFetch('/hire/jobs/options')]);
    if (!t.ok) { setError('Could not load the team.'); setMembers([]); return; }
    setMembers(await t.json());
    if (o.ok) setPeople((await o.json()).people ?? []);
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function setRole(userId: string, role: Role) {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/hire/team/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: Member) {
    setBusy(true);
    try {
      const res = await authedFetch(`/hire/team/${m.userId}`, { method: 'DELETE' });
      if (!res.ok) setError('Could not remove.');
      await load();
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  const onTeam = new Set((members ?? []).map((m) => m.userId));

  return (
    <>
      <PageHeader
        title="Hiring team"
        subtitle="Who besides administrators can use Hire"
        actions={canEdit ? <Button variant="primary" onClick={() => setAdding(true)}>Add to team</Button> : undefined}
      />

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      <Alert tone="info">
        A Hire role only. It does not change what anyone can do elsewhere in TatvaOS.
        {!canEdit && ' Only an administrator can change the team.'}
      </Alert>

      <Card padded={false}>
        {members === null ? (
          <Spinner />
        ) : members.length === 0 ? (
          <Empty
            title="Nobody on the team yet"
            hint="Administrators can always use Hire. Add recruiters and hiring managers so they can too."
            action={canEdit ? <Button variant="primary" onClick={() => setAdding(true)}>Add the first person</Button> : undefined}
          />
        ) : (
          <Table head={['Name', 'Role', '']}>
            {members.map((m) => (
              <tr key={m.userId}>
                <Td>
                  <div className="font-medium text-ink">{m.displayName}</div>
                  <div className="text-xs text-ink-muted">{m.email}{m.active ? '' : ' · not active'}</div>
                </Td>
                <Td>
                  {canEdit ? (
                    <Select aria-label={`Role for ${m.displayName}`} value={m.role} disabled={busy}
                            onChange={(e) => void setRole(m.userId, e.target.value as Role)}>
                      <option value="recruiter">{ROLE_LABEL.recruiter}</option>
                      <option value="hiring_manager">{ROLE_LABEL.hiring_manager}</option>
                    </Select>
                  ) : (
                    <Badge tone={m.role === 'recruiter' ? 'info' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
                  )}
                </Td>
                <Td className="text-right">
                  {canEdit && (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>Remove</Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {adding && (
        <AddDialog
          people={people.filter((p) => !onTeam.has(p.id))}
          busy={busy}
          onClose={() => setAdding(false)}
          onAdd={async (userId, role) => { if (await setRole(userId, role)) setAdding(false); }}
        />
      )}

      {removing && (
        <Modal
          title={`Remove ${removing.displayName} from the hiring team?`}
          busy={busy}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)} disabled={busy}>Cancel</Button>
              <Button variant="danger" onClick={() => void remove(removing)} disabled={busy}>Remove</Button>
            </>
          }
        >
          <p className="mb-0 text-[0.8125rem] text-ink-muted">
            They will no longer be able to open Hire. Jobs that name them as hiring manager or
            recruiter keep their name.
          </p>
        </Modal>
      )}
    </>
  );
}

function AddDialog({ people, busy, onClose, onAdd }: {
  people: Person[];
  busy: boolean;
  onClose: () => void;
  onAdd: (userId: string, role: Role) => void;
}) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('recruiter');
  return (
    <Modal
      title="Add to the hiring team"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => onAdd(userId, role)} disabled={busy || !userId}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </>
      }
    >
      <Field label="Person" required>
        <Select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person">
          <option value="">Choose…</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.displayName} — {p.email}</option>)}
        </Select>
      </Field>
      <Field label="Role" hint={ROLE_HINT[role]}>
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          <option value="recruiter">{ROLE_LABEL.recruiter}</option>
          <option value="hiring_manager">{ROLE_LABEL.hiring_manager}</option>
        </Select>
      </Field>
    </Modal>
  );
}
