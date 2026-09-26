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

interface AiUsage {
  from: string;
  tokens: number;
  requests: number;
  refused: number;
  /** null = no ceiling; 0 = none allowed. */
  ceilingTokens: number | null;
  /** null = no hourly limit; 0 = none allowed. */
  perPersonPerHour: number | null;
  paused: boolean;
  percentOfCeiling: number;
  byFeature: { feature: string; requests: number; tokens: number }[];
}

interface AiState {
  enabled: boolean;
  platformConfigured: boolean;
  model: string | null;
  disclosure: string;
  /** Mail's own switch (allow_mail_ai). Works only while `enabled` is on. */
  mailEnabled: boolean;
  /** False while Mail AI is held to a list of organisations and this is not on it. */
  mailOffered: boolean;
  mailNotOffered: string | null;
  mailDisclosure: string;
  /** Sorting incoming mail (step 3): its own consent, on top of Mail. */
  mailTriageEnabled: boolean;
  mailTriageSince: string | null;
  mailTriageDisclosure: string;
  /** False for hospitals and clinics (Amit, 25 Sept 2026); the sentence says why. */
  mailTriageOffered: boolean;
  mailTriageNotOffered: string | null;
  usage: AiUsage;
}

const FEATURE_NAMES: Record<string, string> = {
  'connect.minutes': 'Meeting minutes',
  docs: 'Docs',
  'platform.probe': 'Platform check',
  'mail.rewrite': 'Mail — Help me write',
  'mail.suggest': 'Mail — Suggested replies',
  'mail.triage': 'Mail — Sorting incoming mail',
};

const fmt = (n: number) => n.toLocaleString('en-IN');

export default function OrgAiPage() {
  const { authedFetch } = useAuth();

  const [state, setState] = useState<AiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  const [confirmMail, setConfirmMail] = useState(false);
  const [confirmTriage, setConfirmTriage] = useState(false);

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

  async function save(change: { enabled?: boolean; mail?: boolean; mailTriage?: boolean }) {
    setSaving(true);
    setError(null);
    try {
      const r = await authedFetch('/org/ai', {
        method: 'PUT', body: JSON.stringify(change),
      });
      if (!r.ok) throw new Error('Could not change the AI setting.');
      setConfirmOn(false);
      setConfirmMail(false);
      setConfirmTriage(false);
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
      title="TatvaOS AI"
      subtitle="Whether TatvaOS AI may process this organisation's content"
    >
      {error && (
        <Alert tone="danger" action={<Button variant="ghost" onClick={load}>Try again</Button>}>
          {error}
        </Alert>
      )}

      <Card
        title="TatvaOS AI"
        subtitle="Meeting minutes, and Mail when switched on below"
        actions={
          !state ? undefined : !state.platformConfigured ? undefined : state.enabled ? (
            <Button variant="danger" disabled={saving} onClick={() => save({ enabled: false })}>
              {saving ? 'Turning off…' : 'Turn off for this organisation'}
            </Button>
          ) : (
            <Button variant="primary" disabled={saving} onClick={() => setConfirmOn(true)}>
              Turn on for this organisation
            </Button>
          )
        }
      >
        {!state && !error && <p className="text-ink-muted mb-0">Loading…</p>}

        {state && !state.platformConfigured && (
          <p className="mb-0">
            <Badge tone="neutral">Unavailable</Badge>{' '}
            TatvaOS AI is not configured on this platform, so there is nothing to switch —
            no content leaves regardless of this setting.
          </p>
        )}

        {state?.platformConfigured && state.enabled && (
          <>
            <p className="mb-2">
              <Badge tone="ok">On</Badge>{' '}
              TatvaOS AI is on for this organisation. Meeting minutes are
              written by it; every call is metered and attributed to this
              organisation.
            </p>
            <p className="text-ink-muted text-[0.75rem] mb-0">{state.disclosure}</p>
          </>
        )}

        {state?.platformConfigured && !state.enabled && (
          <>
            <p className="mb-2">
              <Badge tone="neutral">Off</Badge>{' '}
              Nothing from this organisation is sent to TatvaOS AI.
              Features that would use it fall back to their non-AI form —
              meeting minutes become a mechanical digest, clearly labelled.
            </p>
            <p className="text-ink-muted text-[0.75rem] mb-0">
              Turning this on is recorded in the audit trail with who and when,
              because for many organisations that record is the point.
            </p>
          </>
        )}
      </Card>

      {state?.platformConfigured && (
        <MailAiCard
          state={state}
          saving={saving}
          onOff={() => save({ mail: false })}
          onOn={() => setConfirmMail(true)}
          onTriageOn={() => setConfirmTriage(true)}
          onTriageOff={() => save({ mailTriage: false })}
        />
      )}

      {state?.platformConfigured && <UsageCard usage={state.usage} />}

      {confirmTriage && state && (
        <Modal
          onClose={() => !saving && setConfirmTriage(false)}
          title="Sort incoming mail with TatvaOS AI?"
          busy={saving}
        >
          <p>{state.mailTriageDisclosure}</p>
          <p className="text-ink-muted">
            This is the one Mail AI feature that sends mail nobody has clicked on. Automated
            senders are labelled by a simple rule and are not sent. Labels never change your
            people&apos;s own categories. Turning it off stops sending at once and deletes every
            label it made.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" disabled={saving} onClick={() => setConfirmTriage(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => save({ mailTriage: true })}>
              {saving ? 'Turning on…' : 'I agree — sort incoming mail'}
            </Button>
          </div>
        </Modal>
      )}

      {confirmMail && state && (
        <Modal
          onClose={() => !saving && setConfirmMail(false)}
          title="Turn on TatvaOS AI in Mail?"
          busy={saving}
        >
          <p>{state.mailDisclosure}</p>
          <p className="text-ink-muted">
            People will see Help me write in the composer, which sends only the text
            they typed and only when they ask, and suggested replies under a message,
            which send that message when they open it. Mail they sent, junk and
            automated senders are never sent. Turning it off again is one click and
            takes effect at once.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" disabled={saving} onClick={() => setConfirmMail(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => save({ mail: true })}>
              {saving ? 'Turning on…' : 'I agree — turn it on for Mail'}
            </Button>
          </div>
        </Modal>
      )}

      {confirmOn && state && (
        <Modal
          onClose={() => !saving && setConfirmOn(false)}
          title="Turn on TatvaOS AI for this organisation?"
          busy={saving}
        >
          <p>{state.disclosure}</p>
          <p className="text-ink-muted">
            You can turn it off again at any time with one click — sending
            stops immediately. Both changes are recorded in the audit trail.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" disabled={saving} onClick={() => setConfirmOn(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => save({ enabled: true })}>
              {saving ? 'Turning on…' : 'I agree — turn it on'}
            </Button>
          </div>
        </Modal>
      )}
    </AdminShell>
  );
}

/**
 * Mail's own switch (allow_mail_ai). Separate from the organisation's consent
 * above because an organisation may want AI meeting notes and still keep
 * every email off the provider — the reason Translate stays on our own server.
 * Same asymmetry as above: ON asks first, OFF is immediate.
 */
function MailAiCard({
  state, saving, onOn, onOff, onTriageOn, onTriageOff,
}: {
  state: AiState; saving: boolean; onOn: () => void; onOff: () => void;
  onTriageOn: () => void; onTriageOff: () => void;
}) {
  const live = state.enabled && state.mailEnabled;
  return (
    <Card
      title="TatvaOS AI in Mail"
      subtitle="Help me write, suggested replies, and sorting"
      actions={
        !state.mailOffered ? undefined : state.mailEnabled ? (
          <Button variant="danger" disabled={saving} onClick={onOff}>
            {saving ? 'Turning off…' : 'Turn off for Mail'}
          </Button>
        ) : (
          <Button variant="primary" disabled={saving || !state.enabled} onClick={onOn}>
            Turn on for Mail
          </Button>
        )
      }
    >
      {!state.mailOffered && (
        <p className="mb-0">
          <Badge tone="neutral">Not yet available</Badge>{' '}
          {state.mailNotOffered}
        </p>
      )}
      {state.mailOffered && live && (
        <>
          <p className="mb-2">
            <Badge tone="ok">On</Badge>{' '}
            Help me write rewrites a draft when asked; suggested replies appear under a
            message when it is opened.
          </p>
          <p className="text-ink-muted text-[0.75rem] mb-0">{state.mailDisclosure}</p>

          {/* Step 3: its own switch, because it is the one that sends mail
              nobody clicked on. Same asymmetry: ON asks, OFF is one click. */}
          <div className="mt-4 flex flex-wrap items-start gap-3 border-t border-line pt-3">
            <div className="min-w-0 flex-1">
              <p className="mb-1 font-medium">
                Sort incoming mail{' '}
                <Badge tone={state.mailTriageEnabled ? 'ok' : 'neutral'}>{state.mailTriageEnabled ? 'On' : 'Off'}</Badge>
              </p>
              <p className="mb-0 text-[0.75rem] text-ink-muted">
                {state.mailTriageEnabled
                  ? `New inbox mail is labelled Needs reply, FYI, Updates or Promotions${
                      state.mailTriageSince ? `, since ${new Date(state.mailTriageSince).toLocaleString('en-IN')}` : ''
                    }. Older mail is never sent.`
                  : 'Labels new inbox mail Needs reply, FYI, Updates or Promotions, with tabs to filter by them. Sends each new message in the background.'}
              </p>
            </div>
            {!state.mailTriageOffered ? (
              <p className="mb-0 max-w-xs text-[0.75rem] text-ink-muted">{state.mailTriageNotOffered}</p>
            ) : state.mailTriageEnabled ? (
              <Button variant="danger" disabled={saving} onClick={onTriageOff}>
                {saving ? 'Turning off…' : 'Turn off sorting'}
              </Button>
            ) : (
              <Button variant="primary" disabled={saving} onClick={onTriageOn}>
                Turn on sorting
              </Button>
            )}
          </div>
        </>
      )}
      {state.mailOffered && state.mailEnabled && !state.enabled && (
        <p className="mb-0">
          <Badge tone="neutral">Waiting</Badge>{' '}
          Mail is switched on, but TatvaOS AI is off for the organisation above, so
          nothing from Mail is sent.
        </p>
      )}
      {state.mailOffered && !state.mailEnabled && (
        <p className="mb-0">
          <Badge tone="neutral">Off</Badge>{' '}
          Nothing from Mail is sent to TatvaOS AI, and the composer shows no AI button.
          {!state.enabled && ' Turn on TatvaOS AI for the organisation first.'}
        </p>
      )}
    </Card>
  );
}

/**
 * This month's use against the allowance. The same numbers the operator sees,
 * and the ones the administrators are emailed about at 80% and 100%.
 */
function UsageCard({ usage }: { usage: AiUsage }) {
  const noCeiling = usage.ceilingTokens === null;
  const stopped = usage.ceilingTokens === 0;
  const tone = usage.percentOfCeiling >= 100 ? 'bg-danger' : usage.percentOfCeiling >= 80 ? 'bg-warn' : 'bg-ok';
  return (
    <Card title="Use this month" subtitle="Counted from the 1st, India time. Only counts are kept — never the text sent.">
      {usage.paused && (
        <Alert tone="warn">TatvaOS AI is paused across the platform at the moment, so requests are being refused.</Alert>
      )}
      {stopped ? (
        <p className="mb-3">
          The platform has set this organisation&apos;s AI allowance to none, so AI requests are refused.
          {usage.requests > 0 && ` ${fmt(usage.tokens)} tokens were used earlier this month.`}
        </p>
      ) : noCeiling ? (
        <p className="mb-3">{fmt(usage.tokens)} tokens in {fmt(usage.requests)} requests. No monthly ceiling is set.</p>
      ) : (
        <>
          <p className="mb-2">
            {fmt(usage.tokens)} of {fmt(usage.ceilingTokens ?? 0)} tokens ({usage.percentOfCeiling}%)
            in {fmt(usage.requests)} requests.
            {usage.percentOfCeiling >= 100 && ' AI has stopped for this organisation until the 1st.'}
          </p>
          <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-canvas" role="meter"
               aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage.percentOfCeiling}
               aria-label="Share of this month's AI allowance used">
            <div className={`h-full ${tone}`} style={{ width: `${usage.percentOfCeiling}%` }} />
          </div>
        </>
      )}
      {usage.byFeature.length > 0 && (
        <table className="mb-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th className="py-1 font-medium">Feature</th>
              <th className="py-1 text-right font-medium">Requests</th>
              <th className="py-1 text-right font-medium">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {usage.byFeature.map((f) => (
              <tr key={f.feature} className="border-t border-line/70">
                <td className="py-1">{FEATURE_NAMES[f.feature] ?? f.feature}</td>
                <td className="py-1 text-right">{fmt(f.requests)}</td>
                <td className="py-1 text-right">{fmt(f.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mb-0 text-[0.75rem] text-ink-muted">
        {usage.perPersonPerHour === null
          ? 'There is no hourly limit per person.'
          : usage.perPersonPerHour === 0
            ? 'Individual AI requests are switched off at the moment.'
            : `Each person can make up to ${fmt(usage.perPersonPerHour)} AI requests an hour.`}
        {usage.refused > 0 && ` ${fmt(usage.refused)} request${usage.refused === 1 ? ' was' : 's were'} refused this month by a limit or a pause.`}
        {' '}Administrators are emailed at 80% and 100% of the allowance.
      </p>
    </Card>
  );
}
