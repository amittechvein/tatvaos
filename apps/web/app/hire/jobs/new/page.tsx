'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Spinner } from '@/components/ui/Kit';
import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { JobForm, type JobOptions } from '../_components/JobForm';

// A new job is always saved as a DRAFT. Publishing is a separate, deliberate
// step on the job's own page, where the checks for "fit to be seen" run.
export default function NewJobPage() {
  const { authedFetch } = useAuth();
  const router = useRouter();
  const [options, setOptions] = useState<JobOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await authedFetch('/hire/jobs/options');
      if (res.ok) setOptions(await res.json());
      else setError('Could not load the form. Reload the page to try again.');
    })();
  }, [authedFetch]);

  async function create(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch('/hire/jobs', { method: 'POST', body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      router.push(`/hire/jobs/${body.id}?created=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="New job opening"
        subtitle="Saved as a draft. Nobody outside your organisation sees it until you publish."
        breadcrumb={[{ label: 'Job openings', href: '/hire/jobs' }, { label: 'New' }]}
      />
      {!options ? (
        error ? <Alert tone="danger">{error}</Alert> : <Spinner />
      ) : (
        <JobForm job={null} options={options} submitLabel="Save draft" busy={busy} error={error}
                 onSubmit={(p) => void create(p)} onCancel={() => router.push('/hire/jobs')} />
      )}
    </>
  );
}
