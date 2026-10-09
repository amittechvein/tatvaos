'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Field, Modal } from '@/components/ui/Modal';
import { Select, Textarea } from '@/components/ui/Form';
import { Alert, PageHeader, Toolbar } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { usePeopleAccess } from '../PeopleAccess';
import { FIELD_LABEL } from '../_components/fields';

interface Correction {
  id: string;
  employeeId: string;
  employeeName: string | null;
  field: string;
  requested: string;
  status: 'open' | 'done' | 'declined';
  response: string | null;
  createdAt: string;
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

// ============================================================================
//  Correction requests — People HR answers employees' requests.
//
//  "Mark done" records the answer only: HR makes the change itself through
//  the employee's Edit page, which keeps every rule (no loops, the reporting
//  audit) in force. A decline needs the reason the employee will read; the API
//  and the database both refuse one without it.
// ============================================================================
export default function CorrectionsPage() {
  const { authedFetch } = useAuth();
  const { me } = usePeopleAccess();
  const [rows, setRows] = useState<Correction[] | null>(null);
  const [status, setStatus] = useState('open');
  const [answering, setAnswering] = useState<{ c: Correction; outcome: 'done' | 'declined' } | null>(null);
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authedFetch(`/people/corrections${status ? `?status=${status}` : ''}`);
    if (!res.ok) { setError('Could not load correction requests.'); setRows([]); return; }
    setRows(await res.json());
  }, [authedFetch, status]);

  useEffect(() => { void load(); }, [load]);

  async function answer() {
    if (!answering) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch(`/people/corrections/${answering.c.id}/resolve`, {
        method: 'POST', body: JSON.stringify({ outcome: answering.outcome, response: response.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save the answer.');
      setAnswering(null);
      setResponse('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the answer.');
    } finally {
      setBusy(false);
    }
  }

  if (!me.isHr)
    return (
      <>
        <PageHeader title="Correction requests" />
        <Alert tone="info">Only People HR can see and answer correction requests.</Alert>
      </>
    );

  return (
    <>
      <PageHeader title="Correction requests" subtitle="Employees asking for their record to be fixed" />
      {error && !answering && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      <Alert tone="info">
        Make the change on the person&apos;s record first (open their name, then Edit), then mark the request done.
        If you decline, say why — they will read it.
      </Alert>
      <Toolbar className="mb-4">
        <Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[14rem]">
          <option value="open">Waiting for an answer</option>
          <option value="done">Done</option>
          <option value="declined">Declined</option>
          <option value="">All</option>
        </Select>
      </Toolbar>
      <Card padded={false}>
        {rows === null ? <Spinner /> : rows.length === 0 ? (
          <Empty title={status === 'open' ? 'Nothing waiting' : 'Nothing here'} />
        ) : (
          <Table head={['Sent', 'Who', 'About', 'What they asked', '']}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td>{fmt(c.createdAt)}</Td>
                <Td><Link href={`/people/${c.employeeId}`} className="font-medium text-ink hover:underline">{c.employeeName ?? 'Someone'}</Link></Td>
                <Td>{FIELD_LABEL[c.field] ?? c.field}</Td>
                <Td className="whitespace-pre-wrap">
                  {c.requested}
                  {c.response && <div className="mt-1 text-xs text-ink-muted">Answer: {c.response}</div>}
                </Td>
                <Td className="text-right">
                  {c.status === 'open' ? (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => setAnswering({ c, outcome: 'declined' })}>Decline</Button>
                      <Button size="sm" variant="primary" onClick={() => setAnswering({ c, outcome: 'done' })}>Mark done</Button>
                    </div>
                  ) : (
                    <Badge tone={c.status === 'done' ? 'ok' : 'neutral'}>{c.status === 'done' ? 'Done' : 'Declined'}</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {answering && (
        <Modal title={answering.outcome === 'done' ? 'Mark this request done' : 'Decline this request'}
               onClose={() => setAnswering(null)} busy={busy}
               footer={<>
                 <Button variant="ghost" onClick={() => setAnswering(null)} disabled={busy}>Cancel</Button>
                 <Button variant={answering.outcome === 'done' ? 'primary' : 'danger'} onClick={() => void answer()}
                         disabled={busy || (answering.outcome === 'declined' && !response.trim())}>
                   {answering.outcome === 'done' ? 'Mark done' : 'Decline'}
                 </Button>
               </>}>
          {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
          <p className="mb-3 text-[0.8125rem] text-ink-muted">
            {answering.c.employeeName}: {FIELD_LABEL[answering.c.field] ?? answering.c.field} — “{answering.c.requested}”
          </p>
          <Field label={answering.outcome === 'done' ? 'A note for them (optional)' : 'Why (they will read this)'}
                 required={answering.outcome === 'declined'}>
            <Textarea aria-label="Answer" value={response} onChange={(e) => setResponse(e.target.value)} maxLength={500} rows={3} />
          </Field>
        </Modal>
      )}
    </>
  );
}
