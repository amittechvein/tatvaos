'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Input } from '@/components/ui/Form';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { useHireAccess } from '../HireAccess';
import { SOURCE_LABEL } from './_components/CandidateForm';

// ============================================================================
//  Candidates — everyone this person may see (TatvaOS Hire R1, 24 Sept 2026)
//
//  A hiring manager's list holds only people who applied to THEIR jobs, and
//  the counts are of those applications only; the API decides, this page just
//  says so under the title.
// ============================================================================

interface Row {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  currentCompany: string | null;
  currentDesignation: string | null;
  source: string;
  tags: string[];
  applications: number;
  active: number;
}

export default function CandidatesPage() {
  const { authedFetch } = useAuth();
  const me = useHireAccess();
  const canAdd = me.access === 'admin' || me.access === 'recruiter';

  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authedFetch(`/hire/candidates${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
    if (!res.ok) { setError('Could not load candidates.'); setRows([]); return; }
    setRows(await res.json());
  }, [authedFetch, q]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <>
      <PageHeader
        title="Candidates"
        subtitle={me.canSeeAllJobs ? 'Everyone your organisation is recruiting' : 'People who applied to jobs you manage'}
        actions={canAdd ? <Button variant="primary" href="/hire/candidates/new">Add candidate</Button> : undefined}
      />
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <div className="mb-4 max-w-sm">
        <Input type="search" placeholder="Search name, email, phone or company" value={q}
               onChange={(e) => setQ(e.target.value)} aria-label="Search candidates" />
      </div>

      <Card padded={false}>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          q ? <Empty title="Nobody matches that search" /> : (
            <Empty
              title="No candidates yet"
              hint={canAdd ? 'Add someone, then put them forward for an open job.' : 'Candidates appear here when they apply to a job you manage.'}
              action={canAdd ? <Button variant="primary" href="/hire/candidates/new">Add the first one</Button> : undefined}
            />
          )
        ) : (
          <Table head={['Name', 'Contact', 'Now', 'Source', 'Applications']}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link href={`/hire/candidates/${r.id}`} className="font-medium text-ink hover:underline">{r.fullName}</Link>
                  {r.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">{r.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>
                  )}
                </Td>
                <Td><span className="break-all">{r.email ?? r.phone}</span></Td>
                <Td>{[r.currentDesignation, r.currentCompany].filter(Boolean).join(', ') || '—'}</Td>
                <Td>{SOURCE_LABEL[r.source] ?? r.source}</Td>
                <Td>{r.applications === 0 ? '—' : `${r.active} active of ${r.applications}`}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
