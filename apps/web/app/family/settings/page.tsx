'use client';

import { useCallback, useEffect, useState } from 'react';

import { FamilyShell } from '@/components/family/FamilyShell';
import { Button, Card } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';
import { familyApi, type FamilySettings } from '@/lib/family';

/**
 * Auto-save preferences.
 *
 * Three switches, worded as the behaviour rather than the field name — nobody
 * reasons about "autoSaveReceived", they reason about "save people who write
 * to me". The defaults are deliberate and explained inline, because the one
 * that is OFF is the one people ask about.
 *
 * Converted off MUI: Switch + FormControlLabel became Bootstrap's
 * form-check form-switch, which keeps the label clickable via htmlFor. That
 * association is easy to lose when hand-rolling a switch, and losing it makes
 * the control noticeably harder to hit.
 */
export default function FamilySettingsPage() {
  const { authedFetch } = useAuth();

  const [settings, setSettings] = useState<FamilySettings | null>(null);
  const [saved, setSaved] = useState<FamilySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    familyApi.settings(authedFetch)
      .then((s) => { if (live) { setSettings(s); setSaved(s); } })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [authedFetch]);

  const dirty = !!settings && !!saved && (
    settings.autoSaveReceived !== saved.autoSaveReceived ||
    settings.autoSaveSent !== saved.autoSaveSent ||
    settings.autoSaveReply !== saved.autoSaveReply
  );

  const save = useCallback(async () => {
    if (!settings) return;
    setBusy(true); setError(null); setNote(null);
    try {
      const next = await familyApi.saveSettings(authedFetch, settings);
      setSettings(next); setSaved(next);
      setNote('Saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [authedFetch, settings]);

  // Takes the boolean directly. MUI's onChange handed over (event, checked);
  // a native checkbox gives only the event, so the call sites read
  // e.target.checked and this stays a plain setter.
  const toggle = (key: keyof FamilySettings) => (checked: boolean) =>
    setSettings((s) => (s ? { ...s, [key]: checked } : s));

  const SWITCHES: { key: keyof FamilySettings; id: string; label: string; hint: string }[] = [
    {
      key: 'autoSaveReceived',
      id: 'tv-auto-received',
      label: 'Save people who write to me',
      hint: 'When a message arrives from someone not in your contacts, add them.',
    },
    {
      key: 'autoSaveSent',
      id: 'tv-auto-sent',
      label: 'Save people I write to',
      hint: 'Off by default. You already know who you wrote to, and with this on every one-off recipient lands in your address book.',
    },
    {
      key: 'autoSaveReply',
      id: 'tv-auto-reply',
      label: 'Keep “last contacted” up to date',
      hint: 'For people already in your contacts, record each exchange so the list can be sorted by who you have spoken to recently.',
    },
  ];

  return (
    <FamilyShell title="Contact settings" breadcrumb="Settings">
      {error && (
        <div className="alert alert-danger !flex !items-start !mb-[1.5rem]">
          <div className="!flex-auto">{error}</div>
          <button type="button" className="btn-close" aria-label="Dismiss"
                  onClick={() => setError(null)} />
        </div>
      )}
      {note && (
        <div className="alert alert-success !flex !items-start !mb-[1.5rem]">
          <div className="!flex-auto">{note}</div>
          <button type="button" className="btn-close" aria-label="Dismiss"
                  onClick={() => setNote(null)} />
        </div>
      )}

      <Card
        title="Saving contacts automatically"
        subtitle="Contacts saved this way are always personal — nobody else in your organisation sees them"
        actions={
          <Button variant="primary" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        }
      >
        {!settings ? (
          <div className="!flex !justify-center !py-[1.5rem]">
            <span className="!inline-block animate-spin !rounded-[50%]"
                  style={{ width: 28, height: 28, border: '3px solid rgba(0,0,0,.12)',
                           borderTopColor: '#6C3CE9' }} />
          </div>
        ) : (
          <div className="!flex !flex-col !gap-[1rem]">
            {SWITCHES.map((s, i) => (
              <div key={s.key}>
                {i > 0 && <hr className="mt-0 !mb-[1rem]" />}
                <div className="form-check form-switch">
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    id={s.id}
                    checked={Boolean(settings[s.key])}
                    onChange={(e) => toggle(s.key)(e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor={s.id}>{s.label}</label>
                </div>
                {/* Indented to line up under the label rather than the switch,
                    so the hint reads as belonging to the setting above it. */}
                <p className="!text-[0.875rem] !text-ink-muted mb-0" style={{ marginLeft: 44 }}>{s.hint}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="What this does not do" className="!mt-[1.5rem]">
        <p className="!text-[0.875rem] !text-ink-muted mb-0">
          Automatically saved contacts are personal to you. A message arriving in your mailbox
          says something about who <em>you</em> correspond with; it says nothing about who the
          organisation knows, so nothing here is ever shared with colleagues. To share a
          contact, open it and choose “Share with organisation” — that is a deliberate act,
          and it cannot be undone from this screen.
        </p>
        <p className="!text-[0.875rem] !text-ink-muted !mt-[1rem] mb-0">
          Deleting an automatically saved contact also stops it coming back. The next message
          from that address will not recreate it.
        </p>
      </Card>
    </FamilyShell>
  );
}
