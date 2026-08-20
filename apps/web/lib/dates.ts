/**
 * Dates, formatted the way this platform's users read them.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  WHY THIS FILE EXISTS
 *
 *  Nineteen call sites across eight files formatted dates with
 *  `toLocaleDateString(undefined, …)`. Passing `undefined` means "use the
 *  BROWSER's locale", so the field ORDER came from whatever machine happened
 *  to be looking. A US-configured browser rendered a public link's expiry as
 *  "September 19, 2026"; the same page on an Indian-configured browser read
 *  "19 September 2026".
 *
 *  Reported 20 August 2026 as "date show wrong here". The date was correct —
 *  30-day default expiry, 20 August plus 30 days is 19 September. Only the
 *  order was foreign, which is the more insidious failure: nothing is broken,
 *  it just doesn't read like it was built for you.
 *
 *  THE TRADE-OFF, STATED. Pinning the locale means a genuinely US-based user
 *  also sees day-first. That is the right call for a platform built for
 *  Indian organisations: our users' convention is day-first, and a product
 *  whose appearance changes with browser settings can't be supported
 *  consistently — two people in one office see different screens, and a
 *  screenshot in a ticket doesn't match what the next person sees.
 *
 *  This is the Pune test applied to something with no bug in it. See
 *  docs/WORKING_IN_LANES.md.
 * ───────────────────────────────────────────────────────────────────────────
 */

/**
 * en-IN, not en-GB. Both give day-first, and today they render alike — but
 * en-GB is a coincidence that happens to match, and the next divergence in
 * either locale's data would be silent. Say what we mean.
 */
const LOCALE = 'en-IN';

/** 19 September 2026 — for anything a user might act on. */
export function formatDate(value: string | number | Date): string {
  return new Date(value).toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** 19 Sep 2026 — for lists and other tight spaces. */
export function formatDateShort(value: string | number | Date): string {
  return new Date(value).toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** 19 Sep 2026, 4:30 pm — timestamps in audit logs and message headers. */
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * 19 Sep 2026, 16:30:07 — the audit trail only.
 *
 * Seconds are kept because an audit entry is read to answer "when exactly",
 * and 24-hour because an audit trail should not make the reader work out
 * whether 03:04 was morning or afternoon.
 */
export function formatTimestamp(value: string | number | Date): string {
  return new Date(value).toLocaleString(LOCALE, {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

/**
 * Weekday and date, for calendar headings: Tuesday, 19 September 2026.
 */
export function formatDateWithWeekday(value: string | number | Date): string {
  return new Date(value).toLocaleDateString(LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * The TIME ZONE is deliberately NOT pinned here.
 *
 * Locale decides how a date is WRITTEN; the time zone decides WHICH MOMENT it
 * names. Those are different questions and conflating them causes real harm:
 * a meeting at 10:00 must show as 10:00 to the person in that room, so the
 * browser's zone is correct and must stay. Only the field order is ours to
 * fix. Do not "finish the job" by adding timeZone here.
 */
