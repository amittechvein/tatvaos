'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { fetchOrganisationDeletions, removeDeletedFiles, type OrganisationDeletion } from '@/lib/adminData';

// ============================================================================
//  Organisations that were deleted: what went, who pressed it, when, and
//  what is still on the server. The organisation's own audit log went with
//  it, so this page is the only place the fact is written down.
// ============================================================================

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function DeletedOrganisations() {
  const { authedFetch } = useAuth();
  const [rows, setRows] = useState<OrganisationDeletion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchOrganisationDeletions(authedFetch).then(setRows).catch((e: Error) => setError(e.message));
  }, [authedFetch]);
  useEffect(() => { load(); }, [load]);

  async function removeFiles(id: string) {
    setBusy(id); setError(null);
    try { await removeDeletedFiles(authedFetch, id); load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The files could not be removed.'); }
    finally { setBusy(null); }
  }

  return (
    <AdminShell
      scope="platform"
      title="Deleted organisations"
      subtitle="What was removed, by whom, and what is still on the server"
      actions={
        <Link href="/admin/organisations">
          <Button variant="secondary">All organisations</Button>
        </Link>
      }
    >
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {!rows && !error && <Empty title="Loading…" />}
      {rows && rows.length === 0 && (
        <Card><Empty title="No organisation has been deleted" /></Card>
      )}
      {rows && rows.length > 0 && (
        <Card>
          <Table head={['Organisation', 'Deleted', 'What there was', 'Files', 'Mail on the server']}>
            {rows.map((r) => {
              const filesFailed = (r.filesRemoved?.errors?.length ?? 0) > 0 || !!r.filesRemoved?.error;
              const mailLeft = r.mailFolders.length > 0 && !r.mailFoldersRemovedAt;
              return (
                <tr key={r.id}>
                  <Td>
                    <p className="font-semibold text-ink">{r.name}</p>
                    <p className="text-[12px] text-ink-muted">{r.domains.join(', ') || 'No domains'}</p>
                    {r.reason && <p className="mt-1 text-[12px] text-ink-muted">&ldquo;{r.reason}&rdquo;</p>}
                  </Td>
                  <Td>
                    <p>{fmtWhen(r.deletedAt)}</p>
                    <p className="text-[12px] text-ink-muted">by {r.deletedBy}</p>
                  </Td>
                  <Td>
                    <p>{r.counts['core.users.tenant_id'] ?? 0} people · {r.counts['mail.mailboxes.tenant_id'] ?? 0} mail IDs</p>
                    <p className="text-[12px] text-ink-muted">
                      {(r.counts['mail.messages.tenant_id'] ?? 0).toLocaleString('en-IN')} messages ·{' '}
                      {r.counts['connect.meetings.tenant_id'] ?? 0} meetings
                    </p>
                  </Td>
                  <Td>
                    {r.filesRemovedAt && !filesFailed ? (
                      <Badge tone="ok">Removed</Badge>
                    ) : (
                      <div className="space-y-1">
                        <Badge tone="danger">{filesFailed ? 'Some could not be removed' : 'Not removed yet'}</Badge>
                        <div>
                          <Button size="sm" disabled={busy === r.id} onClick={() => removeFiles(r.id)}>
                            {busy === r.id ? 'Removing…' : 'Remove files'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </Td>
                  <Td>
                    {r.mailFolders.length === 0 && <span className="text-ink-muted">None</span>}
                    {mailLeft && (
                      <>
                        <Badge tone="warn">Still there</Badge>
                        <p className="mt-1 text-[12px] text-ink-muted">
                          {r.mailFolders.join(', ')} cannot be registered again until removed.
                        </p>
                      </>
                    )}
                    {r.mailFolders.length > 0 && r.mailFoldersRemovedAt && (
                      <>
                        <Badge tone="ok">Removed</Badge>
                        <p className="mt-1 text-[12px] text-ink-muted">{fmtWhen(r.mailFoldersRemovedAt)}</p>
                      </>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        </Card>
      )}
      <p className="mt-6 text-[12px] text-ink-muted">
        Numbers and names of things only. No person&rsquo;s address and no mail is kept here.
      </p>
    </AdminShell>
  );
}
