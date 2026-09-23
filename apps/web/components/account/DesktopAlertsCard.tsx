'use client';

import { useEffect, useState } from 'react';
import { Card, Button } from '@/components/ui/Kit';
import { Switch } from '@/components/ui/Form';
import {
  alertPermission, alertsSupported, loadAlertPrefs, requestAlerts, saveAlertPrefs,
  showAlert, ALERT_PREFS_KEY, type AlertPrefs, type AlertPermission,
} from '@/lib/desktopAlerts';

/**
 * The switch for desktop alerts, and the only place the browser is ever asked
 * for permission — Safari requires a user gesture, and no browser should be
 * asked on page load regardless.
 *
 * Every state this can be in is drawn, because the failure people actually
 * hit is "I turned it on and nothing happens", and the reason is usually that
 * the browser itself is blocking it. A switch that silently does nothing in
 * that case is the worst version of this card.
 */
export function DesktopAlertsCard() {
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [permission, setPermission] = useState<AlertPermission>('default');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setPrefs(loadAlertPrefs());
    setPermission(alertPermission());
  }, []);

  const update = (patch: Partial<AlertPrefs>) => {
    setPrefs((old) => {
      const next = { ...(old ?? loadAlertPrefs()), ...patch };
      saveAlertPrefs(next);
      // Tell the watcher in this tab at once; other tabs hear the storage
      // event. Without this the change waits for a reload.
      try { window.dispatchEvent(new Event(ALERT_PREFS_KEY)); } catch { /* fine */ }
      return next;
    });
  };

  const turnOn = async () => {
    setAsking(true);
    const result = await requestAlerts();
    setPermission(result);
    setAsking(false);
    if (result === 'granted') {
      showAlert({
        title: 'Alerts are on',
        body: 'This is what a TatvaOS alert looks like.',
        tag: 'alerts-test',
      });
    }
  };

  if (prefs === null) return null;

  if (!alertsSupported()) {
    return (
      <Card title="Desktop alerts"
            subtitle="Not available in this browser">
        <p className="m-0 text-sm text-ink-muted">
          This browser cannot show desktop alerts. On an iPhone or iPad, Safari
          only offers them once TatvaOS has been added to the Home Screen.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Desktop alerts"
          subtitle="While a TatvaOS tab is open, even behind other windows">
      {permission === 'denied' ? (
        <p className="m-0 text-sm text-ink-muted">
          Your browser is blocking alerts from TatvaOS. Turn them back on in the
          browser&apos;s own settings for this site — a page cannot ask twice
          once it has been refused.
        </p>
      ) : permission !== 'granted' ? (
        <>
          <p className="mb-3 mt-0 text-sm text-ink-muted">
            Get told when mail arrives and before a meeting starts. Your browser
            will ask you to allow it.
          </p>
          <Button onClick={() => void turnOn()} disabled={asking}>
            {asking ? 'Asking…' : 'Turn on alerts'}
          </Button>
        </>
      ) : (
        <>
          <Switch
            label="New mail"
            hint="The sender and subject, when a message reaches your inbox."
            checked={prefs.mail}
            onChange={(e) => update({ mail: e.target.checked })}
          />
          <Switch
            label="Before a meeting starts"
            checked={prefs.meetings}
            onChange={(e) => update({ meetings: e.target.checked })}
          />
          {prefs.meetings && (
            <label className="mb-3 ml-12 flex items-center gap-2 text-sm text-ink-muted">
              How early
              <select
                value={prefs.leadMinutes}
                onChange={(e) => update({ leadMinutes: Number(e.target.value) })}
                className="rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink"
              >
                <option value={2}>2 minutes</option>
                <option value={5}>5 minutes</option>
                <option value={10}>10 minutes</option>
                <option value={15}>15 minutes</option>
              </select>
            </label>
          )}
          <Switch
            label="Someone joins a meeting I am hosting"
            hint="Only while that meeting's tab is in the background."
            checked={prefs.room}
            onChange={(e) => update({ room: e.target.checked })}
          />
          <Button variant="ghost"
                  onClick={() => showAlert({
                    title: 'TatvaOS',
                    body: 'This is what a TatvaOS alert looks like.',
                    tag: 'alerts-test',
                  })}>
            Show me one
          </Button>
        </>
      )}
    </Card>
  );
}
