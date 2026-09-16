'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Spinner, Table, Td } from '@/components/ui/Kit';
import { Alert, PageHeader } from '@/components/ui/Page';
import { Modal } from '@/components/ui/Modal';
import {
  connectApi, durationLabel, minutesApi, prettyCode, recordingApi, sizeLabel,
  timeLabel, whenLabel,
  type Meeting, type RecordingListItem,
} from '@/lib/connect';
import { faceOf, toneOf } from './ConnectSkin';

// ============================================================================
//  What already happened — three rails, one list.
// ============================================================================
//
//  Past meetings, Recordings and Minutes are the same question asked three
//  ways: "show me the meetings that are over, and let me get at THIS from
//  them". So they are one component with three row actions rather than three
//  screens that would drift apart the first time somebody fixed a date format.
//
//  ─────────────────────────────────────────────────────────────────────────
//  WHY NOTHING IS FETCHED PER MEETING UNTIL IT IS ASKED FOR.
//
//  There is no endpoint that lists an organisation's recordings — recordings
//  are listed per meeting, and notes are read per meeting. The tempting build
//  is to load the page of meetings and then fire one request per row to fill
//  in the columns. On a page of twenty that is twenty-one requests to render
//  a list, most of them answering "no, nothing here", and it gets worse
//  exactly as a customer gets more valuable.
//
//  So a row loads its own contents when it is opened, and not before. The
//  page costs one request; a person who opens three rows costs three more.
//
//  A proper /connect/recordings endpoint would be better and belongs to Core,
//  because the interesting part of it is the authorisation — a recording is
//  readable by people who were IN that meeting, not by everyone in the
//  organisation, and getting that wrong is a data leak rather than a bug.
//  When it exists this file loses its lazy loading and keeps its shape.
// ============================================================================

export type HistoryMode = 'past' | 'recordings' | 'minutes';

const TITLES: Record<HistoryMode, { title: string; blurb: string }> = {
  past: {
    title: 'Past meetings',
    blurb: 'Everything that has finished, newest first.',
  },
  recordings: {
    title: 'Recordings',
    blurb: 'Open a meeting to see what was recorded and to download it.',
  },
  minutes: {
    title: 'Minutes',
    blurb: 'Read what was decided, without leaving this page.',
  },
};

export default function History({ mode }: { mode: HistoryMode }) {
  const { authedFetch } = useAuth();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Which row is expanded, and what it holds. One at a time: this is a list
  // to scan, and several open rows turn it back into a wall.
  const [openId, setOpenId] = useState<string | null>(null);
  const [items, setItems] = useState<RecordingListItem[] | null>(null);
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  // The minutes of one meeting, read on demand.
  const [minutes, setMinutes] = useState<{ title: string; text: string } | null>(null);
  const [minutesBusy, setMinutesBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await connectApi.list(authedFetch, 'past');
      setMeetings(page.meetings);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your meetings.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  async function openRecordings(m: Meeting) {
    if (openId === m.id) { setOpenId(null); return; }
    setOpenId(m.id);
    setItems(null);
    setRowError(null);
    setRowBusy(true);
    try {
      const list = await recordingApi.list(authedFetch, m.id);
      setItems(list.items);
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'Could not load the recordings.');
    } finally {
      setRowBusy(false);
    }
  }

  async function openMinutes(m: Meeting) {
    setMinutesBusy(m.id);
    setError(null);
    try {
      const text = await minutesApi.read(authedFetch, m.id);
      setMinutes({ title: m.title, text });
    } catch (e) {
      // The server's own sentence, which distinguishes "no notes were written"
      // from "something failed" — two situations a generic message would make
      // look identical.
      setError(e instanceof Error ? e.message : 'Could not open the minutes.');
    } finally {
      setMinutesBusy(null);
    }
  }

  const copy = TITLES[mode];

  return (
    <>
      <PageHeader
        title={copy.title}
        breadcrumb={[{ label: 'Connect', href: '/connect' }, { label: copy.title }]}
        className="my-4"
        actions={
          <Button variant="primary" href="/connect/new">
            <i className="ri-calendar-line me-1" />
            Schedule
          </Button>
        }
      />

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

      <Card subtitle={copy.blurb} padded={false} title={copy.title}>
        {loading ? (
          <div className="p-6 text-center text-ink-muted">
            <Spinner inline className="mr-2" />
            Loading…
          </div>
        ) : meetings.length === 0 ? (
          <Empty
            title="Nothing here yet"
            hint="Meetings appear here once they have finished."
            action={<Button variant="primary" href="/connect/new">Schedule a meeting</Button>}
          />
        ) : (
          <Table head={['Meeting', 'When', 'Code', 'Status', '']}>
            {meetings.map((m) => (
              // A fragment per meeting: the expanded panel is a SECOND row in
              // the same table, so it lines up with the columns above it
              // rather than floating in its own box.
              <Row key={m.id}
                   m={m}
                   mode={mode}
                   open={openId === m.id}
                   items={items}
                   rowBusy={rowBusy}
                   rowError={rowError}
                   minutesBusy={minutesBusy === m.id}
                   onRecordings={() => void openRecordings(m)}
                   onMinutes={() => void openMinutes(m)} />
            ))}
          </Table>
        )}
      </Card>

      {minutes && (
        <Modal
          title="Minutes of the meeting"
          subtitle={minutes.title}
          size="lg"
          onClose={() => setMinutes(null)}
          footer={<Button onClick={() => setMinutes(null)}>Close</Button>}
        >
          <div className="cx-mom">{minutes.text}</div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function Row({
  m, mode, open, items, rowBusy, rowError, minutesBusy, onRecordings, onMinutes,
}: {
  m: Meeting;
  mode: HistoryMode;
  open: boolean;
  items: RecordingListItem[] | null;
  rowBusy: boolean;
  rowError: string | null;
  minutesBusy: boolean;
  onRecordings: () => void;
  onMinutes: () => void;
}) {
  return (
    <>
      <tr>
        <Td>
          <div className="cx-who">
            <span className={`cx-face ${toneOf(m.id)}`} aria-hidden="true">
              {faceOf(m.title)}
            </span>
            <div>
              <Link href={`/connect/meetings/${m.id}`} className="cx-name">{m.title}</Link>
            </div>
          </div>
        </Td>
        <Td className="text-ink-muted">{whenLabel(m)}</Td>
        <Td><span className="cx-code">{prettyCode(m.code)}</span></Td>
        <Td><Badge tone={m.status === 'cancelled' ? 'danger' : 'neutral'}>{m.status}</Badge></Td>
        <Td className="text-end">
          {mode === 'recordings' && (
            <Button onClick={onRecordings}>
              {open ? 'Hide' : 'Recordings'}
            </Button>
          )}
          {mode === 'minutes' && (
            <Button variant="primary" disabled={minutesBusy} onClick={onMinutes}>
              {minutesBusy ? 'Opening…' : 'View minutes'}
            </Button>
          )}
          {mode === 'past' && (
            <Button href={`/connect/meetings/${m.id}`}>Open</Button>
          )}
        </Td>
      </tr>

      {mode === 'recordings' && open && (
        <tr className="cx-drawer-row">
          {/* A raw td, not Td: this one needs colSpan, and Td does not take
              one. Without it the drawer lands under the first column and
              reads as a broken cell rather than a panel. */}
          <td colSpan={5} className="cx-drawer">
            {rowBusy ? (
              <span className="text-ink-muted text-[0.8125rem]">
                <Spinner inline className="mr-2" />
                Loading…
              </span>
            ) : rowError ? (
              <span className="text-danger text-[0.8125rem]">{rowError}</span>
            ) : !items || items.length === 0 ? (
              <span className="text-ink-muted text-[0.8125rem]">Nothing was recorded in this meeting.</span>
            ) : (
              <div className="cx-recs">
                {items.map((it) => (
                  <div className="cx-rec" key={it.recording.id}>
                    <div>
                      <strong>{it.recording.mode === 'video' ? 'Video' : 'Audio'}</strong>
                      <span>
                        {durationLabel(it.recording.durationMs)}
                        {' · '}
                        {sizeLabel(it.recording.sizeBytes)}
                        {it.recording.startedAt ? ` · ${timeLabel(it.recording.startedAt)}` : ''}
                      </span>
                    </div>
                    <Button href={`/connect/meetings/${m.id}`}>Open meeting</Button>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
