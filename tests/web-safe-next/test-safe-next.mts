// Where the sign-in page may send a person afterwards (Mr. Singh, 29 Sept
// 2026). Imports apps/web/lib/safeNext.ts itself — Node 22+ strips the types.
//
//   node tests/web-safe-next/test-safe-next.mts
//
// The inputs are what URLSearchParams.get('next') hands the page, i.e. ALREADY
// DECODED: "?next=/%09/evil.example" arrives here as "/\t/evil.example".
//
// The last line is the verdict: "PASS n" or "FAIL n of m".
import { safeNext } from '../../apps/web/lib/safeNext.ts';

const ORIGIN = 'https://core.tatvaos.com';
let passed = 0;
let failed = 0;
function check(ok: boolean, what: string) {
  if (ok) { passed++; console.log(`  ok    ${what}`); } else { failed++; console.log(`  FAIL  ${what}`); }
}
const show = (s: string | null) => JSON.stringify(s);

// What a browser does with the answer: where would it actually go?
function landsOn(to: string) { return new URL(to, ORIGIN).origin; }

console.log('Refused: each must fall through to the person\'s own home (null)');
for (const [raw, why] of [
  ['/\t/evil.example', '"/%09/evil.example": the browser strips the tab and reads //evil.example'],
  ['/\n/evil.example', '"/%0A/evil.example": line feed stripped the same way'],
  ['/\r/evil.example', '"/%0D/evil.example": carriage return stripped the same way'],
  ['/\\evil.example', '"/\\evil.example": a backslash is read as a slash'],
  ['\\\\evil.example', '"\\\\evil.example": two backslashes are two slashes'],
  ['/\t\\evil.example', '"/%09\\evil.example": tab stripped, then a backslash'],
  ['https:evil.example', '"https:evil.example": a scheme with no slashes is another site'],
  ['//evil.example', '"//evil.example": another site, no scheme'],
  ['https://evil.example/x', 'an absolute address elsewhere'],
  ['\t//evil.example', 'leading tab before //'],
  ['javascript:alert(1)', 'javascript:'],
  ['', 'empty'],
] as const) {
  const got = safeNext(raw, ORIGIN);
  check(got === null, `${why} -> ${show(got)}`);
  // Belt and braces: whatever it returned, it must not LEAVE the site.
  if (got !== null) check(landsOn(got) === ORIGIN, `  …and ${show(got)} stays on the site`);
}
check(safeNext(null, ORIGIN) === null, 'no next at all -> null');

console.log('Kept: a path inside this site comes back as the same place');
const consent = '/oauth/consent?response_type=code&client_id=tos_abc&redirect_uri=https%3A%2F%2Frp.test%2Fcb&scope=openid%20profile%20email&state=abc&code_challenge=E9Mel-cM&code_challenge_method=S256';
check(safeNext(consent, ORIGIN) === consent, 'the consent request, with its encoded query, exactly as it was');
check(safeNext('/mail/inbox', ORIGIN) === '/mail/inbox', '/mail/inbox');
check(safeNext('/org?tab=people#top', ORIGIN) === '/org?tab=people#top', 'query and fragment kept');
// Refused too, on purpose: no caller writes a full address, and accepting
// one is the door the scheme-only case above would come through.
check(safeNext(`${ORIGIN}/mail`, ORIGIN) === null, 'this site written out in full: refused, only paths are accepted');
// The parser case that made "must start with /" necessary: on an https site
// "https:evil.example" is a RELATIVE reference to /evil.example.
check(new URL('https:evil.example', ORIGIN).origin === ORIGIN,
  '(why the path rule exists) the parser alone reads "https:evil.example" as this site');
check(safeNext('https:evil.example', 'http://localhost:3063') === null, '"https:evil.example" on an http site: refused');
for (const raw of [consent, '/mail/inbox', '/org?tab=people#top']) {
  const got = safeNext(raw, ORIGIN);
  check(got !== null && landsOn(got) === ORIGIN, `${raw.slice(0, 30)}… lands on this site`);
}

console.log();
if (failed === 0) { console.log(`PASS ${passed}`); process.exit(0); }
console.log(`FAIL ${failed} of ${passed + failed}`);
process.exit(1);
