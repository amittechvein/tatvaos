// ============================================================================
//  TatvaOS Calendar — API client
// ============================================================================
//
//  Every view asks the same question — what is on between these two instants
//  — so there is one read: events(from, to). Recurrence is expanded by the
//  server inside that window, which is why a "repeat forever" event costs the
//  same as any other.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface CalendarSummary {
  id: string;
  name: string;
  description: string | null;
  colour: string;
  kind: 'personal' | 'organisation' | 'resource';
  timezone: string;
  isPrimary: boolean;
  isOwn: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  calendarName: string | null;
  colour: string;
  title: string;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  timezone: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  transparency: 'opaque' | 'transparent';
  isRecurring: boolean;
  recurrenceRule: string | null;
  /** Server-built sentence — one wording for a rule everywhere it appears. */
  recurrenceText: string;
  /** Which occurrence of a series this row is; null for a one-off. */
  occurrenceStartsAt: string | null;
  isOrganiser: boolean;
  myResponse: 'needs-action' | 'accepted' | 'declined' | 'tentative' | null;
  attendees: { email: string; displayName: string | null; role: string; status: string }[];
}

export interface BusyBlock { startsAt: string; endsAt: string }

async function json<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? fallback);
  }
  return res.json() as Promise<T>;
}

export const calendarApi = {
  calendars: (f: AuthedFetch) =>
    f('/calendar/calendars')
      .then((r) => json<{ calendars: CalendarSummary[] }>(r, 'Could not load your calendars.'))
      .then((b) => b.calendars),

  createCalendar: (f: AuthedFetch, name: string, colour: string, kind: CalendarSummary['kind']) =>
    f('/calendar/calendars', { method: 'POST', body: JSON.stringify({ name, colour, kind }) })
      .then((r) => json<CalendarSummary>(r, 'Could not create the calendar.')),

  events: (f: AuthedFetch, from: Date, to: Date, calendarId?: string) =>
    f(`/calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`
      + (calendarId ? `&calendarId=${calendarId}` : ''))
      .then((r) => json<{ events: CalendarEvent[] }>(r, 'Could not load events.'))
      .then((b) => b.events),

  create: (f: AuthedFetch, body: {
    calendarId?: string;
    title: string;
    description?: string;
    location?: string;
    startsAt: string;
    endsAt: string;
    isAllDay?: boolean;
    timezone?: string;
    recurrenceRule?: string | null;
    visibility?: 'default' | 'private';
    attendees?: { email: string; displayName?: string; optional?: boolean }[];
    reminderMinutes?: number[];
  }) =>
    f('/calendar/events', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ id: string; uid: string; title: string }>(r, 'Could not create the event.')),

  update: (f: AuthedFetch, id: string, body: {
    title?: string; description?: string; location?: string;
    startsAt?: string; endsAt?: string; status?: string;
    /** Present = change ONLY this occurrence of a series. */
    occurrenceStartsAt?: string;
  }) =>
    f(`/calendar/events/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      .then((r) => json<unknown>(r, 'Could not save the change.')),

  remove: (f: AuthedFetch, id: string, occurrenceStartsAt?: string) =>
    f(`/calendar/events/${id}` + (occurrenceStartsAt ? `?occurrenceStartsAt=${occurrenceStartsAt}` : ''),
      { method: 'DELETE' })
      .then((r) => json<{ cancelled: string }>(r, 'Could not delete the event.')),

  respond: (f: AuthedFetch, id: string, status: 'accepted' | 'declined' | 'tentative') =>
    f(`/calendar/events/${id}/respond`, { method: 'POST', body: JSON.stringify({ status }) })
      .then((r) => json<{ status: string }>(r, 'Could not save your answer.')),

  /** Busy blocks only — no titles. That is the whole point of the endpoint. */
  freeBusy: (f: AuthedFetch, userIds: string[], from: Date, to: Date) =>
    f(`/calendar/freebusy?userIds=${userIds.join(',')}`
      + `&from=${from.toISOString()}&to=${to.toISOString()}`)
      .then((r) => json<{ people: { userId: string; busy: BusyBlock[] }[] }>(
        r, 'Could not check availability.'))
      .then((b) => b.people),
};

// ---------------------------------------------------------------------------
//  Date helpers — the calendar's whole job is arithmetic on these
// ---------------------------------------------------------------------------

export function startOfDay(d: Date): Date {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}

/** Monday-based: the working week is what a business calendar shows. */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function startOfMonthGrid(d: Date): Date {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return startOfWeek(first);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
}

export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The recurrence choices the UI offers, as RRULEs the server accepts.
 *
 * Deliberately a short list: these are what people pick in practice, and
 * every one of them is a rule the expander handles exactly. Anything more
 * exotic would have to be typed, and the API refuses what it cannot honour.
 */
export function repeatOptions(start: Date): { label: string; rule: string | null }[] {
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const day = DAYS[start.getDay()];
  const nth = Math.ceil(start.getDate() / 7);
  return [
    { label: 'Does not repeat', rule: null },
    { label: 'Every day', rule: 'FREQ=DAILY' },
    { label: `Every week on ${start.toLocaleDateString(undefined, { weekday: 'long' })}`,
      rule: `FREQ=WEEKLY;BYDAY=${day}` },
    { label: 'Every weekday (Mon–Fri)', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { label: `Every month on the ${start.getDate()}`,
      rule: `FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}` },
    { label: `Every month on the ${['first', 'second', 'third', 'fourth', 'fifth'][nth - 1]} ${start.toLocaleDateString(undefined, { weekday: 'long' })}`,
      rule: `FREQ=MONTHLY;BYDAY=${day};BYSETPOS=${nth}` },
    { label: 'Every year', rule: 'FREQ=YEARLY' },
  ];
}
