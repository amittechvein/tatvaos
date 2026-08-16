'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  calendarApi, addDays, hhmm, repeatOptions, sameDay, startOfDay, startOfMonthGrid, startOfWeek,
  type CalendarEvent, type CalendarSummary,
} from '@/lib/calendar';
import { Icon } from '@/components/ui/Icon';

// ============================================================================
//  TatvaOS Calendar
// ============================================================================
//
//  Four views over ONE read. Day, week, month and agenda differ in how they
//  arrange a window, not in what they ask for — the API takes a from and a to
//  and expands recurrence inside it, so a "every weekday forever" meeting
//  costs the same as a one-off.
//
//  The current date is component state rather than the URL. The route names
//  the VIEW, which is what belongs in a link; "the week I had scrolled to"
//  is not something anybody shares.
// ============================================================================

type View = 'day' | 'week' | 'month' | 'agenda';

const HOUR_PX = 44;          // one hour of the day grid
const DAY_START = 0;         // the grid runs midnight to midnight, and scrolls
                             // to the working day on open — clipping to 08:00
                             // hides early meetings, which is worse.

export default function CalendarPage({ params }: { params: Promise<{ view: string }> }) {
  const { view: viewParam } = use(params);
  const view: View = (['day', 'week', 'month', 'agenda'] as const)
    .includes(viewParam as View) ? (viewParam as View) : 'week';

  const { authedFetch } = useAuth();

  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ start: Date; end: Date } | null>(null);
  const [open, setOpen] = useState<CalendarEvent | null>(null);

  // The window each view needs. Month asks for the whole grid, including the
  // trailing days of the previous month it displays — otherwise those cells
  // are silently empty.
  const [from, to] = useMemo<[Date, Date]>(() => {
    if (view === 'day') return [startOfDay(anchor), addDays(startOfDay(anchor), 1)];
    if (view === 'week') return [startOfWeek(anchor), addDays(startOfWeek(anchor), 7)];
    if (view === 'agenda') return [startOfDay(anchor), addDays(startOfDay(anchor), 30)];
    const gridStart = startOfMonthGrid(anchor);
    return [gridStart, addDays(gridStart, 42)];
  }, [view, anchor]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [cals, evs] = await Promise.all([
        calendarApi.calendars(authedFetch),
        calendarApi.events(authedFetch, from, to),
      ]);
      setCalendars(cals);
      setEvents(evs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your calendar.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch, from, to]);

  useEffect(() => { void load(); }, [load]);

  const shown = events.filter((e) => !hidden.has(e.calendarId));

  function step(direction: -1 | 1) {
    if (view === 'day') setAnchor((d) => addDays(d, direction));
    else if (view === 'week') setAnchor((d) => addDays(d, 7 * direction));
    else if (view === 'agenda') setAnchor((d) => addDays(d, 30 * direction));
    else setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + direction, 1));
  }

  const heading = view === 'month'
    ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : view === 'day'
      ? anchor.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `${from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${
          addDays(to, -1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  return (
    <div className="flex h-full flex-col gap-2 bg-canvas p-3">
      {/* ---- Toolbar ---- */}
      <header className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-4 py-2.5">
        <button type="button" onClick={() => setAnchor(startOfDay(new Date()))}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted transition hover:bg-canvas hover:text-ink">
          Today
        </button>
        <span className="flex items-center">
          <button type="button" aria-label="Previous" onClick={() => step(-1)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-canvas hover:text-ink">
            <Icon name="chevron-left" className="h-4 w-4" />
          </button>
          <button type="button" aria-label="Next" onClick={() => step(1)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-canvas hover:text-ink">
            <Icon name="chevron-right" className="h-4 w-4" />
          </button>
        </span>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">{heading}</h1>

        <button type="button"
                onClick={() => {
                  // A new event defaults to the next whole hour, one hour long
                  // — the overwhelmingly common shape, and it saves two edits.
                  const s = new Date();
                  s.setMinutes(0, 0, 0);
                  s.setHours(s.getHours() + 1);
                  setComposing({ start: s, end: new Date(s.getTime() + 60 * 60 * 1000) });
                }}
                className="rounded-full bg-brand-600 px-5 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700">
          Create
        </button>
      </header>

      {error && (
        <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* ---- Calendar list ---- */}
        <aside className="hidden w-56 shrink-0 flex-col overflow-y-auto rounded-card border border-line bg-surface p-3 lg:flex">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            My calendars
          </div>
          {calendars.map((c) => (
            <label key={c.id} className="mb-1.5 flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={!hidden.has(c.id)}
                onChange={() => setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                  return next;
                })}
                className="h-3.5 w-3.5 shrink-0"
                style={{ accentColor: c.colour }}
              />
              <span className="min-w-0 truncate">{c.name}</span>
              {c.kind === 'resource' && (
                <span className="shrink-0 text-[10px] text-ink-faint">room</span>
              )}
            </label>
          ))}
        </aside>

        {/* ---- The view ---- */}
        <section className="min-w-0 flex-1 overflow-hidden rounded-card border border-line bg-surface">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <span className="block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600" />
            </div>
          ) : view === 'month' ? (
            <MonthGrid from={from} anchor={anchor} events={shown} onOpen={setOpen}
                       onPick={(d) => setComposing({
                         start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9),
                         end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10),
                       })} />
          ) : view === 'agenda' ? (
            <AgendaList events={shown} onOpen={setOpen} />
          ) : (
            <TimeGrid days={view === 'day' ? 1 : 7} from={from} events={shown}
                      onOpen={setOpen}
                      onPick={(start) => setComposing({
                        start, end: new Date(start.getTime() + 60 * 60 * 1000),
                      })} />
          )}
        </section>
      </div>

      {composing && (
        <EventDialog
          start={composing.start}
          end={composing.end}
          calendars={calendars}
          onClose={() => setComposing(null)}
          onSaved={async () => { setComposing(null); await load(); }}
        />
      )}

      {open && (
        <EventDetail
          event={open}
          onClose={() => setOpen(null)}
          onChanged={async () => { setOpen(null); await load(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Day and week: a time grid
// ---------------------------------------------------------------------------
function TimeGrid({ days, from, events, onOpen, onPick }: {
  days: number;
  from: Date;
  events: CalendarEvent[];
  onOpen: (e: CalendarEvent) => void;
  onPick: (start: Date) => void;
}) {
  const columns = Array.from({ length: days }, (_, i) => addDays(from, i));
  const today = new Date();

  // Open on the working day rather than at midnight. The grid still HOLDS the
  // whole day — an 06:30 flight must not be invisible — it just does not open
  // there.
  useEffect(() => {
    const el = document.getElementById('cal-scroll');
    if (el) el.scrollTop = 7.5 * HOUR_PX;
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Day headings */}
      <div className="flex border-b border-line pl-14">
        {columns.map((d) => (
          <div key={d.toISOString()} className="flex-1 border-l border-line/60 px-2 py-2 text-center">
            <div className="text-xs text-ink-muted">
              {d.toLocaleDateString(undefined, { weekday: 'short' })}
            </div>
            <div className={`text-sm font-semibold ${
              sameDay(d, today) ? 'text-brand-600' : 'text-ink'}`}>
              {d.getDate()}
            </div>
          </div>
        ))}
      </div>

      <div id="cal-scroll" className="scroll-thin relative flex-1 overflow-y-auto">
        <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
          {/* Hour labels */}
          <div className="w-14 shrink-0">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="relative" style={{ height: HOUR_PX }}>
                <span className="absolute -top-2 right-2 text-[11px] text-ink-faint">
                  {h === 0 ? '' : `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`}
                </span>
              </div>
            ))}
          </div>

          {columns.map((day) => {
            const dayEvents = events.filter((e) => sameDay(new Date(e.startsAt), day));
            return (
              <div key={day.toISOString()} className="relative flex-1 border-l border-line/60">
                {/* Hour lines, and a click anywhere starts an event there */}
                {Array.from({ length: 24 }, (_, h) => (
                  <button
                    key={h}
                    type="button"
                    aria-label={`Add an event at ${h}:00`}
                    onClick={() => onPick(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h))}
                    className="block w-full border-b border-line/40 hover:bg-canvas/60"
                    style={{ height: HOUR_PX }}
                  />
                ))}

                {dayEvents.map((e) => {
                  const s = new Date(e.startsAt);
                  const f = new Date(e.endsAt);
                  const top = (s.getHours() + s.getMinutes() / 60 - DAY_START) * HOUR_PX;
                  const height = Math.max(18, ((f.getTime() - s.getTime()) / 3600000) * HOUR_PX);
                  return (
                    <button
                      key={`${e.id}-${e.occurrenceStartsAt ?? ''}`}
                      type="button"
                      onClick={() => onOpen(e)}
                      title={`${e.title} · ${hhmm(e.startsAt)}`}
                      className="absolute left-1 right-1 overflow-hidden rounded px-1.5 py-0.5 text-left text-[11px] text-white"
                      style={{
                        top, height,
                        background: e.colour,
                        // A declined meeting still shows — you may want to
                        // change your mind — but it stops shouting.
                        opacity: e.myResponse === 'declined' ? 0.45 : 1,
                      }}
                    >
                      <span className="block truncate font-semibold">{e.title}</span>
                      {height > 32 && <span className="block truncate">{hhmm(e.startsAt)}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Month
// ---------------------------------------------------------------------------
function MonthGrid({ from, anchor, events, onOpen, onPick }: {
  from: Date;
  anchor: Date;
  events: CalendarEvent[];
  onOpen: (e: CalendarEvent) => void;
  onPick: (day: Date) => void;
}) {
  const cells = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const today = new Date();

  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-7 border-b border-line">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="px-2 py-1.5 text-center text-xs text-ink-muted">{d}</div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6">
        {cells.map((day) => {
          const dayEvents = events.filter((e) => sameDay(new Date(e.startsAt), day));
          const outside = day.getMonth() !== anchor.getMonth();
          return (
            <div key={day.toISOString()}
                 className={`min-h-0 overflow-hidden border-b border-l border-line/60 p-1 ${
                   outside ? 'bg-canvas/40' : ''}`}>
              <button type="button" onClick={() => onPick(day)}
                      className={`mb-0.5 block w-full text-left text-xs ${
                        sameDay(day, today)
                          ? 'font-bold text-brand-600'
                          : outside ? 'text-ink-faint' : 'text-ink-muted'}`}>
                {day.getDate()}
              </button>
              {/* Three, then a count. A cell that lists ten is unreadable and
                  the row heights start fighting each other. */}
              {dayEvents.slice(0, 3).map((e) => (
                <button key={`${e.id}-${e.occurrenceStartsAt ?? ''}`} type="button"
                        onClick={() => onOpen(e)}
                        className="mb-0.5 block w-full truncate rounded px-1 text-left text-[11px] text-white"
                        style={{ background: e.colour, opacity: e.myResponse === 'declined' ? 0.45 : 1 }}>
                  {e.title}
                </button>
              ))}
              {dayEvents.length > 3 && (
                <span className="px-1 text-[10px] text-ink-faint">
                  +{dayEvents.length - 3} more
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Agenda — the next thirty days as a list
// ---------------------------------------------------------------------------
function AgendaList({ events, onOpen }: {
  events: CalendarEvent[];
  onOpen: (e: CalendarEvent) => void;
}) {
  if (events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-ink-faint">
        <Icon name="inbox" className="mb-3 h-10 w-10" />
        <p className="text-sm">Nothing in the next thirty days</p>
      </div>
    );
  }

  const byDay = events.reduce<Record<string, CalendarEvent[]>>((acc, e) => {
    const key = new Date(e.startsAt).toDateString();
    (acc[key] ??= []).push(e);
    return acc;
  }, {});

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      {Object.entries(byDay).map(([day, list]) => (
        <div key={day} className="border-b border-line/60">
          <div className="bg-canvas/50 px-4 py-1.5 text-xs font-semibold text-ink-muted">
            {new Date(day).toLocaleDateString(undefined,
              { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          {list.map((e) => (
            <button key={`${e.id}-${e.occurrenceStartsAt ?? ''}`} type="button"
                    onClick={() => onOpen(e)}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-canvas/60">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: e.colour }} />
              <span className="w-32 shrink-0 text-xs text-ink-muted">
                {e.isAllDay ? 'All day' : `${hhmm(e.startsAt)} – ${hhmm(e.endsAt)}`}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{e.title}</span>
              {e.location && (
                <span className="hidden w-40 shrink-0 truncate text-xs text-ink-faint sm:block">
                  {e.location}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Create
// ---------------------------------------------------------------------------
function EventDialog({ start, end, calendars, onClose, onSaved }: {
  start: Date;
  end: Date;
  calendars: CalendarSummary[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { authedFetch } = useAuth();
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [calendarId, setCalendarId] = useState(
    calendars.find((c) => c.isPrimary)?.id ?? calendars[0]?.id ?? '');
  const [startsAt, setStartsAt] = useState(toLocalInput(start));
  const [endsAt, setEndsAt] = useState(toLocalInput(end));
  const [allDay, setAllDay] = useState(false);
  const [rule, setRule] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(false);
  const [reminder, setReminder] = useState(10);
  const [guests, setGuests] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const options = repeatOptions(new Date(startsAt));

  async function save() {
    setBusy(true); setErr(null);
    try {
      await calendarApi.create(authedFetch, {
        calendarId: calendarId || undefined,
        title: title.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        isAllDay: allDay,
        // The BROWSER's zone, not the server's: an event created in Kolkata
        // is a Kolkata event even when the API runs elsewhere.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        recurrenceRule: rule,
        visibility: isPrivate ? 'private' : 'default',
        attendees: guests.split(/[,;\s]+/).filter((g) => g.includes('@'))
          .map((email) => ({ email })),
        reminderMinutes: [reminder],
      });
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the event.');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[1190] bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="fixed left-1/2 top-1/2 z-[1200] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-card border border-line bg-surface shadow-raised">
        <div className="max-h-[80vh] overflow-y-auto p-5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a title"
            autoFocus
            className="mb-4 w-full border-0 border-b border-line bg-transparent pb-2 text-lg text-ink outline-none placeholder:text-ink-faint focus:border-brand-600"
          />

          {err && <p className="mb-2 text-sm text-danger">{err}</p>}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)}
                   className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink" />
            <span className="text-sm text-ink-muted">to</span>
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
                   className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink" />
            <label className="flex items-center gap-1.5 text-sm text-ink-muted">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              All day
            </label>
          </div>

          <select value={rule ?? ''} onChange={(e) => setRule(e.target.value || null)}
                  className="mb-3 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
            {options.map((o) => (
              <option key={o.label} value={o.rule ?? ''}>{o.label}</option>
            ))}
          </select>

          <input value={guests} onChange={(e) => setGuests(e.target.value)}
                 placeholder="Guests — email addresses, separated by commas"
                 className="mb-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint" />

          <input value={location} onChange={(e) => setLocation(e.target.value)}
                 placeholder="Location or meeting link"
                 className="mb-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint" />

          <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                    placeholder="Description" rows={3}
                    className="mb-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint" />

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              Calendar
              <select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}
                      className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm text-ink-muted">
              Remind
              <select value={reminder} onChange={(e) => setReminder(Number(e.target.value))}
                      className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink">
                <option value={0}>At the time</option>
                <option value={5}>5 minutes before</option>
                <option value={10}>10 minutes before</option>
                <option value={30}>30 minutes before</option>
                <option value={60}>1 hour before</option>
                <option value={1440}>1 day before</option>
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-sm text-ink-muted">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
              Private
            </label>
          </div>

          {isPrivate && (
            <p className="mb-2 text-xs text-ink-muted">
              People you share this calendar with will see that the time is taken,
              but not the title, guests or description.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={onClose}
                  className="rounded-lg border border-line px-4 py-1.5 text-sm text-ink-muted hover:bg-canvas hover:text-ink">
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={busy || title.trim().length === 0}
                  className="rounded-full bg-brand-600 px-6 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
//  Open an event
// ---------------------------------------------------------------------------
function EventDetail({ event, onClose, onChanged }: {
  event: CalendarEvent;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { authedFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); await onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'That did not work.'); setBusy(false); }
  }

  async function remove() {
    // A series and one occurrence are different deletions, and getting it
    // wrong destroys a recurring meeting. So ask, rather than assume.
    if (event.isRecurring && event.occurrenceStartsAt) {
      const justThis = window.confirm(
        'Delete only this occurrence?\n\nOK — just this one.\nCancel — the whole repeating event.');
      await run(() => calendarApi.remove(authedFetch, event.id,
        justThis ? event.occurrenceStartsAt! : undefined));
      return;
    }
    if (!window.confirm(`Delete "${event.title}"?`)) return;
    await run(() => calendarApi.remove(authedFetch, event.id));
  }

  return (
    <>
      <div className="fixed inset-0 z-[1190] bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="fixed left-1/2 top-1/2 z-[1200] w-[min(460px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-card border border-line bg-surface shadow-raised">
        <div className="p-5">
          <div className="mb-3 flex items-start gap-3">
            <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ background: event.colour }} />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-ink">{event.title}</h2>
              <p className="text-sm text-ink-muted">
                {new Date(event.startsAt).toLocaleDateString(undefined,
                  { weekday: 'long', day: 'numeric', month: 'long' })}
                {!event.isAllDay && ` · ${hhmm(event.startsAt)} – ${hhmm(event.endsAt)}`}
              </p>
              {event.isRecurring && (
                <p className="text-xs text-ink-faint">{event.recurrenceText}</p>
              )}
            </div>
          </div>

          {err && <p className="mb-2 text-sm text-danger">{err}</p>}

          {event.location && (
            <p className="mb-2 text-sm text-ink"><span className="text-ink-muted">Where: </span>{event.location}</p>
          )}
          {event.description && (
            <p className="mb-2 whitespace-pre-wrap text-sm text-ink">{event.description}</p>
          )}

          {event.attendees.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-xs font-semibold text-ink-muted">
                {event.attendees.length} guest{event.attendees.length === 1 ? '' : 's'}
              </div>
              {event.attendees.map((a) => (
                <div key={a.email} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink">{a.displayName ?? a.email}</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {a.status === 'needs-action' ? 'no answer yet' : a.status}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Invited, not organising: answer it. */}
          {!event.isOrganiser && event.myResponse && (
            <div className="mt-3 flex gap-2">
              {(['accepted', 'tentative', 'declined'] as const).map((s) => (
                <button key={s} type="button" disabled={busy}
                        onClick={() => void run(() => calendarApi.respond(authedFetch, event.id, s))}
                        className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                          event.myResponse === s
                            ? 'border-brand-600 bg-brand-50 text-brand-600'
                            : 'border-line text-ink-muted hover:bg-canvas hover:text-ink'}`}>
                  {s === 'accepted' ? 'Yes' : s === 'tentative' ? 'Maybe' : 'No'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-between border-t border-line px-5 py-3">
          {event.isOrganiser ? (
            <button type="button" disabled={busy} onClick={() => void remove()}
                    className="text-sm text-danger hover:underline">
              Delete
            </button>
          ) : <span />}
          <button type="button" onClick={onClose}
                  className="rounded-lg border border-line px-4 py-1.5 text-sm text-ink-muted hover:bg-canvas hover:text-ink">
            Close
          </button>
        </div>
      </div>
    </>
  );
}

/** Date → the value a datetime-local input wants, in LOCAL time. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
       + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
