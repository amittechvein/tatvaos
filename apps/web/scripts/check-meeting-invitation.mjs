// Checks what "Copy link" puts on the clipboard.
//
//   node apps/web/scripts/check-meeting-invitation.mjs
//
// Needs Node 23.6+ (runs lib/meetingInvitation.ts directly by stripping its
// types); on Node 22 add --experimental-strip-types. Exit 0 = pass, 1 = fail.
// No test framework, the same reason as tests/connect-order: nothing to install.
//
// Two halves. The TEXT: name, date, time, zone, link, code, and the things
// that must stay out. The WIRING: both copy buttons call meetingInvitation —
// checked by grepping the source, because a correct function that no button
// calls is the failure this file would otherwise not see.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { meetingInvitation } from '../lib/meetingInvitation.ts';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (what, cond, shown) => {
  if (cond) { pass++; console.log(`    ok  ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}`); if (shown !== undefined) console.log(indent(shown)); }
};
const indent = (s) => String(s).split('\n').map((l) => `        | ${l}`).join('\n');

const base = {
  id: 'm1', code: 'AbCdEfGhIjKlMnOpQrStUv', joinUrl: 'https://connect.tatvaos.com/connect/room/AbCdEfGhIjKlMnOpQrStUv',
  title: 'Weekly review', kind: 'scheduled', status: 'scheduled',
  scheduledStart: '2026-09-16T04:30:00Z', scheduledEnd: '2026-09-16T05:30:00Z', // 10:00–11:00 IST
  timezone: 'Asia/Kolkata', startedAt: null, endedAt: null,
  hasPassword: false, waitingRoom: 'guests', allowGuests: true, locked: false,
  autoRecord: false, sharePolicy: 'everyone', chatPolicy: 'everyone', minutesLive: false,
  mode: 'recorded', createdByUserId: null, myRole: 'host',
  createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
};
const inv = (over) => meetingInvitation({ ...base, ...over });

console.log('\n  the invitation a scheduled meeting copies');
const a = inv({});
console.log(indent(a));
ok('names the meeting', a.includes('Weekly review'), a);
ok('gives the date', a.includes('16 September 2026'), a);
ok('gives start and end time in the meeting zone', /10:00\s?am\s+–\s+11:00\s?am/i.test(a), a);
ok('names the zone (IST)', a.includes('IST'), a);
ok('carries the join link', a.includes(base.joinUrl), a);
ok('carries the code, grouped to be read aloud', a.includes('Meeting code: AbCd EfGh IjKl MnOp QrSt Uv'), a);
ok('says nothing about recording or encryption (ruled wording)', !/record|encrypt/i.test(a), a);

console.log('\n  the lines that depend on the meeting');
const pw = inv({ hasPassword: true });
ok('a password meeting says one is needed', pw.includes('needs a password'), pw);
ok('and never contains a password value', !/password:/i.test(pw), pw);
const members = inv({ allowGuests: false });
ok('no guests: tells them to sign in', members.includes('Sign in with your organisation account'), members);
ok('guests allowed: no sign-in line', !a.includes('Sign in with'), a);

const live = inv({ kind: 'instant', status: 'active', scheduledStart: null, scheduledEnd: null });
ok('an instant live meeting says Happening now, and no date', live.includes('Happening now') && !live.includes('2026'), live);
const soon = inv({ kind: 'instant', status: 'scheduled', scheduledStart: null, scheduledEnd: null });
ok('an instant meeting not yet live says Starting now', soon.includes('Starting now'), soon);

const noEnd = inv({ scheduledEnd: null });
ok('no end time: just the start', /10:00\s?am IST/i.test(noEnd) && !noEnd.includes('–'), noEnd);

const late = inv({ scheduledStart: '2026-09-16T17:30:00Z', scheduledEnd: '2026-09-16T19:30:00Z' }); // 23:00–01:00 IST
ok('past midnight: both days are named', late.includes('16 September 2026') && late.includes('17 September 2026'), late);

const dubai = inv({ timezone: 'Asia/Dubai' }); // 08:30–09:30 in Dubai
ok("uses the meeting's zone, not the copier's", /8:30\s?am\s+–\s+9:30\s?am/i.test(dubai) && !dubai.includes('IST'), dubai);

let bad;
try { bad = inv({ timezone: 'Not/AZone' }); } catch (e) { bad = `THREW: ${e}`; }
ok('a broken zone falls back to Kolkata instead of throwing', bad.includes('IST'), bad);

ok('an empty title still reads as a meeting', inv({ title: '   ' }).includes('\nMeeting\n'));

console.log('\n  both copy buttons use it');
const stage = readFileSync(join(web, 'app/connect/room/[code]/Stage.tsx'), 'utf8');
const page = readFileSync(join(web, 'app/connect/(shell)/meetings/[id]/page.tsx'), 'utf8');
ok('the room: Copy link writes meetingInvitation(...)', /writeText\(meetingInvitation\(meeting\)\)/.test(stage));
ok('the room: no longer writes the bare joinUrl', !/writeText\(meeting\.joinUrl\)/.test(stage));
ok('the meeting page: the link Copy uses meetingInvitation(...)', /copy\(meetingInvitation\(meeting\), 'link'\)/.test(page));
ok('the meeting page: no longer copies the bare joinUrl', !/copy\(meeting\.joinUrl/.test(page));

console.log(`\n  ${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
