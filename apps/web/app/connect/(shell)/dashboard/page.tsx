'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Button, Card, Spinner } from '@/components/ui/Kit';
import { Alert, PageHeader } from '@/components/ui/Page';
import { connectApi, prettyCode, whenLabel, type Meeting } from '@/lib/connect';
import { faceOf, toneOf } from '../ConnectSkin';

// ============================================================================
//  Connect at a glance.
// ============================================================================
//
//  A dashboard earns its place by answering questions somebody actually
//  arrives with, in the order they arrive with them:
//
//    1. Is something happening right now that I should be in?
//    2. What is coming, and how soon?
//    3. Is anything set up in a way I would not have chosen?
//    4. How much are we actually using this?
//
//  In that order, and nothing else. Every number here is derived from the
//  three meeting lists the product already serves — no new endpoint, and no
//  metric invented because it was easy to compute. A dashboard full of
//  numbers nobody acts on is a slower way of learning nothing.
//
//  ─────────────────────────────────────────────────────────────────────────
//  THE CHART.
//
//  One series — meetings a day — so there is no legend: the card title names
//  it, and a legend box for one thing is furniture. Bars because the days are
//  discrete counts; a line would imply that 1.5 meetings happened on Tuesday
//  afternoon.
//
//  The green is #07834c in light and #17a06b in dark. Both were CHECKED, not
//  chosen by eye: the brand colour AT THE TIME was green #03b562, which comes
//  out at 2.7:1 against white — under the 3:1 a chart mark needs — and the
//  obvious dark-mode brightening lands outside the readable lightness band.
//  Two greens, both measured, is the honest answer; one green that looks fine
//  on the machine it was picked on is not.
//
//  5 Sept 2026: THE PREMISE HAS CHANGED. The brand is now violet #6C3CE9,
//  which measures about 6.1:1 against white and clears 3:1 comfortably — so
//  the reason these marks diverge from the brand no longer holds. They are
//  deliberately LEFT AS THEY ARE, because they are Connect's chart colours and
//  changing them changes every chart; that is Connect's call to make and
//  measure, not a side effect of a palette change. Flagged, not touched.
// ============================================================================

const DAYS = 14;

interface Day { key: string; label: string; short: string; count: number }

/** The last DAYS days, oldest first, with zero-meeting days present. Missing
 *  days silently dropped is how a quiet week reads as a busy one. */
function byDay(meetings: Meeting[]): Day[] {
  const days: Day[] = [];
  const now = new Date();

  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push({
      key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
      label: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
      short: d.toLocaleDateString(undefined, { day: 'numeric' }),
      count: 0,
    });
  }

  const index = new Map(days.map((d) => [d.key, d]));
  for (const m of meetings) {
    // When it actually ran, falling back to when it was meant to. A meeting
    // moved by an hour belongs on the day it happened.
    const iso = m.startedAt ?? m.scheduledStart;
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const hit = index.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    if (hit) hit.count += 1;
  }
  return days;
}

/** Total hours of meeting, from the times the media server actually reported. */
function hoursOf(meetings: Meeting[]): number {
  let ms = 0;
  for (const m of meetings) {
    if (!m.startedAt || !m.endedAt) continue;
    const a = new Date(m.startedAt).getTime();
    const b = new Date(m.endedAt).getTime();
    if (Number.isNaN(a) || Number.isNaN(b) || b <= a) continue;
    ms += b - a;
  }
  return ms / 3_600_000;
}

export default function DashboardPage() {
  const { authedFetch } = useAuth();
  const [upcoming, setUpcoming] = useState<Meeting[]>([]);
  const [today, setToday] = useState<Meeting[]>([]);
  const [past, setPast] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Three requests, in parallel rather than in sequence: they do not
      // depend on each other and the page is not readable until all three
      // land, so waiting for them one at a time is three times the wait for
      // no benefit.
      const [u, t, p] = await Promise.all([
        connectApi.list(authedFetch, 'upcoming'),
        connectApi.list(authedFetch, 'today'),
        connectApi.list(authedFetch, 'past'),
      ]);
      setUpcoming(u.meetings);
      setToday(t.meetings);
      setPast(p.meetings);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your meetings.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const live = [...today, ...upcoming].filter((m) => m.status === 'active');

  const soon = upcoming
    .filter((m) => m.status === 'scheduled' && m.scheduledStart !== null)
    .sort((a, b) => (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? ''));

  const weekAhead = soon.filter((m) => {
    const t = new Date(m.scheduledStart ?? '').getTime();
    return !Number.isNaN(t) && t - Date.now() < 7 * 86_400_000;
  });

  // The door open: no waiting room AND guests allowed, on a meeting that has
  // not happened yet. Both halves matter — either alone is a normal choice.
  const openDoor = [...soon, ...today].filter(
    (m) => m.waitingRoom === 'off' && m.allowGuests && m.status !== 'ended');

  const days = byDay(past);
  const busiest = days.reduce((a, b) => (b.count > a.count ? b : a), days[0] ?? { count: 0 } as Day);
  const peak = Math.max(1, busiest.count);
  const heldHours = hoursOf(past);

  return (
    <>
      <PageHeader
        title="Connect"
        breadcrumb={[{ label: 'Dashboard' }]}
        className="!my-[1rem]"
        actions={
          <>
            <Button variant="primary" href="/connect/new">
              <i className="ri-calendar-line me-1" />
              Schedule
            </Button>
            <Button href="/connect">Meetings</Button>
          </>
        }
      />

      {error && (
        <Alert tone="danger" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Card><div className="text-center !text-ink-muted !py-[1.5rem]">
          <Spinner inline />
          Loading…
        </div></Card>
      ) : (
        <>
          {/* ── 1. NUMBERS THAT ANSWER A QUESTION. ────────────────────────
              Four, not eight. Every one of these changes what somebody does
              next; anything that does not is a number for its own sake. */}
          <div className="cx-tiles">
            <Tile label="Happening now" value={String(live.length)}
                  tone={live.length > 0 ? 'live' : undefined}
                  note={live.length > 0 ? 'Join from the list below' : 'Nothing running'} />
            <Tile label="Today" value={String(today.length)}
                  note={today.length === 1 ? 'meeting scheduled' : 'meetings scheduled'} />
            <Tile label="Next 7 days" value={String(weekAhead.length)}
                  note={soon.length > weekAhead.length
                    ? `${soon.length - weekAhead.length} further out`
                    : 'everything scheduled'} />
            <Tile label="Held in 14 days" value={heldHours >= 10
              ? `${Math.round(heldHours)}h`
              : `${heldHours.toFixed(1)}h`}
                  note={`across ${past.length} ${past.length === 1 ? 'meeting' : 'meetings'}`} />
          </div>

          {/* ── 2. THE ONE THING THAT IS ACTIONABLE RIGHT NOW. ───────────── */}
          {live.length > 0 && (
            <Card title="Happening now" className="cx-live">
              {live.map((m) => (
                <div key={m.id} className="cx-liverow">
                  <div className="cx-who">
                    <span className={`cx-face cx-face--lg ${toneOf(m.id)}`} aria-hidden="true">
                      {faceOf(m.title)}
                    </span>
                    <div>
                      <Link href={`/connect/meetings/${m.id}`} className="cx-name">{m.title}</Link>
                      <div className="cx-sub">
                        <span className="cx-code">{prettyCode(m.code)}</span>
                      </div>
                    </div>
                  </div>
                  <Button variant="primary" href={`/connect/room/${m.code}`}>
                    <i className="ri-vidicon-line me-1" />Join
                  </Button>
                </div>
              ))}
            </Card>
          )}

          {/* ── 3. ANYTHING SET UP IN A WAY THEY WOULD NOT HAVE CHOSEN. ──── */}
          {openDoor.length > 0 && (
            <div className="cx-opendoor">
              <div>
                <strong>
                  {openDoor.length === 1
                    ? 'One meeting has its door open.'
                    : `${openDoor.length} meetings have their doors open.`}
                </strong>
                <p>
                  The waiting room is off and guests are allowed, so anybody
                  holding the link walks in under any name they type — including
                  whoever it was forwarded to.
                </p>
                <div className="cx-doorlist">
                  {openDoor.slice(0, 4).map((m) => (
                    <Link key={m.id} href={`/connect/meetings/${m.id}`}>{m.title}</Link>
                  ))}
                  {openDoor.length > 4 && <span>and {openDoor.length - 4} more</span>}
                </div>
              </div>
            </div>
          )}

          <div className="grid !gap-[1.5rem] xl:grid-cols-12">
            <div className="xl:col-span-7">
              {/* ── 4. USE OVER TIME. ─────────────────────────────────────
                  One series, so no legend — the card title names it. The
                  busiest day is labelled and the others are not: a number on
                  every bar is fourteen numbers nobody reads. */}
              <Card title="Meetings a day"
                    subtitle={`The last ${DAYS} days${busiest.count > 0
                      ? ` · busiest was ${busiest.count} on ${busiest.label}`
                      : ''}`}>
                {past.length === 0 ? (
                  <p className="!text-ink-muted !text-[0.8125rem] mb-0">
                    Nothing has finished yet, so there is nothing to count.
                  </p>
                ) : (
                  <>
                    <div className="cx-chart" role="img"
                         aria-label={`Meetings a day for the last ${DAYS} days. `
                           + days.map((d) => `${d.label}: ${d.count}`).join('. ')}>
                      {days.map((d) => (
                        <div className="cx-bar-slot" key={d.key}>
                          <div className="cx-bar-wrap">
                            <div className={`cx-bar${d.count === 0 ? ' is-zero' : ''}`}
                                 style={{ height: `${(d.count / peak) * 100}%` }}>
                              <span className="cx-bar-tip">
                                {d.count} {d.count === 1 ? 'meeting' : 'meetings'}
                                <small>{d.label}</small>
                              </span>
                            </div>
                          </div>
                          <span className="cx-bar-day">{d.short}</span>
                        </div>
                      ))}
                    </div>

                    {/* The same numbers as text. A chart that only exists as
                        shapes is unreadable to a screen reader and unusable in
                        a printout. */}
                    <table className="!sr-only">
                      <caption>Meetings a day for the last {DAYS} days</caption>
                      <tbody>
                        {days.map((d) => (
                          <tr key={d.key}><th scope="row">{d.label}</th><td>{d.count}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </Card>
            </div>

            <div className="xl:col-span-5">
              <Card title="Coming up"
                    subtitle={soon.length === 0 ? undefined : 'The next few, soonest first'}>
                {soon.length === 0 ? (
                  <p className="!text-ink-muted !text-[0.8125rem] mb-0">
                    Nothing scheduled. <Link href="/connect/new">Schedule a meeting</Link>.
                  </p>
                ) : (
                  <div className="cx-nextlist">
                    {soon.slice(0, 5).map((m) => (
                      <div className="cx-next" key={m.id}>
                        <span className={`cx-face ${toneOf(m.id)}`} aria-hidden="true">
                          {faceOf(m.title)}
                        </span>
                        <div>
                          <Link href={`/connect/meetings/${m.id}`} className="cx-name">
                            {m.title}
                          </Link>
                          <div className="cx-sub">{whenLabel(m)}</div>
                        </div>
                        <Button href={`/connect/room/${m.code}`}>Join</Button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
/** A number that answers a question, with the question above it. */
function Tile({ label, value, note, tone }: {
  label: string;
  value: string;
  note?: string;
  tone?: 'live';
}) {
  return (
    <div className={`cx-tile${tone === 'live' ? ' cx-tile--live' : ''}`}>
      <span className="cx-tile-label">{label}</span>
      <strong className="cx-tile-value">{value}</strong>
      {note && <span className="cx-tile-note">{note}</span>}
    </div>
  );
}
