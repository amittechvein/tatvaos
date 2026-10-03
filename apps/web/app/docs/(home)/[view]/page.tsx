'use client';

import { use } from 'react';
import { notFound } from 'next/navigation';
import { DocsHome } from '@/components/docs/DocsHome';
import type { DocsView } from '@/lib/docs';

const VIEWS: DocsView[] = ['owned', 'shared', 'starred', 'trash'];

export default function DocsViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = use(params);
  if (!VIEWS.includes(view as DocsView)) notFound();
  return <DocsHome view={view as DocsView} />;
}
