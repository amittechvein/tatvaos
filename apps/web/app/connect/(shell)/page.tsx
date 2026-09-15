'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Table, Td } from '@/components/ui/Kit';
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
      <div className="page-header-breadcrumb !flex !items-center !justify-between flex-wrap gap-2 !my-[1rem]">
        <div>
          <h1 className="page-title !font-semibold !text-[1.25rem] mb-1">Meetings</h1>
          <ol className="breadcrumb mb-0">
            <li className="breadcrumb-item active" aria-current="page">Connect</li>
          </ol>
        </div>
        <div className="!flex gap-2 flex-wrap">
          <Button variant="primary" onClick={() => void startNow()} disabled={starting}>
            <i className="ri-vidicon-line me-1" />
            {starting ? 'Starting…' : 'Start now'}
          </Button>
          <Button href="/connect/new">
            <i className="ri-calendar-line me-1" />
            Schedule
          </Button>
        </div>
      </div>

      {error && (
        <div className="alert alert-danger !flex !items-center !justify-between" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm btn-light" onClick={() => void load()}>Try again</button>
        </div>
      )}

      <div className="row">
        <div className="col-xl-8">
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
            <div className="card-header !justify-between !items-center">
              <ul className="nav nav-pills gap-1" role="tablist">
                {TABS.map((t) => (
                  <li className="nav-item" key={t.key} role="presentation">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={range === t.key}
                      className={`nav-link${range === t.key ? ' active' : ''}`}
                      onClick={() => setRange(t.key)}
                    >
                      {t.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {loading ? (
              <div className="!p-[1.5rem] text-center !text-ink-muted">
                <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
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

        <div className="col-xl-4">
          <Card title="Join a meeting" subtitle="Paste a code or a link somebody sent you">
            <form onSubmit={goToCode}>
              <div className="input-group">
                <input
                  className="form-control"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Meeting code"
                  aria-label="Meeting code"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button className="btn btn-primary" type="submit" disabled={code.trim().length === 0}>
                  Join
                </button>
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
