'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  Secrets at rest (Mr. Singh, 26 Sept 2026). Every secret saved from now on
//  is encrypted. Ones saved before stay in plain text until the operator
//  presses this — deliberately not automatic at start-up, because an older
//  build cannot read an encrypted value, and sealing at start would make a
//  rollback break SMS sign-in until the passwords were typed in again.
//  Press it once this version has proved good in production.
// ============================================================================

export function SealSecretsNotice() {
  const { authedFetch } = useAuth();
  const [plain, setPlain] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    authedFetch('/admin/settings/secrets-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPlain(d?.plainText ?? null))
      .catch(() => setPlain(null));
  }, [authedFetch]);
  useEffect(() => { load(); }, [load]);

  if (!plain) return null;

  async function seal() {
    if (!window.confirm(
      'Encrypt the stored secrets now?\n\nAfter this, rolling back to a version older than this one '
      + 'needs the SMS, Google and Razorpay secrets typed in again. Do this once the current version has proved good.',
    )) return;
    setBusy(true); setError(null);
    try {
      const r = await authedFetch('/admin/settings/seal-secrets', { method: 'POST' });
      if (!r.ok) throw new Error('Could not encrypt them.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not encrypt them.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Alert tone="warn" title="Secrets stored in plain text">
      <p className="mb-2">
        {plain === 1 ? 'One secret was' : `${plain} secrets were`} saved before encryption existed and
        {plain === 1 ? ' is' : ' are'} still readable by anyone with a copy of the database. Secrets saved from
        now on are encrypted.
      </p>
      {error && <p className="mb-2 text-danger">{error}</p>}
      <Button variant="primary" onClick={seal} disabled={busy}>{busy ? 'Encrypting…' : 'Encrypt stored secrets'}</Button>
    </Alert>
  );
}
