'use client';

import { useEffect, useRef, useState } from 'react';
import { displayName } from '@tatvaos/core';
import { useAuth } from '@/lib/auth';
import { mailApi } from '@/lib/mail';
import { connectApi } from '@/lib/connect';
import {
  alertPermission, loadAlertPrefs, showAlert, ALERT_PREFS_KEY,
  type AlertPrefs,
} from '@/lib/desktopAlerts';

// ============================================================================
//  The watcher behind desktop alerts. Renders nothing.
// ============================================================================
//
//  Mounted once in the root layout so it runs wherever the person is —
//  reading mail, in Space, on the calendar. Putting it on the mail page would
//  have meant "new mail alerts, but only while you are looking at your mail",
//  which is the one situation where you do not need telling.
//
//  It polls, because nothing pushes: there is no SSE, no websocket and no
//  delta endpoint on the mail API (the mail list itself has polled every 30s
//  since long before this). Two timers, both idle unless the person has
//  turned alerts on AND the browser has granted permission.
//
//  ── THE FIRST POLL NEVER SPEAKS. ────────────────────────────────────────
//
//  It records what is already there and says nothing. Without that, turning
//  alerts on — or opening a second tab — would fire an alert for every
//  unread message already sitting in the inbox, which is exactly the
//  behaviour that teaches somebody to switch notifications off for good.
// ============================================================================

const MAIL_POLL_MS = 45_000;
const MEETING_POLL_MS = 60_000;
/** Most alerts raised from one poll. A burst of forty is a burst of noise. */
const MAX_PER_POLL = 3;

export function DesktopAlerts() {
  const { user, authedFetch } = useAuth();
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);

  // Read on mount, and follow the switch in the account page — which may be
  // in ANOTHER TAB, hence 'storage'. Without this a person who turns alerts
  // off carries on being alerted by every other tab they have open.
  useEffect(() => {
    const sync = () => setPrefs(loadAlertPrefs());
    sync();
    const onStorage = (e: StorageEvent) => { if (e.key === ALERT_PREFS_KEY) sync(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener(ALERT_PREFS_KEY, sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(ALERT_PREFS_KEY, sync);
    };
  }, []);

  // Message ids already seen, and meetings already announced. Refs, not
  // state: they must not re-render anything and must survive every tick.
  const seenMail = useRef<Set<string> | null>(null);
  const toldAbout = useRef<Set<string>>(new Set());
  const fetchRef = useRef(authedFetch);
  fetchRef.current = authedFetch;

  const on = user !== null && prefs !== null && alertPermission() === 'granted';

  // ---- New mail ---------------------------------------------------------
  useEffect(() => {
    if (!on || prefs?.mail !== true) { seenMail.current = null; return; }
    let alive = true;

    const tick = async () => {
      try {
        const folders = await mailApi.folders(fetchRef.current);
        const inbox = folders.find((f) => f.slug === 'inbox');
        if (!inbox || !alive) return;

        const page = await mailApi.messages(fetchRef.current, inbox.id, { take: 10 });
        if (!alive) return;

        // First pass: learn, do not speak.
        if (seenMail.current === null) {
          seenMail.current = new Set(page.messages.map((m) => m.id));
          return;
        }

        const fresh = page.messages
          .filter((m) => !seenMail.current!.has(m.id) && !m.isRead)
          .slice(0, MAX_PER_POLL);

        page.messages.forEach((m) => seenMail.current!.add(m.id));

        fresh.forEach((m) => showAlert({
          title: displayName(m.from),
          body: m.subject || '(no subject)',
          // The message id, so the same arrival polled twice collapses into
          // one alert rather than stacking.
          tag: `mail-${m.id}`,
          url: '/mail/inbox',
        }));
      } catch {
        // A failed poll is not worth telling anybody about. The next one is
        // 45 seconds away.
      }
    };

    void tick();
    const t = setInterval(() => void tick(), MAIL_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [on, prefs?.mail]);

  // ---- A meeting about to start ----------------------------------------
  useEffect(() => {
    if (!on || prefs?.meetings !== true) return;
    const lead = Math.max(1, prefs?.leadMinutes ?? 10);
    let alive = true;

    const tick = async () => {
      try {
        const page = await connectApi.list(fetchRef.current, 'upcoming');
        if (!alive) return;
        const now = Date.now();

        page.meetings.forEach((m) => {
          if (!m.scheduledStart) return;
          const startsAt = new Date(m.scheduledStart).getTime();
          if (Number.isNaN(startsAt)) return;
          const minutesAway = (startsAt - now) / 60_000;
          // Inside the window and not already gone. A meeting that started
          // twenty minutes ago is not news.
          if (minutesAway > lead || minutesAway < -2) return;
          if (toldAbout.current.has(m.id)) return;
          toldAbout.current.add(m.id);

          const when = minutesAway < 1
            ? 'is starting now'
            : `starts in ${Math.round(minutesAway)} minute${Math.round(minutesAway) === 1 ? '' : 's'}`;
          showAlert({
            title: m.title || 'Meeting',
            body: `Your meeting ${when}.`,
            tag: `meeting-${m.id}`,
            url: `/connect/room/${m.code}`,
          });
        });
      } catch { /* the next tick is a minute away */ }
    };

    void tick();
    const t = setInterval(() => void tick(), MEETING_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [on, prefs?.meetings, prefs?.leadMinutes]);

  return null;
}
