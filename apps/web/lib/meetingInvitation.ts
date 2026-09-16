import type { Meeting } from './connect';

/**
 * The text "Copy link" puts on the clipboard: a whole invitation, not a bare URL.
 *
 * Amit, 16 Sept 2026: a link pasted into WhatsApp or an email on its own says
 * nothing — the person receiving it cannot tell what the meeting is or when it
 * starts, and has to ask. So the clipboard carries the name, the date, the
 * time with its zone, the link and the code, in that order.
 *
 * ONE IMPLEMENTATION (house rule 10). The room's Copy link and the meeting
 * page's Copy both call this. apps/mobile/screens/Meeting.js shares its own
 * shorter sentence and has NOT been changed — Mobile's file, another session.
 *
 * WHAT IS DELIBERATELY NOT IN IT:
 *   • The password. The client never has it (only `hasPassword`), and a
 *     password pasted next to the link is no password at all.
 *   • Whether the meeting is recorded or encrypted. What a customer is told
 *     about recording and encryption is ruled wording (CONNECT_DECISIONS.md;
 *     "encrypted" has two meanings that must be labelled differently). An
 *     invitation paraphrasing it is a second copy of a promise, and the CTO
 *     decides those, not this file.
 *
 * TIME ZONE. The meeting's own zone, not the copier's browser: a host in Dubai
 * inviting a team in Kolkata to "10:00" means 10:00 where the meeting was set.
 * The zone is named on the line so nobody has to guess. An unknown zone falls
 * back to Asia/Kolkata rather than throwing — a copy button that fails because
 * of a bad zone string loses the whole invitation to protect one line.
 *
 * Pure and dependency-free (type-only import), so
 * scripts/check-meeting-invitation.mjs can run it under plain Node.
 */
export function meetingInvitation(m: Meeting): string {
  const zone = validZone(m.timezone) ?? 'Asia/Kolkata';
  const lines: string[] = [];

  lines.push("You're invited to a meeting on TatvaOS Connect.");
  lines.push('');
  lines.push(m.title?.trim() || 'Meeting');
  lines.push(...whenLines(m, zone));
  lines.push('');
  lines.push('Join the meeting:');
  lines.push(m.joinUrl);
  lines.push('');
  lines.push(`Meeting code: ${m.code.replace(/(.{4})/g, '$1 ').trim()}`);

  if (m.hasPassword) {
    lines.push('This meeting needs a password. The host will send it to you separately.');
  }
  if (!m.allowGuests) {
    lines.push('Sign in with your organisation account to join.');
  }

  return lines.join('\n');
}

function whenLines(m: Meeting, zone: string): string[] {
  const start = parse(m.scheduledStart);

  // No scheduled time: an instant meeting, which is happening now or about to.
  if (!start) {
    return [m.status === 'active' ? 'Happening now' : 'Starting now'];
  }

  const day = new Intl.DateTimeFormat('en-IN', {
    timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const time = (d: Date) => new Intl.DateTimeFormat('en-IN', {
    timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);

  const end = parse(m.scheduledEnd);
  const zoneName = zoneLabel(start, zone);

  if (!end || end <= start) {
    return [day.format(start), `${time(start)} ${zoneName}`];
  }
  // Ends on a later calendar day in the meeting's zone: name both days, or
  // "11:00 pm – 1:00 am" reads as a meeting that ends before it begins.
  if (day.format(end) !== day.format(start)) {
    return [`${day.format(start)}, ${time(start)} – ${day.format(end)}, ${time(end)} ${zoneName}`];
  }
  return [day.format(start), `${time(start)} – ${time(end)} ${zoneName}`];
}

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validZone(zone: string | null): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** "IST" for Kolkata; whatever short name the runtime has for anything else. */
function zoneLabel(at: Date, zone: string): string {
  const part = new Intl.DateTimeFormat('en-IN', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? zone;
}
