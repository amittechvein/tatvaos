'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { fetchMyStorage, formatBytes, meterColour, type MyStorage } from '@/lib/myStorage';

/**
 * The person's storage, pinned under the nav in every product's rail.
 *
 * ONE meter, ONE number, everywhere. It used to differ per product — Mail
 * showed the mailbox quota, Space showed the organisation's pool — so a
 * customer sold "30 GB" could find neither figure and reasonably concluded
 * one of them was wrong. This reads the account total: mail, files, and
 * whatever ships next, against the single allowance.
 *
 * The whole block links to the account page, where the same number is broken
 * down by product — because the question after "I am nearly full" is always
 * "full of what".
 */
export function RailStorage() {
  const { authedFetch } = useAuth();
  const [s, setS] = useState<MyStorage | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyStorage(authedFetch)
      .then((v) => { if (alive) setS(v); })
      .catch(() => { /* the rail renders with or without the meter */ });
    return () => { alive = false; };
  }, [authedFetch]);

  if (!s || s.quotaBytes <= 0) return null;
  const pct = Math.min(100, s.usedFraction * 100);

  return (
    // Same lesson as MailboxSwitcher: this used white-alpha backgrounds and an
    // inherited colour, which vanish on a light rail. Tokens flip with the
    // theme; white does not.
    <Link href="/account" className="block text-rail-text no-underline"
          title="See what is using your space">
      <div className="inline-flex items-center gap-2 rounded-full bg-rail-soft"
           style={{ padding: '4px 14px 4px 10px', marginBottom: 8 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.85 }}>
          <path d="M17.5 19H7a5 5 0 1 1 .9-9.92A6 6 0 0 1 19.6 11a4 4 0 0 1-2.1 8z" />
        </svg>
        <span style={{ fontSize: 12, opacity: 0.9 }}>Storage</span>
      </div>

      <div style={{ height: 4, borderRadius: 999, background: 'rgb(var(--line))', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 999,
          background: meterColour(s.usedFraction), transition: 'width 200ms ease',
        }} />
      </div>

      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>
        {formatBytes(s.usedBytes)} of {formatBytes(s.quotaBytes)} used
      </div>

      {/* Said only when it matters. A warning on every screen every day is
          furniture; a warning at 80% is information. */}
      {s.isCritical && (
        <div className="text-danger" style={{ fontSize: 11, marginTop: 4 }}>
          Almost full — new mail and uploads will be refused.
        </div>
      )}
    </Link>
  );
}
