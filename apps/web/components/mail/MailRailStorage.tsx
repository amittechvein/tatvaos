'use client';

import { useEffect, useState } from 'react';
import { formatBytes, quotaPercent } from '@tatvaos/core';
import { useAuth } from '@/lib/auth';
import { mailApi } from '@/lib/mail';

/**
 * The mailbox quota, pinned to the bottom of the Mail rail.
 *
 * It fetches its own copy of the bootstrap rather than receiving props: the
 * rail is rendered by the shell in the layout, which sits ABOVE the page that
 * loads the mailbox, so there is no prop path down to it. The call is cheap and
 * already cached by the browser from the page's own bootstrap request.
 *
 * Renders nothing at all until the figure is known, and nothing ever for an
 * account with no mail product — an empty meter reading "0 B of 0 B" would look
 * like a broken mailbox rather than an absent one.
 */
export function MailRailStorage() {
  const { authedFetch } = useAuth();
  const [box, setBox] = useState<{ used: number; quota: number } | null>(null);

  useEffect(() => {
    let alive = true;
    mailApi
      .bootstrap(authedFetch)
      .then((b) => {
        if (alive && b.mailbox) setBox({ used: b.mailbox.usedBytes, quota: b.mailbox.quotaBytes });
      })
      .catch(() => {
        /* The rail must render with or without a quota figure. */
      });
    return () => {
      alive = false;
    };
  }, [authedFetch]);

  if (!box) return null;
  const pct = quotaPercent(box.used, box.quota);

  return (
    <div>
      <div className="d-flex justify-content-between" style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>
        <span>Storage</span>
        <span>{pct}%</span>
      </div>
      <div style={{ height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, pct)}%`,
            borderRadius: 999,
            background: pct > 90 ? '#fd4963' : pct > 75 ? '#ffa909' : '#03b562',
            transition: 'width 200ms ease',
          }}
        />
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
        {formatBytes(box.used)} of {formatBytes(box.quota)}
      </div>
    </div>
  );
}
