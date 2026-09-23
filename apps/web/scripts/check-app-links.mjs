// Android App Links: the file that lets a tapped meeting invitation open the
// TatvaOS app instead of the browser.
//
//   node apps/web/scripts/check-app-links.mjs
//
// Exit 0 = pass, 1 = fail.
//
// Amit, 23 September 2026: "if someone join the meeting via link in mobile
// its redirect to mobile app". Android only routes https://connect.tatvaos.com
// links to the app once that domain serves /.well-known/assetlinks.json
// naming the app AND the certificate that signs it. Both values are checked
// here because both are easy to get subtly wrong, and the failure is silent:
// Android just keeps opening the browser, and nothing anywhere says why.
//
// THE FINGERPRINTS MUST BE PLAY'S. Google Play re-signs every app it ships,
// so the certificate on a phone is Play's app-signing key, not the upload key
// we hold in ~/.tatvaos-signing and not any debug key. Listing the upload key
// would be useless (it never signs an installed app) and listing a debug key
// would let any build made with it claim our links.

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

const path = join(web, 'public/.well-known/assetlinks.json');
const raw = readFileSync(path);

console.log('\n  the file itself');
ok('no byte-order mark (Android\'s parser rejects one)', !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
let doc;
try { doc = JSON.parse(raw.toString('utf8')); ok('parses as JSON', true); }
catch (e) { ok('parses as JSON', false, e.message); }
ok('is a list of statements', Array.isArray(doc) && doc.length >= 1);

const st = Array.isArray(doc) ? doc[0] : {};
console.log('\n  the statement');
ok('grants handle_all_urls, the one relation App Links use',
  Array.isArray(st.relation) && st.relation.includes('delegate_permission/common.handle_all_urls'), st.relation);
ok('targets an android app', st.target?.namespace === 'android_app', st.target?.namespace);

// The package name Android compares is the one in the app's manifest, which
// expo prebuild takes from app.json. Read it from there rather than repeat it.
const appJson = JSON.parse(readFileSync(join(web, '../mobile/app.json'), 'utf8'));
const pkg = appJson.expo.android.package;
ok(`names the app's real package (${pkg})`, st.target?.package_name === pkg, st.target?.package_name);

console.log('\n  the fingerprints');
const fps = st.target?.sha256_cert_fingerprints ?? [];
ok('at least one fingerprint', fps.length >= 1);
const SHAPE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
for (const fp of fps) {
  ok(`well-formed, upper-case, colon-separated: ${fp.slice(0, 11)}…`, SHAPE.test(fp), fp);
}
// Our own upload key. It uploads bundles to Play and signs nothing a phone
// ever runs. Its presence here would mean somebody copied the wrong tile.
const UPLOAD_KEY_PREFIX = 'EA:A2:0F:9C:92:C6:10:BB';
ok('does NOT list the upload key', !fps.some((f) => f.startsWith(UPLOAD_KEY_PREFIX)));
// The debug keystore this laptop builds test APKs with (seen via
// pm get-app-links on 23 Sept 2026). Never in a production file.
const DEBUG_KEY_PREFIX = 'FA:C6:17:45:DC:09:03:78';
ok('does NOT list the debug key', !fps.some((f) => f.startsWith(DEBUG_KEY_PREFIX)));
ok('no duplicates', new Set(fps).size === fps.length);

console.log('\n  the path Android fetches');
ok('lives at public/.well-known/assetlinks.json (served at the domain root)', path.endsWith('assetlinks.json'));

console.log(`\n  ${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} ok, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
