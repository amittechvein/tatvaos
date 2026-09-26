'use client';

import Link from 'next/link';
import { Button, Card } from '@/components/ui/Kit';
import { RecordingVideo } from '../meetings/[id]/Player';
import {
  SHARE_EXPOSURE, durationLabel, timeLabel,
  type RecordingViewing,
} from '@/lib/connect';

// ============================================================================
//  One recording, opened for watching.
// ============================================================================
//
//  Rendered for three kinds of viewer, and the page says which one you are:
//
//    · somebody who was in the meeting  — the baseline; a way back to it
//    · somebody an organisation or named share covers — "shared with you"
//    · somebody holding a password or public link — "shared by link", and
//      when it stops working
//
//  Saying who a recording reached you through is not decoration. A person
//  watching a board meeting they were not in should be able to see, on the
//  page, that it was shared with them on purpose — and a person who opened a
//  public link should see that it is one.
//
//  This file decides nothing about access. Every byte is authorised by the
//  server, per request, against the share or the meeting.
// ============================================================================

export function RecordingViewer({ viewing, getUrl }: {
  viewing: RecordingViewing;
  /** A fresh playable URL; called to start, on recovery, and for Download. */
  getUrl: () => Promise<string>;
}) {
  const isVideo = viewing.mode === 'video';

  const facts = [
    isVideo ? 'Video' : 'Audio',
    viewing.durationMs ? durationLabel(viewing.durationMs) : null,
    viewing.startedAt ? `recorded ${timeLabel(viewing.startedAt)}` : null,
  ].filter(Boolean).join(' · ');

  async function download() {
    // A fresh ticket, not the one the player holds: that one may be minutes
    // from expiring, and a download that starts with a dead ticket is a 404
    // saved to somebody's desktop.
    window.location.assign(await getUrl());
  }

  return (
    <Card
      title={viewing.title}
      subtitle={facts}
      actions={<Button variant="primary" onClick={() => void download()}>Download</Button>}
    >
      <p className="text-[0.8125rem] text-ink-muted mb-3">
        {viewing.via === 'meeting' && <>You were in this meeting. </>}
        {viewing.via === 'share' && <>Shared with you. </>}
        {viewing.via === 'link' && viewing.level && <>Shared by link — {SHARE_EXPOSURE[viewing.level].toLowerCase()} can open it. </>}
        {viewing.expiresAt && <>The link stops working {timeLabel(viewing.expiresAt)}.</>}
      </p>

      <RecordingVideo isVideo={isVideo} getUrl={getUrl} />

      {viewing.meetingId && (
        <p className="text-[0.8125rem] mt-3 mb-0">
          <Link href={`/connect/meetings/${viewing.meetingId}`}>Open the meeting</Link>
        </p>
      )}
    </Card>
  );
}
