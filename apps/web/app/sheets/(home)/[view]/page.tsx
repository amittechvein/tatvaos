'use client';

import { use } from 'react';
import { notFound } from 'next/navigation';
import { SheetsHome } from '@/components/sheets/SheetsHome';
import type { SheetsView } from '@/lib/sheets/api';

const VIEWS: SheetsView[] = ['owned', 'shared', 'starred', 'trash'];

export default function SheetsViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = use(params);
  if (!VIEWS.includes(view as SheetsView)) notFound();
  return <SheetsHome view={view as SheetsView} />;
}
