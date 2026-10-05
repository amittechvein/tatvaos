'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { Input } from '@/components/ui/Form';
import { BrandMark, BrandName } from '@/components/ui/Brand';
import {
  SharePasswordError, SharePausedError, recordingApi, sharedLinkApi, type RecordingViewing,
} from '@/lib/connect';
import { ConnectSkin } from '../../(shell)/ConnectSkin';
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
  const [show, setShow] = useState(false);

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
      {/* BRANDED, like every other page a stranger can land on (Amit, 26
          Sept). Whoever opens this link may never have heard of TatvaOS: the
          header says whose product this is, the card is the same shape as
          Space's public download page (app/l/[token]), and the footer says
          where it came from. The kit's tokens carry dark mode. */}
      <div className="flex min-h-screen flex-col bg-canvas">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-4xl items-center gap-2.5 px-4 py-3">
            <BrandMark product="connect" alt="" className="h-9 w-9" />
            <BrandName product="connect" alt="TatvaOS Connect" className="h-9 w-auto" />
            <span className="ml-auto text-[0.75rem] text-ink-muted">Shared recording</span>
          </div>
        </header>

        <main className="mx-auto w-full max-w-4xl grow px-4 py-8">
          {dead && (
            <Gate icon="ri-link-unlink" title="This recording is not available">
              <p className="mb-2 text-sm text-ink-muted">{dead}</p>
              <p className="mb-0 text-xs text-ink-faint">
                If you still need it, ask the person who sent you the link to share it again.
              </p>
            </Gate>
          )}

          {!dead && needsPassword && !viewing && (
            <Gate icon="ri-lock-password-line" title="This recording needs a password">
              <p className="mb-5 text-sm text-ink-muted">
                The person who shared it should have sent you the password separately.
              </p>
              <form className="text-left" onSubmit={(e) => { e.preventDefault(); void open(password); }}>
                {paused && <Alert tone="warn" className="py-2 text-[0.8125rem]">{paused}</Alert>}
                {wrong && !paused && <Alert tone="danger" className="py-2 text-[0.8125rem]">{wrong}</Alert>}
                <label htmlFor="cx-link-pass" className="mb-1.5 block text-[13px] font-medium text-ink">
                  Password
                </label>
                {/* The kit's Input, not className="cx-field" — that class is a
                    form-row band, and on the control it left the box without a
                    border or background, so it could not be seen (Amit, 26 Sept).
                    Show/hide, because this is typed from a message on a phone. */}
                <div className="relative">
                  <Input id="cx-link-pass" type={show ? 'text' : 'password'} autoFocus
                         autoComplete="off" spellCheck={false} className="pr-11"
                         value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button type="button" onClick={() => setShow((v) => !v)}
                          aria-label={show ? 'Hide the password' : 'Show the password'}
                          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-ink-muted hover:text-ink">
                    <i className={show ? 'ri-eye-off-line' : 'ri-eye-line'} aria-hidden="true" />
                  </button>
                </div>
                <Button variant="primary" type="submit" className="mt-4 w-full"
                        disabled={busy || password.length === 0}>
                  {busy ? 'Opening…' : 'Open the recording'}
                </Button>
              </form>
            </Gate>
          )}

          {!dead && !needsPassword && !viewing && busy && (
            <p className="text-center text-[0.8125rem] text-ink-muted"><Spinner inline className="mr-2" />Opening…</p>
          )}

          {viewing && <RecordingViewer viewing={viewing} getUrl={getUrl} />}
        </main>

        <footer className="px-4 pb-6 text-center text-[11px] text-ink-faint">
          Shared with{' '}
          <a href="https://tatvaos.com" className="font-medium text-ink-muted hover:text-ink"
             target="_blank" rel="noopener noreferrer">TatvaOS Connect</a>
          {' '}· Nothing is saved to your device unless you press Download.
        </footer>
      </div>
    </ConnectSkin>
  );
}

/** The centred card for everything that is not the recording itself —
 *  the same shape as Space's public link page, with Connect's mark. */
function Gate({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-6 w-full max-w-md rounded-card border border-line bg-surface p-8 text-center shadow-raised">
      <div className="relative mx-auto mb-4 h-14 w-14">
        <BrandMark product="connect" alt="" className="h-14 w-14" />
        <span className="absolute -bottom-1 -right-1 grid h-6 w-6 place-items-center rounded-full border border-line bg-surface text-[13px] text-ink-muted">
          <i className={icon} aria-hidden="true" />
        </span>
      </div>
      <h1 className="mb-2 text-lg font-semibold text-ink">{title}</h1>
      {children}
    </div>
  );
}
