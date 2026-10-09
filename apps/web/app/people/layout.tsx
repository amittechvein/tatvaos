'use client';

import { RequireAuth } from '@/components/RequireAuth';
import { AppShell } from '@/components/shell/AppShell';
import { Spinner } from '@/components/ui/Kit';
import { Alert, PageHeader } from '@/components/ui/Page';
import { peopleNav } from '@/lib/nav';
import { PeopleAccessProvider } from './PeopleAccess';

/**
 * TatvaOS People (decision 0018), inside the same shell as every product.
 *
 * Open to People HR, to anyone with an employee record (themselves and their
 * team), and to administrators — who see no records until they name
 * themselves People HR (Amit, 9 Oct 2026). Not in the launcher: People is
 * not available to customers yet.
 */
export default function PeopleLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <PeopleAccessProvider
        loading={<Spinner />}
        denied={
          <AppShell scope="people" brand="TatvaOS" sections={[]}>
            <PageHeader title="People" />
            <Alert tone="info" title="Nothing here for you yet">
              People shows employee records to your organisation&apos;s People HR, and to each person
              their own record and their team&apos;s. You have no employee record here yet.
            </Alert>
          </AppShell>
        }
      >
        {(me) => (
          <AppShell scope="people" brand="TatvaOS"
                    sections={peopleNav({ isHr: me.isHr, showHrList: me.isHr || me.canNameHr })}>
            {children}
          </AppShell>
        )}
      </PeopleAccessProvider>
    </RequireAuth>
  );
}
