// ============================================================================
//  AI metering and limits — end-to-end against a running API
// ============================================================================
//
//  Proves MeteredAiGateway with a FAKE provider, never a real key. Needs:
//    - the API with Ai__BaseUrl pointing at the fake (http://127.0.0.1:5198/v1),
//      Ai__ApiKey/Model/DataLocation set to anything, and Smtp__Port=5871;
//    - .tmp/fake-ai-and-mail.mjs running (fake provider on :5198, which also
//      counts completions at /hits and lists caught mail at /mail; SMTP sink
//      on :5871).
//
//    node tests/ai/ai-metering.test.mjs
//
//  Drives the one AI caller a signed-in person can trigger on main — the
//  operator's GET /api/admin/ai/status probe — as the platform operator,
//  whose own organisation is the one metered. The provider's /hits counter
//  is the independent witness: a request the gateway REFUSED must not reach
//  the provider at all, and the screen's numbers must match what it served.
//
//  Environment: DOCS_API (default http://localhost:5161/api), FAKE (default
//  http://127.0.0.1:5198), AI_ADMIN "email,password" (default the local
//  BOOTSTRAP_ADMIN_* values). Leaves every ai.* setting exactly as it found
//  it (read at the start), and the operator's organisation's consent off.
//
//  Limit meanings under test (Mr. Singh on PR 280): EMPTY = no limit,
//  0 = none allowed, a number = that number.
// ============================================================================

const API = process.env.DOCS_API ?? 'http://localhost:5161/api';
const FAKE = process.env.FAKE ?? 'http://127.0.0.1:5198';
const [EMAIL, PASSWORD] = (process.env.AI_ADMIN ?? 'platform@docs.local,dev-only-platform-pass').split(',');
const SCHOOL = '22222222-2222-2222-2222-222222222222';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};

const login = await (await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})).json();
if (!login.accessToken) { console.log('operator sign-in failed'); process.exit(2); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` };
const call = async (method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const hits = async () => (await (await fetch(`${FAKE}/hits`)).json()).hits;
const mail = async () => (await fetch(`${FAKE}/mail`)).json();
const probe = () => call('GET', '/admin/ai/status');
const usage = async () => (await call('GET', '/org/ai')).body.usage;
const settings = (s) => call('PUT', '/admin/settings', s);
const consent = (on) => call('PUT', '/org/ai', { enabled: on });

console.log(`AI metering against ${API} (fake provider ${FAKE})\n`);

// ---- start from a known state, remembering what was there ---------------------
const found = Object.fromEntries((await call('GET', '/admin/settings')).body
  .filter((i) => i.key.startsWith('ai.')).map((i) => [i.key, i.value ?? '']));
check('the limits start seeded, not empty (an empty field would mean unlimited)',
  found['ai.limit.per_person_per_hour'] !== '' && found['ai.limit.org_monthly_tokens'] !== '', JSON.stringify(found));
await settings({ 'ai.paused': 'false', 'ai.limit.per_person_per_hour': '1000', 'ai.limit.org_monthly_tokens': '' });
await consent(true);

console.log('Metering');
let h0 = await hits(); let u0 = await usage();
let p = await probe();
check('a request with consent reaches the provider and succeeds', p.body.working === true && (await hits()) === h0 + 1,
  JSON.stringify(p.body));
let u1 = await usage();
check('it is metered: +1 request, +150 tokens (the provider\'s own counts)',
  u1.requests === u0.requests + 1 && u1.tokens === u0.tokens + 150, `${JSON.stringify(u0)} -> ${JSON.stringify(u1)}`);
check('attributed to the feature that asked', u1.byFeature.some((f) => f.feature === 'platform.probe'));
check('and to the model it went to, in and out counted separately',
  u1.byModel.some((m) => m.model === 'fake-model' && m.tokensIn === 100 * m.requests && m.tokensOut === 50 * m.requests),
  JSON.stringify(u1.byModel));

const op = await call('GET', `/admin/organisations/${login.user?.tenantId ?? JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url')).tenant_id}/ai-usage`);
check('the operator sees the same numbers the organisation sees', op.status === 200 && op.body.tokens === u1.tokens && op.body.requests === u1.requests,
  JSON.stringify(op.body));
const other = await call('GET', `/admin/organisations/${SCHOOL}/ai-usage`);
check('another organisation\'s count is untouched by ours', other.status === 200 && other.body.tokens === 0, JSON.stringify(other.body));

console.log('No consent: nothing sent, nothing metered');
await consent(false);
h0 = await hits(); u0 = await usage();
p = await probe();
check('without consent the request is refused', p.body.working === false, JSON.stringify(p.body));
check('and never reaches the provider', (await hits()) === h0);
u1 = await usage();
check('and is not metered (nothing was about to be sent)', u1.requests === u0.requests && u1.refused === u0.refused);
await consent(true);

console.log('The operator\'s pause');
await settings({ 'ai.paused': 'true' });
h0 = await hits(); u0 = await usage();
p = await probe();
check('paused: the request is refused and says so', p.body.working === false && /paused/i.test(p.body.detail ?? ''), JSON.stringify(p.body));
check('paused: the provider is not called', (await hits()) === h0);
u1 = await usage();
check('paused: the refusal is recorded (abuse shows up as refusals)', u1.refused === u0.refused + 1 && u1.paused === true);
await settings({ 'ai.paused': 'false' });
p = await probe();
check('unpaused: AI works again', p.body.working === true);

console.log('Monthly ceiling, and the 80% / 100% emails');
const m0 = (await mail()).length;
u0 = await usage();
// 150 tokens per call. Ceiling = used + 200: the next call lands at >= 80%,
// the one after at >= 100%, and the third is refused before the provider.
await settings({ 'ai.limit.org_monthly_tokens': String(u0.tokens + 200) });
p = await probe();
check('under the ceiling: allowed', p.body.working === true);
let mails = await mail();
// The seed organisation has exactly one active owner/admin, so one email per level.
check('crossing 80% emails the organisation\'s administrator, once',
  mails.slice(m0).filter((m) => /80%/.test(m.subject)).length === 1, JSON.stringify(mails.slice(m0)));
p = await probe();
check('the call that crosses the ceiling is still answered', p.body.working === true);
mails = await mail();
check('crossing 100% emails them once more, saying AI has stopped',
  mails.slice(m0).filter((m) => /stopped/i.test(m.subject)).length === 1,
  JSON.stringify(mails.slice(m0)));
h0 = await hits();
p = await probe();
check('over the ceiling: refused, naming the allowance', p.body.working === false && /allowance/i.test(p.body.detail ?? ''), JSON.stringify(p.body));
check('over the ceiling: the provider is not called', (await hits()) === h0);
const before = (await mail()).length;
await probe();
check('no further emails for the same level this month', (await mail()).length === before);
const u2 = await usage();
check('the screen shows 100% of the allowance', u2.percentOfCeiling === 100, JSON.stringify(u2));

console.log('Raising the ceiling mid-month warns again at the new one');
const m1 = (await mail()).length;
await settings({ 'ai.limit.org_monthly_tokens': String(u2.tokens + 200) });
p = await probe();
check('after raising the ceiling, AI works again', p.body.working === true, JSON.stringify(p.body));
check('crossing 80% of the NEW ceiling emails again',
  (await mail()).slice(m1).filter((m) => /80%/.test(m.subject)).length === 1, JSON.stringify((await mail()).slice(m1)));
await probe();
check('and reaching the new ceiling sends a new "stopped" email',
  (await mail()).slice(m1).filter((m) => /stopped/i.test(m.subject)).length === 1);

console.log('Zero means zero; empty means no limit');
await settings({ 'ai.limit.org_monthly_tokens': '0' });
h0 = await hits();
p = await probe();
check('a ceiling of 0 refuses (an operator stopping an organisation)', p.body.working === false && /allowance/i.test(p.body.detail ?? ''),
  JSON.stringify(p.body));
check('a ceiling of 0 never calls the provider', (await hits()) === h0);
check('the screen reads 0 as none allowed, not as unlimited', (await usage()).ceilingTokens === 0 && (await usage()).percentOfCeiling === 100);
await settings({ 'ai.limit.org_monthly_tokens': '' });
p = await probe();
check('an empty ceiling is no ceiling: allowed, whatever was used', p.body.working === true, JSON.stringify(p.body));
check('the screen reads empty as no ceiling', (await usage()).ceilingTokens === null);

console.log('Per-person hourly limit');
await settings({ 'ai.limit.org_monthly_tokens': '' });
// Every call this person has had answered in the last hour counts. Set the
// limit to exactly one more than that: one more is allowed, then refused.
// ASSUMES every answered call this month was in the last hour — true on a
// fresh database. If not, the limit is set too high and the "next is refused"
// check goes RED: this can fail falsely, never pass falsely.
const sentThisHour = (await usage()).requests;
await settings({ 'ai.limit.per_person_per_hour': String(sentThisHour + 1) });
p = await probe();
check('the last request inside the hourly limit is allowed', p.body.working === true, JSON.stringify(p.body));
h0 = await hits();
p = await probe();
check('the next is refused, saying it is the hourly limit', p.body.working === false && /last hour/i.test(p.body.detail ?? ''), JSON.stringify(p.body));
check('and the provider is not called', (await hits()) === h0);
await settings({ 'ai.limit.per_person_per_hour': '0' });
h0 = await hits();
p = await probe();
check('an hourly limit of 0 allows none', p.body.working === false && (await hits()) === h0, JSON.stringify(p.body));

console.log('The test warning email: operator only, and every send audited');
// Mr. Singh, 25 Sept: it mails any address typed, so it is a relay unless only
// the platform operator can reach it, and each send must be audited WITH the
// address. An organisation's own owner is the nearest thing to an attacker
// with a valid session; they must get 403 and no mail may leave.
const OWNER_PHONE = process.env.AI_OWNER_PHONE ?? '+919999900002';
const r1 = await fetch(`${API}/auth/otp/request`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE }) });
const code = (await r1.json().catch(() => ({}))).devCode;
const owner = code && await (await fetch(`${API}/auth/otp/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: OWNER_PHONE, code }) })).json();
check('an organisation owner can sign in (fixture; wait 60 s and rerun if not)', !!owner?.accessToken);
const RELAY_TO = `relay-probe-${Date.now()}@example.test`;
let mBefore = (await mail()).length;
const asOwner = await fetch(`${API}/admin/settings/test-ai-warning`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner?.accessToken}` },
  body: JSON.stringify({ to: RELAY_TO }) });
check('an organisation owner is refused (403)', asOwner.status === 403, `status ${asOwner.status}`);
const anon = await fetch(`${API}/admin/settings/test-ai-warning`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: RELAY_TO }) });
check('no session is refused (401)', anon.status === 401, `status ${anon.status}`);
check('and neither sent any mail', (await mail()).slice(mBefore).length === 0, JSON.stringify((await mail()).slice(mBefore)));

const AUDIT_TO = `ai-warning-${Date.now()}@example.test`;
mBefore = (await mail()).length;
const sent = await call('POST', '/admin/settings/test-ai-warning', { to: AUDIT_TO });
check('the operator\'s send is handed to the mail server', sent.status === 200 && sent.body.sent === true, JSON.stringify(sent.body));
check('and it arrives, marked [Test]', (await mail()).slice(mBefore).some((m) => /^\[Test\]/.test(m.subject)),
  JSON.stringify((await mail()).slice(mBefore)));
const trail = await call('GET', '/org/audit?action=settings.test_ai_warning');
const row = (trail.body.entries ?? []).find((e) => (e.afterState ?? '').includes(AUDIT_TO));
check('the send is audited with the address and the result', !!row && JSON.parse(row.afterState).sent === true && row.actorUserId,
  `status ${trail.status}: ${JSON.stringify(trail.body).slice(0, 300)}`);
// Control for the check above: it must be able to go red. An address this run
// never sent to must NOT be found, so a match proves the row names THIS send,
// not merely that the trail has something in it.
const NEVER_SENT = `never-sent-${Date.now()}@example.test`;
check('control: an address never sent to is not in the trail',
  trail.status === 200 && !(trail.body.entries ?? []).some((e) => (e.afterState ?? '').includes(NEVER_SENT)));
const refused = await call('POST', '/admin/settings/test-ai-warning', { to: 'not an address' });
check('a malformed address is refused before anything is sent', refused.status === 400);

// ---- leave everything as found -------------------------------------------------
await settings(found);
await consent(false);
const after = Object.fromEntries((await call('GET', '/admin/settings')).body
  .filter((i) => i.key.startsWith('ai.')).map((i) => [i.key, i.value ?? '']));
check('every ai.* setting is back as it was found', JSON.stringify(after) === JSON.stringify(found), JSON.stringify(after));

console.log(`\n  passed: ${passed}   failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
