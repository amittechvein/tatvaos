'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Button, Spinner } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { Modal } from '@/components/ui/Modal';
import { recordingApi, type Recording } from '@/lib/connect';

// ============================================================================
//  Watch a recording without downloading it first.
// ============================================================================
//
//  The file is already reachable in exactly the shape a <video> wants: a
//  signed ticket in the query string, anonymous, and NOT single-use — Core
//  kept it that way on purpose so that range requests work, which is what
//  seeking is made of. So playing it in the page needs no new endpoint; it
//  needs the URL the download button already builds, pointed at a player
//  instead of at the browser's downloads folder.
//
//  ─────────────────────────────────────────────────────────────────────────
//  THE ONE HARD PART: THE TICKET OUTLIVES NOTHING.
//
//  A ticket lasts five minutes. That is right for a download, which starts
//  once, and wrong for watching a forty-minute meeting: the player buffers as
//  it goes, and the first range request after the fifth minute is refused.
//  What the viewer sees is a video that stops, with no explanation.
//
//  So the player watches for that failure and repairs it: fetch a new ticket,
//  put it on the element, restore the position, and carry on playing if it
//  was playing. The seam is a fraction of a second and it happens once every
//  few minutes rather than never — which is the honest trade against asking
//  Core to lengthen an expiry that exists for a reason.
//
//  Raised with him: whether a PLAYBACK ticket should last longer than a
//  download one. Until that is decided this recovers rather than assumes.
// ============================================================================

export function Player({ meetingId, recording, onClose }: {
  meetingId: string;
  recording: Recording;
  onClose: () => void;
}) {
  const { authedFetch } = useAuth();
  const ref = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards the recovery below: without it a stream of error events while the
  // network is down would ask for a ticket per event.
  const renewing = useRef(false);

  const isVideo = recording.mode === 'video';

  const fetchTicket = useCallback(async (): Promise<string | null> => {
    try {
      const { ticket } = await recordingApi.ticket(authedFetch, meetingId, recording.id);
      return recordingApi.ticketUrl(ticket);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that recording.');
      return null;
    }
  }, [authedFetch, meetingId, recording.id]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const url = await fetchTicket();
      if (alive && url) setSrc(url);
    })();
    return () => { alive = false; };
  }, [fetchTicket]);

  /**
   * The ticket expired mid-playback. Put a fresh one on, and put the viewer
   * back where they were.
   *
   * currentTime is read BEFORE the src changes, because assigning src resets
   * it to zero — reading it afterwards would restore everybody to the start
   * of the meeting every five minutes, which is worse than stopping.
   */
  async function renew() {
    const el = ref.current;
    if (!el || renewing.current) return;
    renewing.current = true;

    const at = el.currentTime;
    const wasPlaying = !el.paused;

    const url = await fetchTicket();
    if (url) {
      setError(null);
      el.src = url;
      // load() then seek: a browser that has not re-opened the stream ignores
      // a seek, and the viewer lands at zero with the video playing.
      el.load();
      el.currentTime = at;
      if (wasPlaying) { try { await el.play(); } catch { /* autoplay refused */ } }
    }
    renewing.current = false;
  }

  return (
    <Modal
      title={isVideo ? 'Recording' : 'Recording (audio)'}
      subtitle={recording.startedAt ? undefined : 'This recording is still being written.'}
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Close</Button>
          {/* Still here. Watching is the common case, which is why it is the
              default now — but somebody filing a recording still needs the
              file, and hiding it would trade one annoyance for another. */}
          <Button variant="primary"
                  onClick={() => void recordingApi.download(authedFetch, meetingId, recording.id)}>
            Download
          </Button>
        </>
      )}
    >
      {error && <Alert tone="danger" className="py-2 text-[0.8125rem]">{error}</Alert>}

      {src === null ? (
        <div className="p-6 text-center text-ink-muted text-[0.8125rem]">
          <Spinner inline className="mr-2" />
          Opening…
        </div>
      ) : (
        <div className={isVideo ? 'cx-player' : 'cx-player cx-player--audio'}>
          {/* One element for both. An <audio> and a <video> differ here only
              in how much room the picture takes, and two elements would be two
              places to keep the ticket recovery working. */}
          <video
            ref={ref}
            src={src}
            controls
            playsInline
            preload="metadata"
            onError={() => void renew()}
            onStalled={() => void renew()}
          />
        </div>
      )}

      <p className="text-[0.6875rem] text-ink-muted mt-2 mb-0">
        Streamed from this server. Nothing is saved to your computer unless you
        press Download.
      </p>
    </Modal>
  );
}
