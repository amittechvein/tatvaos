'use client';

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

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

  const toggle = (key: keyof FamilySettings) => (_: unknown, checked: boolean) =>
    setSettings((s) => (s ? { ...s, [key]: checked } : s));

  return (
    <FamilyShell title="Contact settings" breadcrumb="Settings">
      {error && <Alert severity="error" className="mb-4" onClose={() => setError(null)}>{error}</Alert>}
      {note && <Alert severity="success" className="mb-4" onClose={() => setNote(null)}>{note}</Alert>}

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
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={28} /></Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Box>
              <FormControlLabel
                control={<Switch checked={settings.autoSaveReceived} onChange={toggle('autoSaveReceived')} />}
                label="Save people who write to me"
              />
              <Typography variant="body2" color="text.secondary" sx={{ ml: 6 }}>
                When a message arrives from someone not in your contacts, add them.
              </Typography>
            </Box>

            <Divider />

            <Box>
              <FormControlLabel
                control={<Switch checked={settings.autoSaveSent} onChange={toggle('autoSaveSent')} />}
                label="Save people I write to"
              />
              <Typography variant="body2" color="text.secondary" sx={{ ml: 6 }}>
                Off by default. You already know who you wrote to, and with this on every
                one-off recipient lands in your address book.
              </Typography>
            </Box>

            <Divider />

            <Box>
              <FormControlLabel
                control={<Switch checked={settings.autoSaveReply} onChange={toggle('autoSaveReply')} />}
                label="Keep “last contacted” up to date"
              />
              <Typography variant="body2" color="text.secondary" sx={{ ml: 6 }}>
                For people already in your contacts, record each exchange so the list can be
                sorted by who you have spoken to recently.
              </Typography>
            </Box>
          </Box>
        )}
      </Card>

      <Card title="What this does not do" className="mt-6">
        <Typography variant="body2" color="text.secondary">
          Automatically saved contacts are personal to you. A message arriving in your mailbox
          says something about who <em>you</em> correspond with; it says nothing about who the
          organisation knows, so nothing here is ever shared with colleagues. To share a
          contact, open it and choose “Share with organisation” — that is a deliberate act,
          and it cannot be undone from this screen.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          Deleting an automatically saved contact also stops it coming back. The next message
          from that address will not recreate it.
        </Typography>
      </Card>
    </FamilyShell>
  );
}
