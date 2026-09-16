'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import { Badge, Button, Card } from '@/components/ui/Kit';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';

// ============================================================================
//  AI consent — the organisation's switch over core.tenants.allow_ai.
//
//  Deliberately shaped like the Sharing page beside it, because it is the
//  same KIND of decision made by the same person: an administrator deciding
//  whether something may leave the organisation. There, documents by link;
//  here, content to an AI provider.
//
//  The disclosure text comes from the API, not from this file — the consent
//  screen must never be able to soften what the platform actually does, and
//  when the provider moves to Azure India the sentence changes in ONE place.
//
//  Asymmetric confirmation, inverted from Sharing's: there OFF was the
//  destructive action; here ON is the consequential one — it starts data
//  leaving — so ON gets the modal and OFF is immediate. Off must always be
//  one click, because "stop sending our data" is a request that should never
//  meet a confirmation dialog.
// ============================================================================

interface AiState {
  enabled: boolean;
  platformConfigured: boolean;
  model: string | null;
  disclosure: string;
}

export default function OrgAiPage() {
  const { authedFetch } = useAuth();

  const [state, setState] = useState<AiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);

  const load = useCallback(() => {
    setError(null);
    authedFetch('/org/ai')
      .then(async (r) => {
        if (!r.ok) throw new Error('Could not load the AI setting.');
        setState(await r.json());
      })
      .catch((e: Error) => setError(e.message));
  }, [authedFetch]);

  useEffect(() => { load(); }, [load]);

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const r = await authedFetch('/org/ai', {
        method: 'PUT', body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) throw new Error('Could not change the AI setting.');
      setConfirmOn(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell
      scope="organisation"
      title="AI"
      subtitle="Whether this organisation's content may be processed by an AI provider"
    >
      {error && (
        <Alert tone="danger" action={<Button variant="ghost" onClick={load}>Try again</Button>}>
          {error}
        </Alert>
      )}

      <Card
        title="AI features"
        subtitle="Meeting minutes today; mail summaries and drafting later"
        actions={
          !state ? undefined : !state.platformConfigured ? undefined : state.enabled ? (
            <Button variant="danger" disabled={saving} onClick={() => save(false)}>
              {saving ? 'Turning off…' : 'Turn off for this organisation'}
            </Button>
          ) : (
            <Button variant="primary" disabled={saving} onClick={() => setConfirmOn(true)}>
              Turn on for this organisation
            </Button>
          )
        }
      >
        {!state && !error && <p className="!text-ink-muted mb-0">Loading…</p>}

        {state && !state.platformConfigured && (
          <p className="mb-0">
            <Badge tone="neutral">Unavailable</Badge>{' '}
            AI is not configured on this platform, so there is nothing to switch —
            no content leaves regardless of this setting.
          </p>
        )}

        {state?.platformConfigured && state.enabled && (
          <>
            <p className="mb-2">
              <Badge tone="ok">On</Badge>{' '}
              AI features are active for this organisation
              {state.model ? <> (model: <code>{state.model}</code>)</> : null}.
              Meeting minutes are written by the model; every call is metered
              and attributed to this organisation.
            </p>
            <p className="!text-ink-muted !text-[0.75rem] mb-0">{state.disclosure}</p>
          </>
        )}

        {state?.platformConfigured && !state.enabled && (
          <>
            <p className="mb-2">
              <Badge tone="neutral">Off</Badge>{' '}
              Nothing from this organisation is sent to any AI provider.
              Features that would use AI fall back to their non-AI form —
              meeting minutes become a mechanical digest, clearly labelled.
            </p>
            <p className="!text-ink-muted !text-[0.75rem] mb-0">
              Turning this on is recorded in the audit trail with who and when,
              because for many organisations that record is the point.
            </p>
          </>
        )}
      </Card>

      {confirmOn && state && (
        <Modal
          onClose={() => !saving && setConfirmOn(false)}
          title="Turn on AI for this organisation?"
          busy={saving}
        >
          <p>{state.disclosure}</p>
          <p className="!text-ink-muted">
            You can turn it off again at any time with one click — sending
            stops immediately. Both changes are recorded in the audit trail.
          </p>
          <div className="!flex !justify-end gap-2 !mt-[1rem]">
            <Button variant="ghost" disabled={saving} onClick={() => setConfirmOn(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => save(true)}>
              {saving ? 'Turning on…' : 'I agree — turn it on'}
            </Button>
          </div>
        </Modal>
      )}
    </AdminShell>
  );
}
