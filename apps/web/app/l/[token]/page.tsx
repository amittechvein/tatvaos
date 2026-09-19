'use client';

import { use, useEffect, useState } from 'react';
import { fetchLinkInfo, formatSize } from '@/lib/space';
import { formatDate } from '@/lib/dates';
import { Spinner } from '@/components/ui/Kit';
import { BrandMark } from '@/components/ui/Brand';

// ============================================================================
//  The public link landing page — space.tatvaos.com/l/{token}
// ============================================================================
//
//  A DOORSTEP, NOT A DOOR. The person opening this has no account: they were
//  emailed a large attachment as a link. So there is no shell, no rail, no
//  session check, no navigation into Space — a sign-in wall here is exactly
//  the failure this feature exists to remove.
//
//  It is a page rather than a bare redirect to the bytes for two reasons: a
//  person clicking an email link deserves to see WHAT they are about to
//  download and WHO sent it before their browser saves 40 MB — that is the
//  difference between a link that looks legitimate and one that behaves like
//  malware. And when the link is dead, a page can say so kindly, where a raw
//  404 says "broken website".
//
//  One message for every dead link — expired, revoked, deleted, never
//  existed. The API refuses to distinguish them (no oracle) and so does this
//  page.
// ============================================================================

interface LinkInfo {
  name: string;
  sizeBytes: number;
  sharedBy: string | null;
  expiresAt: string;
}

export default function PublicLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [info, setInfo] = useState<LinkInfo | null | 'loading'>('loading');

  useEffect(() => {
    let alive = true;
    void fetchLinkInfo(token).then((i) => { if (alive) setInfo(i); });
    return () => { alive = false; };
  }, [token]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-8 text-center shadow-raised">
        <BrandMark product="space" alt="TatvaOS Space" className="mx-auto mb-4 h-12 w-12" />

        {info === 'loading' ? (
          <Spinner />
        ) : info === null ? (
          <>
            <h1 className="mb-2 text-lg font-semibold text-ink">This link no longer works</h1>
            <p className="text-sm text-ink-muted">
              It may have expired or been turned off by the person who shared it.
              Ask them to send a new one.
            </p>
          </>
        ) : (
          <>
            <h1 className="mb-1 break-words text-lg font-semibold text-ink">{info.name}</h1>
            <p className="mb-1 text-sm text-ink-muted">{formatSize(info.sizeBytes)}</p>
            {info.sharedBy && (
              <p className="mb-4 text-xs text-ink-faint">Shared by {info.sharedBy} via TatvaOS Space</p>
            )}

            {/* A plain anchor, not fetch-and-blob: the browser downloads a
                40 MB file with its own progress UI and resume handling, which
                a blob URL forfeits. The server forces
                Content-Disposition: attachment, so this can never render. */}
            <a
              href={`/api/space/l/${encodeURIComponent(token)}`}
              className="inline-block rounded-full bg-brand-600 px-8 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
            >
              Download
            </a>

            <p className="mt-4 text-[11px] text-ink-faint">
              Link expires {formatDate(info.expiresAt)}.
              Only download files from people you trust.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
