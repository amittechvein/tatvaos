'use client';

// ============================================================================
//  Desktop alerts — the browser's own notifications, while TatvaOS is open
// ============================================================================
//
//  Amit asked for desktop alerts for new mail and for meetings about to
//  start, working in Chrome, Firefox and Safari (23 September 2026). He chose
//  the version that runs WHILE A TATVAOS TAB IS OPEN — which may be a
//  background tab behind other windows, but not a closed browser.
//
//  ── WHAT THAT RULES OUT, SAID PLAINLY ───────────────────────────────────
//
//  Nothing arrives once the last TatvaOS tab is shut. Real Web Push does
//  survive that, and it needs a service worker, a VAPID key pair on the
//  server, a subscriptions table and a sender worker. That is a separate
//  piece of work; this file must not grow into it by halves. The place it
//  would plug into already exists and already says so:
//  Workers/CalendarReminderWorker.cs drops method='notification' with a log
//  line reading "nowhere to go until TatvaOS Notifications exists".
//
//  ── BROWSERS ────────────────────────────────────────────────────────────
//
//  Chrome, Edge and Firefox implement the promise form of
//  requestPermission(). SAFARI SHIPPED THE CALLBACK FORM FIRST and still
//  accepts it; on older builds the promise is simply undefined, so awaiting
//  it yields undefined and the caller would conclude "denied" for somebody
//  who just clicked Allow. requestAlerts() below handles both shapes for
//  that reason, not for tidiness.
//
//  Safari also REQUIRES a user gesture for the prompt — no browser should be
//  asked on page load anyway, which is why the only caller is a switch the
//  person clicks.
//
//  iOS Safari has no window.Notification at all outside an installed home
//  screen app. That is not a bug to work around; supported() answers false
//  and the UI says so rather than offering a switch that cannot work.
// ============================================================================

export const ALERT_PREFS_KEY = 'tatvaos.desktopAlerts';

export interface AlertPrefs {
  /** A message arriving in the inbox. */
  mail: boolean;
  /** A meeting about to start. */
  meetings: boolean;
  /** Somebody knocking or arriving in a meeting this browser is hosting. */
  room: boolean;
  /** How long before a meeting to say something. */
  leadMinutes: number;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  mail: true, meetings: true, room: true, leadMinutes: 10,
};

/** Does this browser have the Notification API at all? */
export function alertsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export type AlertPermission = NotificationPermission | 'unsupported';

export function alertPermission(): AlertPermission {
  if (!alertsSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Ask the browser, from a user gesture.
 *
 * Returns the resulting permission, never throws: a browser that refuses to
 * even ask (an insecure origin, an embedded frame) must leave the switch off
 * rather than take the page down with it.
 */
export async function requestAlerts(): Promise<AlertPermission> {
  if (!alertsSupported()) return 'unsupported';
  try {
    // The promise form. Safari's older callback form returns undefined here,
    // which is the whole reason for the second branch.
    const asPromise = Notification.requestPermission() as
      Promise<NotificationPermission> | undefined;
    if (asPromise && typeof asPromise.then === 'function') return await asPromise;

    return await new Promise<NotificationPermission>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Notification as any).requestPermission((p: NotificationPermission) => resolve(p));
    });
  } catch {
    return Notification.permission;
  }
}

export function loadAlertPrefs(): AlertPrefs {
  if (typeof window === 'undefined') return DEFAULT_ALERT_PREFS;
  try {
    const raw = window.localStorage.getItem(ALERT_PREFS_KEY);
    if (!raw) return DEFAULT_ALERT_PREFS;
    // Spread over the defaults: this value outlives the code that wrote it,
    // so a copy saved before a field existed must not arrive as undefined.
    return { ...DEFAULT_ALERT_PREFS, ...JSON.parse(raw) as Partial<AlertPrefs> };
  } catch {
    return DEFAULT_ALERT_PREFS;
  }
}

export function saveAlertPrefs(prefs: AlertPrefs): void {
  try { window.localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify(prefs)); } catch { /* fine */ }
}

/**
 * Show one alert.
 *
 * `tag` collapses repeats: the same message polled twice must not stack two
 * identical alerts, and every browser here honours it.
 *
 * Clicking focuses this tab and goes where the alert points. A notification
 * you cannot click through to is a nag rather than a shortcut.
 */
export function showAlert(
  { title, body, tag, url }: { title: string; body: string; tag: string; url?: string },
): void {
  if (!alertsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      tag,
      icon: '/brand/ui/icon.png',
    });
    n.onclick = () => {
      try {
        window.focus();
        if (url) window.location.assign(url);
        n.close();
      } catch { /* a closed opener is not worth an error */ }
    };
  } catch {
    // Some browsers throw here when the page is not permitted to construct
    // one (an iframe, a revoked permission mid-session). Silence is right:
    // an alert is never worth breaking the page it was raised from.
  }
}
