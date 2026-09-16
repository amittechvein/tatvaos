'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card } from '@/components/ui/Kit';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { settingsApi } from '@/lib/space';

// ============================================================================
//  Sharing policy
// ============================================================================
//
//  One switch today: whether people in this organisation may create "anyone
//  with the link" downloads in Space. It gets a page rather than a checkbox
//  buried elsewhere because of WHO reads it — the administrator at a school
//  or a clinic deciding whether documents may leave by link at all. That
//  person needs three things stated plainly: what is on, what off actually
//  does (every existing link stops working, immediately), and that off is
//  reversible (the links come back when the switch does).
//
//  Turning OFF asks for confirmation; turning ON does not. Off is the action
//  with immediate blast radius — links people have already mailed out die on
//  the spot — while on merely restores what the org had before.
//
//  The audit trail is written by the SERVER on every change (the Space
//  contract's rule: policy changing hands is always recorded). Nothing here
//  needs to log anything.
// ============================================================================

export default function SharingPolicyPage() {
  const { authedFetch } = useAuth();

  const [allow, setAllow] = useState<boolean | null>(null); // null = loading
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(() => {
    setError(null);
    settingsApi.get(authedFetch)
      .then((s) => setAllow(s.allowPublicLinks))
      .catch((e: Error) => setError(e.message));
  }, [authedFetch]);

  useEffect(() => { load(); }, [load]);

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const s = await settingsApi.set(authedFetch, next);
      setAllow(s.allowPublicLinks);
      setConfirmOff(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell
      scope="organisation"
      title="Sharing"
      subtitle="What may leave this organisation by link"
    >
      {error && (
        <Alert tone="danger" action={<Button variant="ghost" onClick={load}>Try again</Button>}>
          {error}
        </Alert>
      )}

      <Card
        title="Public links in Space"
        subtitle="“Anyone with the link” downloads — no TatvaOS account needed to open one"
        actions={
          allow === null ? undefined : allow ? (
            <Button variant="danger" disabled={saving} onClick={() => setConfirmOff(true)}>
              Turn off for this organisation
            </Button>
          ) : (
            <Button variant="primary" disabled={saving} onClick={() => save(true)}>
              {saving ? 'Turning on…' : 'Turn public links back on'}
            </Button>
          )
        }
      >
        {allow === null && !error && <p className="!text-ink-muted mb-0">Loading…</p>}

        {allow === true && (
          <>
            <p className="mb-2">
              <Badge tone="ok">On</Badge>{' '}
              People here can share a Space file with anyone — the recipient
              opens it in a browser, no account needed. Every link expires
              (30 days unless the sharer chooses otherwise, one year at most),
              and every download is a forced attachment, never a page.
            </p>
            <p className="!text-ink-muted !text-[0.75rem] mb-0">
              Individual links are created and revoked by the file&rsquo;s owner in
              Space&rsquo;s share dialog. This switch is the organisation-wide policy
              over all of them.
            </p>
          </>
        )}

        {allow === false && (
          <>
            <p className="mb-2">
              <Badge tone="danger">Off</Badge>{' '}
              Nobody in this organisation can create a public link, and every
              link created before the switch was turned off has stopped
              working — visitors see &ldquo;this link does not exist or has
              expired&rdquo;.
            </p>
            <p className="!text-ink-muted !text-[0.75rem] mb-0">
              The links themselves still exist. Turning this back on makes
              every unexpired, unrevoked link work again exactly as before.
            </p>
          </>
        )}
      </Card>

      {confirmOff && (
      <Modal
        onClose={() => !saving && setConfirmOff(false)}
        title="Turn off public links?"
        busy={saving}
      >
        <p>
          Every public link anyone in this organisation has already shared
          stops working <strong>immediately</strong> — including links sent in
          emails that have already been delivered. Recipients will see
          &ldquo;this link does not exist or has expired&rdquo;.
        </p>
        <p className="!text-ink-muted">
          This is reversible: the links are kept, and turning the switch back
          on restores every one that has not expired or been revoked. The
          change is recorded in the audit trail either way.
        </p>
        <div className="!flex !justify-end gap-2 !mt-[1rem]">
          <Button variant="ghost" disabled={saving} onClick={() => setConfirmOff(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={saving} onClick={() => save(false)}>
            {saving ? 'Turning off…' : 'Turn off public links'}
          </Button>
        </div>
      </Modal>
      )}
    </AdminShell>
  );
}
