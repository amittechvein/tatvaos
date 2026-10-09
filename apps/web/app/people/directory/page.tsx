'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Field, Input, Select, Switch } from '@/components/ui/Form';
import { Alert, PageHeader, Toolbar } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { usePeopleAccess } from '../PeopleAccess';

interface Entry {
  id: string;
  name: string;
  designation: string | null;
  department: string | null;
  location: string | null;
  workEmail: string | null;
  manager: string | null;
}

// ============================================================================
//  The staff directory (decision 0018 §5, Amit 9 Oct 2026).
//
//  WHAT THE PAGE PROMISES, CHECKED AGAINST THE CODE (handover §5.2):
//    * colleagues see name, designation, department, location, work email and
//      manager — PeopleAccess.DirectoryEntry has exactly those fields;
//    * employee IDs, status, joining and leaving dates and employment type are
//      never shown here — they are not in that record at all, so no setting
//      can show them. Someone on notice looks like anyone else; someone who has
//      left is not listed;
//    * an organisation may narrow it: People HR only, or without managers —
//      people.directory_settings, read by the same method.
// ============================================================================
export default function DirectoryPage() {
  const { authedFetch } = useAuth();
  const { me } = usePeopleAccess();
  const canSet = me.isHr || me.canNameHr;
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [q, setQ] = useState('');
  const [settings, setSettings] = useState<{ visibleTo: 'everyone' | 'hr_only'; showManager: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authedFetch(`/people/directory${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
    if (res.status === 403) { setError((await res.json().catch(() => ({}))).error ?? 'The directory is not open to you.'); setRows([]); return; }
    if (!res.ok) { setError('Could not load the directory.'); setRows([]); return; }
    setRows(await res.json());
  }, [authedFetch, q]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!canSet) return;
    void (async () => {
      const res = await authedFetch('/people/directory/settings');
      if (res.ok) setSettings(await res.json());
    })();
  }, [authedFetch, canSet]);

  async function save(next: { visibleTo: 'everyone' | 'hr_only'; showManager: boolean }) {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch('/people/directory/settings', { method: 'PUT', body: JSON.stringify(next) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save.');
      setSettings(await res.json());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const showManagerColumn = (rows ?? []).some((r) => r.manager !== null) || settings?.showManager === true;

  return (
    <>
      <PageHeader title="Directory" subtitle="Who works here, and where" />
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      {canSet && settings && (
        <Card title="Who sees the directory" className="mb-5">
          <p className="mb-3 text-[0.8125rem] text-ink-muted">
            Colleagues see each person&apos;s name, designation, department, location and work email
            {settings.showManager ? ', and who they report to' : ''}. Employee IDs, status, joining and leaving
            dates and employment type are never shown here — so nobody learns from the directory that someone is
            leaving. People who have left are not listed.
          </p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Who can see it">
              {(p) => (
                <Select {...p} value={settings.visibleTo} disabled={busy}
                        onChange={(e) => void save({ ...settings, visibleTo: e.target.value as 'everyone' | 'hr_only' })}>
                  <option value="everyone">Everyone in the organisation</option>
                  <option value="hr_only">People HR only</option>
                </Select>
              )}
            </Field>
            <Switch id="dir-show-manager" className="mt-6" label="Show who each person reports to"
                    hint="In a small organisation this shows everyone the whole reporting structure."
                    checked={settings.showManager} disabled={busy}
                    onChange={(e) => void save({ ...settings, showManager: e.target.checked })} />
          </div>
        </Card>
      )}

      <Toolbar className="mb-4">
        <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the directory"
               placeholder="Search by name, designation, department or location" className="max-w-md" />
      </Toolbar>

      <Card padded={false}>
        {rows === null ? <Spinner /> : rows.length === 0 ? (
          <Empty title="Nobody to show" hint={me.isHr ? 'People appear here once they have an employee record.' : undefined}
                 action={me.isHr ? <Button href="/people/new">Add employee</Button> : undefined} />
        ) : (
          <Table head={['Name', 'Designation', 'Department', 'Location', ...(showManagerColumn ? ['Reports to'] : [])]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <div className="font-medium text-ink">{r.name}</div>
                  {r.workEmail && <a href={`mailto:${r.workEmail}`} className="text-xs text-ink-muted hover:underline">{r.workEmail}</a>}
                </Td>
                <Td>{r.designation ?? '—'}</Td>
                <Td>{r.department ?? '—'}</Td>
                <Td>{r.location ?? '—'}</Td>
                {showManagerColumn && <Td>{r.manager ?? '—'}</Td>}
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
