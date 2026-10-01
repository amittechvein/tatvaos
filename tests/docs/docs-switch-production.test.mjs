// ============================================================================
//  The operator's Docs switch, as production runs it, after the server render
// ============================================================================
//
//  History. Amit, 29 Sept 2026: Docs stays off for every organisation,
//  Techvein included, until decision 0011 condition 1 lands (the file built
//  on the server). PR 358 made the operator's switch refuse to turn it on
//  (409 docs_before_render) while DocsSwitch.ServerRenderLanded was false;
//  this file then checked that refusal. The render landed in PR 367 and was
//  checked on production; the switch-on pull request set ServerRenderLanded
//  true, so this now checks the switch AFTER the render:
//
//    - switching OFF works;
//    - switching ON works (200) — the before-render refusal is gone;
//    - Docs then reports on, and switching back OFF works.
//
//  The browser-written-files guard (409 browser_files) is NOT tested here:
//  tests/docs/docs-live.test.mjs plants a browser-written file and proves it.
//
//  RED FIRST: against an API built before the switch-on change (ServerRender-
//  Landed false), "switching ON works" FAILS with 409 docs_before_render.
//
//  Run against an API that refuses as production does. On a developer's
//  machine the before-render refusal is off (tests/docs must switch Docs on),
//  so the API runs with the one setting that ADDS it back — which is what
//  makes this a production check:
//
//    Docs__RefuseSwitchOnInDevelopment=true DOCS_TEST=tests/docs/docs-switch-production.test.mjs \
//      bash tests/docs/run-docs-live.sh
//
//  Environment: DOCS_API (default http://localhost:5141/api), DOCS_ADMIN
//  "email,password" of the platform operator, DOCS_TENANT (default seed 1).
//  Leaves Docs off.
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
  const P = async (method, body) => {
    const res = await fetch(`${API}/admin/organisations/${TENANT}/docs`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  console.log('The Docs switch as production runs it, after the server render');
  // Start from off. Switching OFF must work whatever state an earlier run left.
  const off = await P('PUT', { enabled: false });
  check('switching Docs OFF is allowed (200)', off.status === 200 && off.body.enabled === false,
    `status ${off.status} ${JSON.stringify(off.body)}`);
  const before = await P('GET');
  check('…and it reads off (the starting point is known)', before.status === 200 && before.body.enabled === false,
    `status ${before.status} ${JSON.stringify(before.body)}`);

  const on = await P('PUT', { enabled: true });
  check('switching Docs ON works (200) — no before-render refusal any more',
    on.status === 200 && on.body.enabled === true, `status ${on.status} ${JSON.stringify(on.body)}`);

  const after = await P('GET');
  check('…and Docs now reads on', after.status === 200 && after.body.enabled === true,
    `status ${after.status} ${JSON.stringify(after.body)}`);

  const backOff = await P('PUT', { enabled: false });
  check('switching back OFF works (200), leaving Docs off', backOff.status === 200 && backOff.body.enabled === false,
    `status ${backOff.status} ${JSON.stringify(backOff.body)}`);

  console.log(`\n  passed: ${passed}   failed: ${failed}`);
  // exitCode, not process.exit(): on Windows, Node 24 aborts in libuv when
  // exit() runs with fetch's keep-alive sockets still closing, and the run
  // ends with 127 whatever the result (measured 29 Sept).
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('ERROR:', e.message); process.exitCode = 2; });
