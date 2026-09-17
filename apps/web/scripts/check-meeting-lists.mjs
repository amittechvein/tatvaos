// Checks that the Connect dashboard never lists one meeting twice.
//
//   node apps/web/scripts/check-meeting-lists.mjs
//
// Needs Node 23.6+ (runs lib/meetingLists.ts directly); on Node 22 add
// --experimental-strip-types. Exit 0 = pass, 1 = fail.
//
// Found 17 Sept 2026: a meeting scheduled for today and live right now came
// back from BOTH range=today and range=upcoming, and the dashboard showed it
// twice under "Happening now" with a count of 2. Two halves, as in
// check-meeting-invitation.mjs: the merge itself, and a grep proving the
// dashboard uses it — a correct helper nothing calls fixes nothing.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mergeById } from '../lib/meetingLists.ts';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (what, cond, shown) => {
  if (cond) { pass++; console.log(`    ok  ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}`); if (shown !== undefined) console.log(`        | ${JSON.stringify(shown)}`); }
};

const m = (id, extra = {}) => ({ id, title: "Amit's meeting", status: 'active', ...extra });

console.log('\n  the merge');
// The exact shape of the 17 Sept screen: one live meeting, scheduled today,
// returned by both ranges — the two copies are different objects.
const liveToday = m('a1', { scheduledStart: '2026-09-17T10:00:00Z' });
const merged = mergeById([liveToday], [{ ...liveToday }]);
ok('a meeting in both today and upcoming appears once', merged.length === 1, merged.map((x) => x.id));

const other = m('b2');                           // same title, different meeting
const two = mergeById([liveToday, other], [{ ...liveToday }]);
ok('two meetings with the same title both stay', two.length === 2, two.map((x) => x.id));
ok('first occurrence wins, order kept', two[0] === liveToday && two[1] === other);
ok('empty lists merge to empty', mergeById([], []).length === 0);
ok('a single list with no repeats is unchanged', mergeById([liveToday, other]).length === 2);

console.log('\n  the dashboard uses it');
const page = readFileSync(join(web, 'app/connect/(shell)/dashboard/page.tsx'), 'utf8');
ok('"Happening now" merges today and upcoming by id', /mergeById\(today, upcoming\)\.filter\(/.test(page));
ok('the open-door list merges by id', /mergeById\(soon, today\)\.filter\(/.test(page));
ok('no plain [...today, ...upcoming] join is left', !/\[\s*\.\.\.today\s*,\s*\.\.\.upcoming\s*\]/.test(page));
ok('no plain [...soon, ...today] join is left', !/\[\s*\.\.\.soon\s*,\s*\.\.\.today\s*\]/.test(page));

console.log(`\n  ${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
