'use client';

// The three history rails are one component with three row actions — see the
// header of History.tsx for why they are not three screens.
import History from '../History';

export default function RecordingsPage() {
  return <History mode="recordings" />;
}
