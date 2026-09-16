'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Input } from '@/components/ui/Form';
import { Alert, PageHeader } from '@/components/ui/Page';
import {
  connectApi, prettyCode, whenLabel,
  type Meeting, type MeetingStatus,
} from '@/lib/connect';
import { faceOf, toneOf } from './ConnectSkin';

// ============================================================================
//  Connect — the front door
// ============================================================================
//
//  Three things a person actually arrives here to do: start a meeting now,
//  join one somebody sent them, and see what is coming. They are in that
//  order down the page because that is their frequency, not their importance.
//
//  "Happening now" is its own section rather than a badge in a list. A meeting
//  that is live is the only row anybody wants when there is one, and burying
//  it among tomorrow's is how people end up late to a call they were looking
//  straight at.
// ============================================================================

type Range = 'upcoming' | 'today' | 'past';

const TABS: { key: Range; label: string }[] = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'today', label: 'Today' },
  { key: 'past', label: 'Past' },
];

function tone(status: MeetingStatus) {
  switch (status) {
    case 'active': return 'ok' as const;
    case 'scheduled': return 'info' as const;
    case 'cancelled': return 'danger' as const;
    default: return 'neutral' as const;
  }
}

export default function ConnectHome() {
  const { authedFetch } = useAuth();
  const router = useRouter();

  const [range, setRange] = useState<Range>('upcoming');
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await connectApi.list(authedFetch, range);
      setMeetings(page.meetings);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your meetings.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch, range]);

  useEffect(() => { void load(); }, [load]);

  // A meeting that is live right now, wherever it appears in the list.
  const live = meetings.filter((m) => m.status === 'active');
  const rest = meetings.filter((m) => m.status !== 'active');

  async function startNow() {
    setStarting(true);
    setError(null);
    try {
      const m = await connectApi.create(authedFetch, { title: 'Meeting', kind: 'instant' });
      router.push(`/connect/room/${m.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start a meeting.');
      setStarting(false);
    }
  }

  // Codes get read off a screen and typed by hand, often from a phone, and
  // people paste the whole link at least as often as the code.
  //
  // Order matters: take the last path segment FIRST, then strip. Stripping
  // first turns "https://connect.tatvaos.com/connect/room/AbC" into one long
  // run of letters — which is exactly what the field promised would work.
  function goToCode(e: React.FormEvent) {
    e.preventDefault();
    const raw = code.trim().split(/[?#]/)[0] ?? '';
    const last = raw.split('/').filter(Boolean).pop() ?? '';
    const cleaned = last.replace(/[^A-Za-z0-9_-]/g, '');
    if (cleaned.length === 0) return;
    router.push(`/connect/room/${cleaned}`);
  }

  return (
    <>
      <PageHeader
        title="Meetings"
        breadcrumb={[{ label: 'Connect' }]}
        className="!my-[1rem]"
        actions={
          <>
            <Button variant="primary" onClick={() => void startNow()} disabled={starting}>
              <i className="ri-vidicon-line me-1" />
              {starting ? 'Starting…' : 'Start now'}
            </Button>
            <Button href="/connect/new">
              <i className="ri-calendar-line me-1" />
              Schedule
            </Button>
          </>
        }
      />

      {error && (
        <Alert tone="danger" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
          {error}
        </Alert>
      )}

      {/* Two thirds and a third on a wide screen, stacked below it. Twelfths
          are the counts overrides.css re-declares; an arbitrary template
          would be flattened by YZEN's own .grid. */}
      <div className="grid !gap-[1.5rem] xl:grid-cols-12">
        <div className="xl:col-span-8">
          {live.length > 0 && (
            <Card title="Happening now" className="cx-live !mb-[1rem]">
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
                        {m.hasPassword && (
                          <span><i className="ri-lock-line" /> Password</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Button variant="primary" href={`/connect/room/${m.code}`}>
                    <i className="ri-vidicon-line me-1" />
                    Join
                  </Button>
                </div>
              ))}
            </Card>
          )}

          <Card padded={false}>
            {/* Pill tabs as BUTTONS, not Tabs from the kit: those are links to
                URLs, and this range is page state, not a route. */}
            <div className="flex flex-wrap items-center gap-1 border-b border-line px-5 py-3" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={range === t.key}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${range === t.key
                    ? 'bg-brand-500 text-white'
                    : 'text-ink-muted hover:bg-canvas hover:text-ink'}`}
                  onClick={() => setRange(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="!p-[1.5rem] text-center !text-ink-muted">
                <Spinner inline />
                Loading…
              </div>
            ) : rest.length === 0 && live.length === 0 ? (
              <Empty
                title={range === 'past' ? 'No past meetings yet' : 'Nothing scheduled'}
                hint={range === 'past'
                  ? 'Meetings appear here once they have finished.'
                  : 'Start one now, or schedule it for later and send the link.'}
                action={<Button variant="primary" href="/connect/new">Schedule a meeting</Button>}
              />
            ) : (
              <Table head={['Meeting', 'When', 'Code', 'Status', '']}>
                {rest.map((m) => (
                  <tr key={m.id}>
                    <Td>
                      <div className="cx-who">
                        <span className={`cx-face ${toneOf(m.id)}`} aria-hidden="true">
                          {faceOf(m.title)}
                        </span>
                        <div>
                          <Link href={`/connect/meetings/${m.id}`} className="cx-name">
                            {m.title}
                          </Link>
                          {m.hasPassword && (
                            <i className="ri-lock-line ms-1 !text-ink-muted" title="Password required" />
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td className="!text-ink-muted">{whenLabel(m)}</Td>
                    <Td><span className="cx-code">{prettyCode(m.code)}</span></Td>
                    <Td><Badge tone={tone(m.status)}>{m.status}</Badge></Td>
                    <Td className="text-end">
                      {m.status === 'scheduled' || m.status === 'active' ? (
                        <Button href={`/connect/room/${m.code}`}>Join</Button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <div className="xl:col-span-4">
          <Card title="Join a meeting" subtitle="Paste a code or a link somebody sent you">
            <form onSubmit={goToCode}>
              <div className="flex items-stretch">
                <Input
                  className="rounded-r-none"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Meeting code"
                  aria-label="Meeting code"
                  spellCheck={false}
                  autoComplete="off"
                />
                <Button variant="primary" type="submit" className="rounded-l-none"
                        disabled={code.trim().length === 0}>
                  Join
                </Button>
              </div>
              <div className="!text-ink-muted !text-[0.75rem] mt-2">
                A full link works too — everything after the last slash is the code.
              </div>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
