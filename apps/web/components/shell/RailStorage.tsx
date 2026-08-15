'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

/**
 * The organisation's storage, pinned to the bottom of a rail — Drive's
 * cloud-pill meter. One shared component so every product's rail shows the
 * same figure the storage console manages.
 *
 * /org/storage is admin-gated, so for most employees the call 403s and the
 * meter simply does not render — an employee's rail loses nothing they could
 * act on, and rendering a broken meter would read as a fault. (Mail's rail
 * shows the personal mailbox meter instead, which everyone may know.)
 */
export function RailStorage() {
  const { authedFetch } = useAuth();
  const [s, setS] = useState<{ used: number; total: number } | null>(null);

  useEffect(() => {
    let alive = true;
    authedFetch('/org/storage')
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { usedBytes: number; totalBytes: number } | null) => {
        if (alive && b) setS({ used: b.usedBytes, total: b.totalBytes });
      })
      .catch(() => { /* the rail renders with or without the meter */ });
    return () => { alive = false; };
  }, [authedFetch]);

  if (!s || s.total <= 0) return null;
  const pct = Math.min(100, (s.used / s.total) * 100);

  const gb = (n: number) => n >= 1024 ** 4
    ? `${(n / 1024 ** 4).toFixed(2)} TB`
    : `${(n / 1024 ** 3).toFixed(2)} GB`;

  return (
    <div>
      <div className="d-inline-flex align-items-center gap-2 rounded-pill"
           style={{ background: 'rgba(255,255,255,0.10)', padding: '4px 14px 4px 10px', marginBottom: 8 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}>
          <path d="M17.5 19H7a5 5 0 1 1 .9-9.92A6 6 0 0 1 19.6 11a4 4 0 0 1-2.1 8z" />
        </svg>
        <span style={{ fontSize: 12, opacity: 0.9 }}>Storage</span>
      </div>
      <div style={{ height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 999,
          background: pct > 90 ? '#fd4963' : pct > 75 ? '#ffa909' : '#4285f4',
          transition: 'width 200ms ease',
        }} />
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
        {gb(s.used)} of {gb(s.total)} used
      </div>
    </div>
  );
}
