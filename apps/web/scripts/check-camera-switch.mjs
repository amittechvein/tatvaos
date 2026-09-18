// Checks the front/back camera switch in a meeting.
//
//   node apps/web/scripts/check-camera-switch.mjs
//
// Needs Node 23.6+ (runs lib/cameras.ts directly); on Node 22 add
// --experimental-strip-types. Exit 0 = pass, 1 = fail.
//
// Amit, 18 Sept 2026, in a meeting from his phone's browser: "need switch
// camera option in the mobile browser". Three parts, because there are three
// separate ways this can be broken and only one of them is logic:
//
//   1. the choice itself — cycling, and what to do when the current camera is
//      not in the list, which is the normal case on a phone before the labels
//      arrive;
//   2. greps proving Stage.tsx actually calls it, keeps the facingMode
//      fallback, and names the button from the live camera — a correct helper
//      nothing calls fixes nothing (check-meeting-lists.mjs, same lesson);
//   3. an allowlist of icons checked against the font by hand, because
//      ri-vidicon-off-line does not exist in it and rendered as an empty red
//      pill for a whole afternoon (RoomChrome.tsx says so at length). A
//      missing glyph costs nothing at build time and everything on screen.
//
// Proven to fail, 18 Sept 2026: renaming the icon fails part 3, and deleting
// the facingMode fallback fails part 2. A check nothing can break is not one.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nextCamera, switchLabel } from '../lib/cameras.ts';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (what, cond, shown) => {
  if (cond) { pass++; console.log(`    ok  ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}`); if (shown !== undefined) console.log(`        | ${JSON.stringify(shown)}`); }
};

// What an Android phone actually reports once camera permission is granted.
const front = { deviceId: 'f1', label: 'camera2 1, facing front' };
const back = { deviceId: 'b1', label: 'camera2 0, facing back' };
const wide = { deviceId: 'w1', label: 'camera2 2, facing back' };
const phone = [front, back];

console.log('\n  the choice');
ok('front goes to back', nextCamera(phone, 'f1')?.deviceId === 'b1');
ok('back comes round to front', nextCamera(phone, 'b1')?.deviceId === 'f1');
ok('three cameras cycle, not flip-flop',
  nextCamera([front, back, wide], 'b1')?.deviceId === 'w1'
  && nextCamera([front, back, wide], 'w1')?.deviceId === 'f1');

console.log('\n  when the current camera is not in the list');
// A track started with facingMode carries a deviceId enumeration has not
// labelled yet. Returning null here would make the button dead on a phone.
ok('an unknown id still gives somewhere to go', nextCamera(phone, 'unknown-id') !== null);
ok('it prefers the back camera when the labels say which is which',
  nextCamera(phone, 'unknown-id')?.deviceId === 'b1');
ok('no id at all still gives somewhere to go', nextCamera(phone)?.deviceId === 'b1');
ok('unlabelled cameras (permission not granted yet) still cycle',
  nextCamera([{ deviceId: 'x' }, { deviceId: 'y' }], 'x')?.deviceId === 'y');

console.log('\n  when there is nothing to switch to');
// A laptop with one webcam. The button is not drawn, and the helper agrees.
ok('one camera gives null', nextCamera([front], 'f1') === null);
ok('no cameras gives null', nextCamera([], 'f1') === null);
ok('a list of junk gives null', nextCamera([null, { label: 'no id' }], 'f1') === null);
ok('undefined list does not throw', nextCamera(undefined, 'f1') === null);

console.log('\n  what the button says');
ok('names the back camera', switchLabel(back) === 'Switch to back camera');
ok('names the front camera', switchLabel(front) === 'Switch to front camera');
ok('says something sensible with no labels', switchLabel({ deviceId: 'x' }) === 'Switch camera');
ok('says something sensible with nothing', switchLabel(null) === 'Switch camera');

console.log('\n  the meeting uses it');
const stage = readFileSync(join(web, 'app/connect/room/[code]/Stage.tsx'), 'utf8');
ok('Stage imports the helper', /import \{[^}]*nextCamera[^}]*\} from '@\/lib\/cameras'/.test(stage));
ok('there is a flip button', /cx-btn--flip/.test(stage));
ok('the button calls flipCamera', /onClick=\{\(\) => void flipCamera\(\)\}/.test(stage));
ok('flipCamera asks the helper where to go', /const next = nextCamera\(cams,/.test(stage));
ok('it switches the live device', /switchActiveDevice\('videoinput'/.test(stage));
// The fallback is the whole reason this works on a phone that reports one
// camera: without it the button does nothing on exactly the device it is for.
ok('it falls back to facingMode when there is no second device',
  /restartTrack\(\{ facingMode/.test(stage));
ok('the fallback flips the facing rather than forcing one',
  /facingMode === 'environment' \? 'user' : 'environment'/.test(stage));
ok('it re-reads the device list afterwards',
  /restartTrack[\s\S]{0,400}getLocalDevices\('videoinput'\)/.test(stage));
ok('it says so rather than failing silently when the camera is off',
  /Turn your camera on first/.test(stage));
// Only while the camera is on: flipping a camera that is not sending is not a
// thing, and the pill would sit there inviting the press.
ok('the button is only drawn while the camera is on', /\{camOn && \(cams\.length/.test(stage));
// The label is the only thing telling a phone user which way they are about to
// turn; naming the side they are already on is worse than saying nothing.
ok('the button is named from the camera that is actually live',
  /switchLabel\(nextCamera\(cams, camId\)\)/.test(stage));
ok('the name reaches a screen reader, not just a tooltip',
  /aria-label=\{switchLabel\(nextCamera\(cams, camId\)\)\}/.test(stage));
ok('the live camera is re-read after a flip, not left stale',
  /setCamId\(track\.mediaStreamTrack/.test(stage));
// Grey is the bar's default tone and reads as a disabled control.
const roomChrome = readFileSync(join(web, 'app/connect/room/[code]/RoomChrome.tsx'), 'utf8');
ok('the button has its own colour in the bar', /\.cx-btn--flip\{--tone:/.test(roomChrome));

console.log('\n  the icon');
// ri-vidicon-off-line does not exist in this font. It rendered as an empty red
// pill for an afternoon, and it cost that long because a missing glyph is not
// an error anywhere — not at build, not in the console, only on screen.
//
// Whether a glyph exists cannot be decided from this repository; the font
// comes from a CDN. So the names were checked by hand, once, against the exact
// version app/layout.tsx pins:
//
//   curl -s https://cdn.jsdelivr.net/npm/remixicon@4.3.0/fonts/remixicon.css > f
//   grep -c "\.ri-camera-switch-line:before" f      # 1 = the glyph is there
//
// Run on 18 Sept 2026 for every icon this screen renders: all present, except
// ri-vidicon-off-line, which survives only in the comments warning about it.
//
// What this check does is HOLD that list. Render an icon that is not on it and
// this fails, and the fix is to run the two lines above for the new name — not
// to add it here because it looks plausible. That is the whole mistake.
const VERIFIED = new Set([
  'ri-attachment-2', 'ri-camera-switch-line', 'ri-chat-3-fill', 'ri-computer-fill',
  'ri-emotion-fill', 'ri-file-line', 'ri-file-text-line', 'ri-group-fill', 'ri-hand',
  'ri-layout-grid-fill', 'ri-lock-line', 'ri-logout-box-r-fill', 'ri-mic-fill',
  'ri-mic-off-line', 'ri-more-2-fill', 'ri-picture-in-picture-exit-line',
  'ri-settings-3-line', 'ri-user-unfollow-line', 'ri-vidicon-line',
]);
const used = [...new Set([...stage.matchAll(/className="(ri-[a-z0-9-]+)"/g)].map((m) => m[1]))];
const unverified = used.filter((i) => !VERIFIED.has(i));
ok('every icon this screen renders has been checked against the font',
  unverified.length === 0, unverified);
ok('the flip button renders the camera-switch icon',
  /ri-camera-switch-line[\s\S]{0,80}Flip/.test(stage));
// The name that caused it, in a position that would actually render — it is
// still in the file twice as a warning, and those must not count as a use.
ok('the glyph that does not exist is not rendered', !used.includes('ri-vidicon-off-line'));
ok('...and the warning about it has not been tidied away', /ri-vidicon-off-line/.test(stage));
// The font is still pinned to the version the icon was verified against.
const layout = readFileSync(join(web, 'app/layout.tsx'), 'utf8');
ok('layout still loads remixicon 4.3.0', /remixicon@4\.3\.0/.test(layout));

console.log(`\n  ${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
