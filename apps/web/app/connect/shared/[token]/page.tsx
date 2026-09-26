'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Spinner } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import {
  SharePasswordError, SharePausedError, recordingApi, sharedLinkApi, type RecordingViewing,
} from '@/lib/connect';
import { ConnectSkin, Field } from '../../(shell)/ConnectSkin';
import { RecordingViewer } from '../../(shell)/recordings/Viewer';

// ============================================================================
//  /connect/shared/{token} — a recording opened by a LINK, with no account.
// ============================================================================
//
//  Outside the shell on purpose, like the meeting room: the person holding
//  this link may have no TatvaOS account at all, and RequireAuth would send
//  them to a sign-in page they cannot get past.
//
//  THREE THINGS THIS PAGE CAN SAY, AND ONLY THREE.
//    · the recording
//    · "this one needs a password" (and, after a wrong one, that it was wrong)
//    · "this link does not work" — the same sentence for revoked, expired,
//      switched off by the organisation, and never existed. The server makes
//      them indistinguishable and so does this page.
//
//  Opening is a POST the page makes itself, not the page load. A chat app
//  unfurling this URL fetches the HTML and nothing else, so a preview is not
//  recorded as somebody opening the recording.
// ============================================================================

export default function SharedRecordingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [viewing, setViewing] = useState<RecordingViewing | null>(null);
  const [dead, setDead] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [wrong, setWrong] = useState<string | null>(null);
  const [paused, setPaused] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);

  const ticket = useRef<string | null>(null);
  const first = useRef(true);

  const open = useCallback(async (pw?: string) => {
    setBusy(true);
    setWrong(null);
    setPaused(null);
    try {
      const v = await sharedLinkApi.open(token, pw);
      ticket.current = v.ticket;
      first.current = true;
      setNeedsPassword(false);
      setViewing(v);
    } catch (e) {
      if (e instanceof SharePausedError) {
        // Not "dead": the link is fine and will open again within the hour.
        // Telling the real recipient it does not work would send them away.
        setPaused(e.message);
      } else if (e instanceof SharePasswordError) {
        setNeedsPassword(true);
        if (e.wrong) setWrong(e.message);
      } else {
        setDead(e instanceof Error ? e.message : 'This link does not work.');
      }
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => { void open(); }, [open]);

  const getUrl = useCallback(async () => {
    if (first.current && ticket.current) {
      first.current = false;
      return recordingApi.ticketUrl(ticket.current);
    }
    // Renewed by trading the ticket in, never by opening again: an opening is
    // what the host's "opened N times" counts, and a film is one opening.
    const next = await sharedLinkApi.renew(ticket.current ?? '');
    ticket.current = next;
    return recordingApi.ticketUrl(next);
  }, []);

  return (
    <ConnectSkin>
      <main className="min-h-screen bg-canvas py-10 px-4">
        <div className="max-w-4xl mx-auto">
          <p className="text-[0.8125rem] font-semibold text-ink-muted mb-4">TatvaOS Connect</p>

          {dead && (
            <Card title="This recording is not available">
              <p className="mb-0">{dead}</p>
              <p className="text-ink-muted text-[0.8125rem] mt-2 mb-0">
                If you still need it, ask the person who sent you the link to share it again.
              </p>
            </Card>
          )}

          {!dead && needsPassword && !viewing && (
            <Card title="This recording needs a password"
                  subtitle="The person who shared it should have sent the password separately.">
              <form onSubmit={(e) => { e.preventDefault(); void open(password); }}>
                {paused && <Alert tone="warn" className="py-2 text-[0.8125rem]">{paused}</Alert>}
                {wrong && !paused && <Alert tone="danger" className="py-2 text-[0.8125rem]">{wrong}</Alert>}
                <Field label="Password" htmlFor="cx-link-pass">
                  <input id="cx-link-pass" className="cx-field" type="password" autoFocus
                         autoComplete="off" value={password}
                         onChange={(e) => setPassword(e.target.value)} />
                </Field>
                <div className="mt-4">
                  <Button variant="primary" type="submit" disabled={busy || password.length === 0}>
                    {busy ? 'Opening…' : 'Open the recording'}
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {!dead && !needsPassword && !viewing && busy && (
            <p className="text-ink-muted text-[0.8125rem]"><Spinner inline className="mr-2" />Opening…</p>
          )}

          {viewing && <RecordingViewer viewing={viewing} getUrl={getUrl} />}
        </div>
      </main>
    </ConnectSkin>
  );
}
