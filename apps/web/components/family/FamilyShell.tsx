'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { AppShell } from '@/components/shell/AppShell';
import { familyNav } from '@/lib/nav';
import { useAuth } from '@/lib/auth';
import { familyApi, type ContactGroup } from '@/lib/family';

/**
 * The chrome every Family screen sits in.
 *
 * It exists because the sidebar is not static: the Contacts item carries a
 * count and the Labels section is one entry per group. Both come from
 * /family/bootstrap, and fetching that separately on each page would mean the
 * rail flickering its own contents on every navigation.
 *
 * The refresh callback is exposed through context so a page that creates or
 * deletes something can correct the count without a full reload — a sidebar
 * that says 50 after you have deleted one is the kind of small wrongness
 * people stop trusting the whole screen over.
 */
interface FamilyChrome {
  total: number;
  labels: ContactGroup[];
  refresh: () => void;
}

const ChromeContext = createContext<FamilyChrome>({ total: 0, labels: [], refresh: () => {} });

export const useFamilyChrome = () => useContext(ChromeContext);

export function FamilyShell({ title, breadcrumb, actions, children }: {
  title: string;
  breadcrumb?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { authedFetch } = useAuth();
  const [total, setTotal] = useState(0);
  const [labels, setLabels] = useState<ContactGroup[]>([]);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    familyApi.bootstrap(authedFetch)
      .then((b) => { if (live) { setTotal(b.counts.total); setLabels(b.groups); } })
      // The rail is decoration for the page's own data. A failure here must not
      // stop the screen rendering — it just means no count and no label list.
      .catch(() => undefined);
    return () => { live = false; };
  }, [authedFetch, tick]);

  return (
    <ChromeContext.Provider value={{ total, labels, refresh }}>
      <AppShell
        scope="family"
        brand="TatvaOS Family"
        sections={familyNav({ total, labels })}
        title={title}
        breadcrumb={[{ label: 'Family' }, ...(breadcrumb ? [{ label: breadcrumb }] : [])]}
        actions={actions}
      >
        {children}
      </AppShell>
    </ChromeContext.Provider>
  );
}
