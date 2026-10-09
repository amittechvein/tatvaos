// ============================================================================
//  The operator's Sheets switch, as production runs it, after the server build
// ============================================================================
//
//  History. Amit, 30 Sept 2026: Sheets refuses switch-on until the server
//  builds its own .xlsx (decision 0011 condition 1, as for Docs). The
//  operator's switch refused to turn it on (409 sheets_before_render) while
//  SheetsSwitch.ServerRenderLanded was false, and this file checked that
//  refusal. The server build landed in PRs 390/391/393, was deployed in round
//  two (13148ba, 8 Oct 2026) and checked in production's render container;
//  the switch-on pull request set ServerRenderLanded true, so this now checks
//  the switch AFTER the build, the same way tests/docs/docs-switch-production
//  .test.mjs does for Docs:
//
//    - switching OFF works;
//    - switching ON works (200): the before-build refusal is gone;
//    - Sheets then reads on, and switching back OFF works;
//    - Docs' switch is still its own (Sheets' state never answers for it).
//
//  RED FIRST: against an API built before the switch-on change (ServerRender-
//  Landed false), "switching Sheets ON works" FAILS with 409
//  sheets_before_render. That is what this file asserted until this change,
//  and it passed on every run of main up to 13148ba.
//
//  Run against an API that refuses as production does. On a developer's
//  machine the before-build refusal is off (tests/sheets must switch Sheets
//  on), so the API runs with the one setting that ADDS it back, which is what
//  makes this a production check:
//
//    Sheets__RefuseSwitchOnInDevelopment=true DOCS_TEST=tests/sheets/sheets-switch-production.test.mjs \
//      bash tests/docs/run-docs-live.sh
//
//  Environment: DOCS_API (default http://localhost:5141/api), DOCS_ADMIN
//  "email,password" of the platform operator, DOCS_TENANT (default seed 1).
//  Leaves Sheets and Docs off.
// ============================================================================

const API = process.env.DOCS_API ?? 'http://localhost:5141/api';
const [ADMIN_EMAIL, ADMIN_PASSWORD] = (process.env.DOCS_ADMIN ?? 'platform@docs.local,dev-only-platform-pass').split(',');
const TENANT = process.env.DOCS_TENANT ?? '11111111-1111-1111-1111-111111111111';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const token = (await login.json().catch(() => ({}))).accessToken;
  if (!token) throw new Error(`platform operator sign-in failed (status ${login.status})`);
  const P = async (product, method, body) => {
    const res = await fetch(`${API}/admin/organisations/${TENANT}/${product}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  console.log('The Sheets switch as production runs it, after the server build');
  // Start from off. Switching OFF must work whatever state an earlier run left.
  const off = await P('sheets', 'PUT', { enabled: false });
  check('switching Sheets OFF is allowed (200)', off.status === 200 && off.body.enabled === false,
    `status ${off.status} ${JSON.stringify(off.body)}`);
  const before = await P('sheets', 'GET');
  check('…and it reads off (the starting point is known)', before.status === 200 && before.body.enabled === false,
    `status ${before.status} ${JSON.stringify(before.body)}`);

  const on = await P('sheets', 'PUT', { enabled: true });
  check('switching Sheets ON works (200): no before-build refusal any more',
    on.status === 200 && on.body.enabled === true, `status ${on.status} ${JSON.stringify(on.body)}`);

  const after = await P('sheets', 'GET');
  check('…and Sheets now reads on', after.status === 200 && after.body.enabled === true,
    `status ${after.status} ${JSON.stringify(after.body)}`);

  // Docs' switch is its own: with Sheets ON, Docs must still read whatever
  // ITS switch says (off, from the start state below), not Sheets' answer.
  await P('docs', 'PUT', { enabled: false });
  const docs = await P('docs', 'GET');
  check('Docs\' switch is still its own (off while Sheets is on)', docs.status === 200 && docs.body.enabled === false,
    `status ${docs.status} ${JSON.stringify(docs.body)}`);

  const backOff = await P('sheets', 'PUT', { enabled: false });
  check('switching Sheets back OFF works (200), leaving Sheets off', backOff.status === 200 && backOff.body.enabled === false,
    `status ${backOff.status} ${JSON.stringify(backOff.body)}`);

  console.log(`\n  passed: ${passed}   failed: ${failed}`);
  // exitCode, not process.exit(): on Windows, Node 24 aborts in libuv when
  // exit() runs with fetch's keep-alive sockets still closing, and the run
  // ends with 127 whatever the result (measured 29 Sept).
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('ERROR:', e.message); process.exitCode = 2; });
