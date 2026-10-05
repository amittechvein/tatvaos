'use client';

import { use } from 'react';
import { notFound } from 'next/navigation';
import { RequireAuth } from '@/components/RequireAuth';
import { SheetEditor } from '@/components/sheets/SheetEditor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function SpreadsheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  if (!UUID.test(id)) notFound();
  return (
    <RequireAuth>
      <SheetEditor id={id} />
    </RequireAuth>
  );
}
