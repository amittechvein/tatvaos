'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { useHireAccess } from '../../HireAccess';
import { CandidateForm } from '../_components/CandidateForm';

export default function NewCandidatePage() {
  const { authedFetch } = useAuth();
  const me = useHireAccess();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the email already belongs to a candidate this person may see:
  // the useful answer is "here they are", not just "no".
  const [existingId, setExistingId] = useState<string | null>(null);

  if (me.access === 'hiring_manager') {
    return (
      <>
        <PageHeader title="Add candidate" breadcrumb={[{ label: 'Candidates', href: '/hire/candidates' }, { label: 'New' }]} />
        <Alert tone="info">Recruiters and administrators add candidates. Ask one to put someone forward for your job.</Alert>
      </>
    );
  }

  async function create(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setExistingId(null);
    try {
      const res = await authedFetch('/hire/candidates', { method: 'POST', body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.existingId) setExistingId(body.existingId);
        throw new Error(body.error ?? 'Could not save.');
      }
      router.push(`/hire/candidates/${body.id}?created=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Add candidate" breadcrumb={[{ label: 'Candidates', href: '/hire/candidates' }, { label: 'New' }]} />
      {existingId && (
        <Alert tone="info">
          <Link href={`/hire/candidates/${existingId}`} className="font-medium underline">Open the existing profile</Link>
          {' '}and add the new job from there.
        </Alert>
      )}
      <CandidateForm candidate={null} submitLabel="Add candidate" busy={busy} error={error}
                     onSubmit={(p) => void create(p)} onCancel={() => router.push('/hire/candidates')} />
    </>
  );
}
