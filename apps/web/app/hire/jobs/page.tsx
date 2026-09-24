'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Input } from '@/components/ui/Form';
import { Alert, PageHeader, Tabs } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { EMPLOYMENT_LABEL } from './_components/JobForm';
import { fmtDate, StatusBadge, type JobStatus } from './_components/JobStatus';

// ============================================================================
//  Job openings — the recruiter's list (TatvaOS Hire R1, 24 Sept 2026)
//
//  Tabs by status with counts, newest change first. The status is in the URL
//  (?status=open) so a tab can be bookmarked and Back works.
// ============================================================================

interface Row {
  id: string;
  title: string;
  status: JobStatus;
  closedReason: 'filled' | 'cancelled' | null;
  employmentType: string;
  vacancies: number;
  location: string | null;
  department: string | null;
  designation: string | null;
  hiringManager: string | null;
  closingDate: string | null;
  updatedAt: string;
}

function JobsList() {
  const { authedFetch } = useAuth();
  const params = useSearchParams();
  const status = params.get('status') ?? 'open';

  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<JobStatus, number> | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status });
      if (q.trim()) qs.set('q', q.trim());
      const res = await authedFetch(`/hire/jobs?${qs}`);
      if (!res.ok) throw new Error('Could not load job openings.');
      const body = await res.json();
      setRows(body.jobs ?? []);
      setCounts(body.counts ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load job openings.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch, status, q]);

  // Typing in the search box waits for a pause rather than asking per key.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const tab = (s: string, label: string, count?: number) =>
    ({ href: `/hire/jobs?status=${s}`, label, count });

  return (
    <>
      <PageHeader
        title="Job openings"
        subtitle="Positions you are recruiting for"
        actions={<Button variant="primary" href="/hire/jobs/new">New job opening</Button>}
      />

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <Tabs
        current={`/hire/jobs?status=${status}`}
        items={[
          tab('open', 'Open', counts?.open),
          tab('draft', 'Drafts', counts?.draft),
          tab('on_hold', 'On hold', counts?.on_hold),
          tab('closed', 'Closed', counts?.closed),
          tab('all', 'All', counts ? total : undefined),
        ]}
      />

      <div className="mb-4 max-w-sm">
        <Input type="search" placeholder="Search by title" value={q}
               onChange={(e) => setQ(e.target.value)} aria-label="Search job openings by title" />
      </div>

      <Card padded={false}>
        {loading && rows.length === 0 ? (
          <Spinner />
        ) : rows.length === 0 ? (
          total === 0 && !q ? (
            <Empty
              title="No job openings yet"
              hint="Create one as a draft, fill it in, and publish it when it is ready."
              action={<Button variant="primary" href="/hire/jobs/new">Create the first one</Button>}
            />
          ) : (
            <Empty title={q ? 'Nothing matches that search' : 'Nothing here'}
                   hint={q ? undefined : 'Try another tab.'} />
          )
        ) : (
          <Table head={['Title', 'Location', 'Type', 'Vacancies', 'Closes', 'Status']}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link href={`/hire/jobs/${r.id}`} className="font-medium text-ink hover:underline">
                    {r.title}
                  </Link>
                  {(r.designation || r.department) && (
                    <div className="text-xs text-ink-muted">
                      {[r.designation, r.department].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </Td>
                <Td>{r.location ?? '—'}</Td>
                <Td>{EMPLOYMENT_LABEL[r.employmentType] ?? r.employmentType}</Td>
                <Td>{r.vacancies}</Td>
                <Td>{fmtDate(r.closingDate)}</Td>
                <Td><StatusBadge status={r.status} reason={r.closedReason} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

export default function JobsPage() {
  // useSearchParams needs a Suspense boundary above it in the App Router,
  // or the production build refuses to prerender the page.
  return (
    <Suspense fallback={<Spinner />}>
      <JobsList />
    </Suspense>
  );
}
