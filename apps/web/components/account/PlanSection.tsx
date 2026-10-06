'use client';

import { useEffect, useState } from 'react';

import { Badge, Button, Card, Spinner } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { useAuth } from '@/lib/auth';
import { formatBytes } from '@/lib/myStorage';
import { feature, fetchMyAi, fetchMyPlan, setMyAi, type MyAi, type MyPlan } from '@/lib/personal';
import { YourDataCard } from '@/components/account/YourDataCard';

// ============================================================================
//  Account → Plan, for a personal account (build plan §4.2).
//
//  What the plan includes, in words; the AI switch with its confirmation and
//  trial status; Basic and Premium as "Coming soon" (no card form until
//  payments exist). Every number is the server's (GET /api/me/plan) — this
//  page describes the limits, it does not enforce them.
//
//  Wording here is customer-facing and DRAFT until Mr. Singh and Amit
//  approve it (build plan §10).
// ============================================================================

export function PlanSection({ onOpenStorage }: { onOpenStorage: () => void }) {
  const { authedFetch } = useAuth();
  const [plan, setPlan] = useState<MyPlan | null>(null);
  const [ai, setAi] = useState<MyAi | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([fetchMyPlan(authedFetch), fetchMyAi(authedFetch)])
      .then(([p, a]) => { setPlan(p); setAi(a); })
      .catch(() => setErr('Could not load your plan.'));
  }, [authedFetch]);

  async function switchAi(on: boolean, confirm: boolean) {
    setBusy(true); setErr(null);
    try {
      const a = await setMyAi(authedFetch, on, confirm);
      setAi(a);
      setConfirming(false);
      // The trial may have just started: the plan's AI line changes with it.
      setPlan(await fetchMyPlan(authedFetch));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (err && !plan) return <Card title="Your plan"><p className="mb-0 text-sm text-danger">{err}</p></Card>;
  if (!plan || !ai) return <Card title="Your plan"><Spinner /></Card>;

  const name = (plan.planName ?? 'Free').replace(/^Personal /, '');
  const people = feature(plan, 'connect.max_participants')?.limit;
  const minutes = feature(plan, 'connect.max_minutes')?.limit;
  const has = (code: string) => feature(plan, code)?.included ?? false;
  const perDay = feature(plan, 'mail.daily_recipients')?.limit;

  const included: [string, boolean][] = [
    [`${plan.storageBytes ? formatBytes(plan.storageBytes) : '—'} for mail and files together`, true],
    [people ? `Meetings with up to ${people} people` : 'Meetings of any size', true],
    [minutes ? `Meetings up to ${minutes} minutes` : 'Meetings with no time limit', true],
    ['Live captions', has('connect.captions')],
    ['Attendance record of who joined', has('connect.attendance')],
    ['Meeting recording', has('connect.recording')],
    ['Public share links in Space', has('space.public_links')],
    [perDay ? `Send to up to ${perDay} people a day` : 'Sending', true],
  ];

  const trialLine = ai.included && ai.trial?.active
    ? `AI trial: ${ai.trial.daysLeft} ${ai.trial.daysLeft === 1 ? 'day' : 'days'} left`
    : ai.trial && !ai.trial.active
      ? 'Trial used. Premium keeps AI minutes on.'
      : ai.included
        ? 'Included in Premium'
        : 'Switching AI on starts a free 15-day trial of AI meeting minutes.';

  return (
    <div className="flex flex-col gap-4">
      {err && <Alert tone="danger" onDismiss={() => setErr(null)}>{err}</Alert>}

      <Card title="Your plan" subtitle="What your account includes today.">
        <div className="mb-4 flex items-center gap-2">
          <span className="text-[1.5rem] font-semibold">{name}</span>
          <Badge tone="info">Current plan</Badge>
        </div>
        <ul className="mb-4 list-none space-y-2 p-0 text-sm">
          {included.map(([label, on]) => (
            <li key={label} className={`flex items-start gap-2 ${on ? 'text-ink' : 'text-ink-muted'}`}>
              <span aria-hidden="true" className={on ? 'text-ok' : 'text-ink-faint'}>{on ? '✓' : '–'}</span>
              <span>{label}{on ? '' : <span className="sr-only"> (not included)</span>}</span>
            </li>
          ))}
        </ul>
        <Button onClick={onOpenStorage}>See your storage</Button>
      </Card>

      <Card title="TatvaOS AI" subtitle="Minutes of the meetings you host, written by AI.">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">{ai.enabled ? 'On' : 'Off'}</div>
            <div className="text-sm text-ink-muted">{trialLine}</div>
          </div>
          {ai.enabled ? (
            <Button onClick={() => switchAi(false, false)} disabled={busy}>Switch off</Button>
          ) : (
            <Button variant="primary" onClick={() => (ai.confirmed ? switchAi(true, false) : setConfirming(true))} disabled={busy}>
              Switch on
            </Button>
          )}
        </div>
        {confirming && (
          <Alert tone="warn" title="Before you switch AI on">
            <p className="mb-3">{ai.confirmSentence}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => switchAi(true, true)} disabled={busy}>
                {busy ? <Spinner inline label="Working" /> : 'I agree, switch it on'}
              </Button>
              <Button onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
            </div>
          </Alert>
        )}
      </Card>

      <Card title="Upgrade" subtitle="More room, bigger meetings, recording and AI.">
        <div className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-2">
          {[
            { n: 'Basic', lines: ['5 GB of storage', 'Meetings up to 20 people, no time limit', 'Attendance record', 'Public share links'] },
            { n: 'Premium', lines: ['10 GB of storage', 'Meetings up to 50 people, no time limit', 'Meeting recording', 'AI meeting minutes'] },
          ].map((p) => (
            <div key={p.n} className="rounded-lg border border-line p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold">{p.n}</span>
                <Badge tone="neutral">Coming soon</Badge>
              </div>
              <ul className="mb-0 list-none space-y-1 p-0 text-sm text-ink-muted">
                {p.lines.map((l) => <li key={l}>{l}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <YourDataCard />
    </div>
  );
}
