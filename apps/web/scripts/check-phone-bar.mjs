// The meeting control bar on a phone-sized screen.
//
//   node apps/web/scripts/check-phone-bar.mjs
//
// Exit 0 = pass, 1 = fail.
//
// Amit, 18 September 2026, after using a meeting in his phone's browser:
// "fix the mobile browser view similar to app for connect".
//
// The native app's bar (apps/mobile/screens/Meeting.js) is controls at flex:1
// sharing the width evenly, each an icon with a word under it, on a strip
// along the bottom. The base .cx-btn in RoomChrome is already that shape — one
// breakpoint took it apart, hiding every label with font-size:0 and pinning
// each button to 52px so the row wrapped onto two lines.
//
// This is CSS, and CSS cannot be unit-tested for appearance. What it CAN be
// held to is the decision: the labels stay, the buttons share the width, the
// rail becomes a bottom bar, and the menu moves with it. Each assertion below
// fails if someone reverts one of those, which is the whole point — the
// font-size:0 rule looked reasonable for a year.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (what, cond, shown) => {
  if (cond) { pass++; console.log(`    ok  ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}`); if (shown !== undefined) console.log(`        | ${JSON.stringify(shown)}`); }
};

const css = readFileSync(join(web, 'app/connect/room/[code]/RoomChrome.tsx'), 'utf8');

// The phone block, isolated — a rule elsewhere in the file must not be able to
// satisfy an assertion about this breakpoint.
const phone = /@media \(max-width:640px\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const small = /@media \(max-width:400px\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

console.log('\n  the phone breakpoint exists at all');
ok('there is a max-width:640px block', phone.length > 0);
ok('there is a small-phone block', small.length > 0);

console.log('\n  labels stay (this is the regression)');
// The bug: a phone has no hover, so an unlabelled icon can only be identified
// by pressing it — and two of these end the meeting or share your screen.
ok('nothing hides the button text with font-size:0', !/\.cx-btn\{[^}]*font-size:0/.test(phone), phone.match(/font-size:0[^;}]*/g));
ok('the small-phone block shrinks the label rather than removing it',
  /font-size:10px/.test(small) && !/font-size:0/.test(small));

console.log('\n  the controls share the width, like the app');
ok('buttons flex to fill the row', /\.cx-bar \.cx-btn\{[^}]*flex:1 1 0/.test(phone));
// Without min-width:0 a flex item will not shrink past its content and the
// row overflows instead of dividing — the failure looks like the CSS did
// nothing at all.
ok('and may shrink below their content', /\.cx-bar \.cx-btn\{[^}]*min-width:0/.test(phone));
ok('no fixed width is left pinning them', !/\.cx-btn\{[^}]*min-width:52px/.test(phone));
ok('the row never wraps to two lines', /\.cx-bar\{[^}]*flex-wrap:nowrap/.test(phone));
ok('a long label clips instead of wrapping', /white-space:nowrap/.test(phone));

console.log('\n  the bar is along the bottom, wherever it was put');
// A 92px rail on a 375px screen is a quarter of the picture spent on buttons.
ok('the left rail becomes a bottom bar', /\.cx-root--bar-left\{flex-direction:column-reverse\}/.test(phone));
ok('the rail lays out as a row', /\.cx-bar--left\{[^}]*flex-direction:row/.test(phone));
ok('its right border becomes a top border', /\.cx-bar--left\{[^}]*border-top:/.test(phone));
// The menu is anchored to where the rail WAS; left alone it opens underneath
// the bar it belongs to, which is the "dead button" the .cx-more note describes.
ok('the More menu moves with the bar', /\.cx-root--bar-left \.cx-more\{[^}]*bottom:104px/.test(phone));
ok('the chat bubble clears the bar', /\.cx-root--bar-left \.cx-fab\{bottom:104px\}/.test(phone));

console.log('\n  the safe area is respected');
// Without this the bar sits under the home indicator on a modern phone.
ok('bottom padding allows for the home indicator', /env\(safe-area-inset-bottom/.test(phone));

console.log(`\n  ${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
