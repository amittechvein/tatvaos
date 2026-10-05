'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Alert } from '@/components/ui/Page';
import { Spinner } from '@/components/ui/Kit';
import { recordingApi, sharedLinkApi, type RecordingViewing } from '@/lib/connect';
import { RecordingViewer } from '../Viewer';

// ============================================================================
//  /connect/recordings/{id} — a recording opened by its own address.
// ============================================================================
//
//  The address an organisation or named share is copied and emailed as. It
//  sits inside the shell, so RequireAuth sends a signed-out visitor to sign
//  in and back here afterwards — which is the whole of what makes an emailed
//  link safe to forward: it opens only for the account it was shared with.
//
//  The server decides, in order: were you in the meeting; does a share cover
//  you; otherwise the same "does not exist" as a recording that never did.
// ============================================================================

export default function RecordingPage({ params }: { params: Promise<{ recordingId: string }> }) {
  const { recordingId } = use(params);
  const { authedFetch } = useAuth();

  const [viewing, setViewing] = useState<RecordingViewing | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The ticket the player is currently holding. A share reader renews by
  // trading it in — asking /view again would log a second opening every five
  // minutes of a film.
  const ticket = useRef<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    let alive = true;
    recordingApi.view(authedFetch, recordingId)
      .then((v) => { if (alive) { ticket.current = v.ticket; setViewing(v); } })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [authedFetch, recordingId]);

  const getUrl = useCallback(async () => {
    if (!viewing) throw new Error('Not open yet.');
    if (first.current && ticket.current) {
      first.current = false;
      return recordingApi.ticketUrl(ticket.current);
    }
    const next = viewing.via === 'meeting' && viewing.meetingId
      ? (await recordingApi.ticket(authedFetch, viewing.meetingId, viewing.recordingId)).ticket
      : await sharedLinkApi.renew(ticket.current ?? viewing.ticket);
    ticket.current = next;
    return recordingApi.ticketUrl(next);
  }, [authedFetch, viewing]);

  return (
    <div className="max-w-4xl mx-auto p-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {!viewing && !error && (
        <p className="text-ink-muted text-[0.8125rem]"><Spinner inline className="mr-2" />Opening…</p>
      )}
      {viewing && <RecordingViewer viewing={viewing} getUrl={getUrl} />}
    </div>
  );
}
