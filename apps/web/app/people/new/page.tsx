'use client';

import { useRouter } from 'next/navigation';

import { Alert, PageHeader } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { bodyFrom, EmployeeForm } from '../_components/EmployeeForm';
import { usePeopleAccess } from '../PeopleAccess';

export default function NewEmployeePage() {
  const { authedFetch } = useAuth();
  const { me } = usePeopleAccess();
  const router = useRouter();

  if (!me.isHr)
    return (
      <>
        <PageHeader title="Add employee" breadcrumb={[{ label: 'People', href: '/people' }, { label: 'Add employee' }]} />
        <Alert tone="info">Only People HR can add employees.</Alert>
      </>
    );

  return (
    <>
      <PageHeader title="Add employee" breadcrumb={[{ label: 'People', href: '/people' }, { label: 'Add employee' }]} />
      <EmployeeForm
        submitLabel="Add employee"
        onSubmit={async (d, manualCodes) => {
          const res = await authedFetch('/people/employees', { method: 'POST', body: JSON.stringify(bodyFrom(d, manualCodes)) });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) return body.error ?? 'Could not add this person.';
          router.push(`/people/${body.id}`);
          return null;
        }}
      />
    </>
  );
}
