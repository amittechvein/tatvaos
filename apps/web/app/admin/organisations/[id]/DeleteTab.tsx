'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Button, Card, Empty, Stat, Table, Td } from '@/components/ui/Kit';
import { Input, Textarea } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import { deleteOrganisation, fetchDeletionPreview, type DeletionPreview } from '@/lib/adminData';

// ============================================================================
//  Deleting an organisation for good (Amit, 29 Sept 2026).
//
//  The screen's one job is that nobody deletes by accident or by surprise:
//    * it says what stands in the way, in the database's own words, and
//      offers no button while anything does
//    * it says what will go, in numbers, before anything is asked
//    * it says what will NOT go — mail files on the server, and backups —
//      because "deleted" that quietly leaves things behind is a promise
//      somebody will repeat to a customer
//    * the name is typed, not ticked
//
//  Numbers only. No address, name or subject of anybody's is shown here.
// ============================================================================

export function DeleteTab({ orgId }: { orgId: string }) {
  const { authedFetch } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<DeletionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [showTables, setShowTables] = useState(false);

  const load = useCallback(() => {
    fetchDeletionPreview(authedFetch, orgId).then(setData).catch((e: Error) => setError(e.message));
  }, [authedFetch, orgId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <Alert tone="danger">{error}</Alert> : <Card><Empty title="Loading…" /></Card>;

  const c = data.counts;
  const matches = typed.trim() === data.org.name.trim();

  async function confirm() {
    if (!data || !matches) return;
    setBusy(true); setRefused(null);
    try {
      await deleteOrganisation(authedFetch, orgId, typed, reason);
      router.replace('/admin/organisations/deleted');
    } catch (e) {
      // Whatever the reason, the numbers may have moved: read them again.
      setRefused(e instanceof Error ? e.message : 'The organisation was not deleted.');
      setBusy(false);
      load();
    }
  }

  return (
    <div className="space-y-5">
      {data.blockers.length > 0 ? (
        <Alert tone="warn">
          <p className="font-semibold">This organisation cannot be deleted yet.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {data.blockers.map((b) => <li key={b.code}>{b.reason}</li>)}
          </ul>
        </Alert>
      ) : (
        <Alert tone="danger">
          <p className="font-semibold">Deleting is permanent.</p>
          <p className="mt-1">
            Everything below is removed at once and cannot be brought back from this console.
            If there is any chance it is wanted, leave the organisation suspended instead.
          </p>
        </Alert>
      )}

      <Card title="What will be removed">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="People" value={c.people.toLocaleString('en-IN')} />
          <Stat label="Mail IDs" value={c.mailboxes.toLocaleString('en-IN')} />
          <Stat label="Mail messages" value={c.messages.toLocaleString('en-IN')} />
          <Stat label="Domains" value={c.domains.toLocaleString('en-IN')} />
          <Stat label="Meetings" value={c.meetings.toLocaleString('en-IN')} />
          <Stat label="Recordings" value={c.recordings.toLocaleString('en-IN')} />
          <Stat label="Space files" value={c.files.toLocaleString('en-IN')} />
          <Stat label="Documents" value={c.documents.toLocaleString('en-IN')} />
        </div>
        <p className="mt-4 text-[13px] text-ink-muted">
          {c.rowsInAll.toLocaleString('en-IN')} records in all, including settings, sign-in sessions
          and this organisation&rsquo;s own audit log.{' '}
          <button type="button" className="font-medium text-brand-700 hover:underline"
                  aria-expanded={showTables} onClick={() => setShowTables((v) => !v)}>
            {showTables ? 'Hide the full list' : 'Show the full list'}
          </button>
        </p>
        {showTables && (
          <div className="mt-3">
            <Table head={['Where', 'Records']}>
              {Object.entries(data.tables).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => (
                <tr key={k}>
                  <Td><span className="font-mono text-[12px]">{k}</span></Td>
                  <Td>{n.toLocaleString('en-IN')}</Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
        {data.domains.length > 0 && (
          <p className="mt-4 text-[13px] text-ink">
            <span className="text-ink-muted">Domains: </span>{data.domains.join(', ')}
          </p>
        )}
      </Card>

      <Card title="What will not be removed">
        <ul className="list-disc space-y-2 pl-5 text-[13px] text-ink">
          {!data.mailStoreSeen && data.mailFolders.length > 0 ? (
            <li>
              <span className="font-semibold">Mail files on the server, if there are any.</span> The
              mail store could not be looked at just now, so {data.mailFolders.join(', ')} will be
              treated as still having mail there: {data.mailFolders.length === 1 ? 'it' : 'they'} cannot
              be registered again until someone has checked on the server.
            </li>
          ) : data.mailFolders.length > 0 ? (
            <li>
              <span className="font-semibold">Mail files on the server</span> for {data.mailFolders.join(', ')}.
              Nobody will be able to open them, and {data.mailFolders.length === 1 ? 'that domain' : 'those domains'} cannot
              be registered again until the files have been removed on the server.
            </li>
          ) : (
            <li>There are no mail files on the server for this organisation.</li>
          )}
          <li>
            <span className="font-semibold">Backups.</span> The organisation stays inside the encrypted
            backups already taken, until those backups expire.
          </li>
          <li>
            <span className="font-semibold">A record that it was deleted</span>: its name, its domains,
            how much there was, who deleted it and when. No person&rsquo;s address and no mail.
          </li>
        </ul>
      </Card>

      <div>
        <Button variant="danger" disabled={!data.canDelete}
                onClick={() => { setTyped(''); setReason(''); setRefused(null); setAsking(true); }}>
          Delete this organisation…
        </Button>
        {!data.canDelete && (
          <p className="mt-2 text-[12px] text-ink-muted">
            The button opens once nothing above stands in the way.
          </p>
        )}
      </div>

      {asking && (
        <Modal
          title={`Delete ${data.org.name}?`}
          subtitle="This cannot be undone."
          busy={busy}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setAsking(false)}>Keep it</Button>
              <Button variant="danger" disabled={!matches || busy} onClick={confirm}>
                {busy ? 'Deleting…' : 'Delete for good'}
              </Button>
            </>
          }
        >
          <div className="space-y-4 text-[13px]">
            {refused && <Alert tone="danger">{refused}</Alert>}
            <p>
              {c.people} {c.people === 1 ? 'person' : 'people'}, {c.mailboxes} mail{' '}
              {c.mailboxes === 1 ? 'ID' : 'IDs'}, {c.messages.toLocaleString('en-IN')} mail{' '}
              {c.messages === 1 ? 'message' : 'messages'} and everything else this organisation
              holds will be removed.
            </p>
            <div>
              <label htmlFor="tv-delete-name" className="mb-1 block font-medium text-ink">
                Type the organisation&rsquo;s name to confirm
              </label>
              <p className="mb-2 select-all font-mono text-[12px] text-ink-muted">{data.org.name}</p>
              <Input id="tv-delete-name" value={typed} autoComplete="off" spellCheck={false}
                     onChange={(e) => setTyped(e.target.value)} disabled={busy} />
            </div>
            <div>
              <label htmlFor="tv-delete-reason" className="mb-1 block font-medium text-ink">
                Why (kept on the record)
              </label>
              <Textarea id="tv-delete-reason" rows={2} value={reason} maxLength={500}
                        onChange={(e) => setReason(e.target.value)} disabled={busy} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
