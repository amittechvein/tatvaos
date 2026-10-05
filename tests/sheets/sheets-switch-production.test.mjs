// ============================================================================
//  Sheets cannot be switched on before its file is built on the server
// ============================================================================
//
//  Amit, 30 Sept 2026: Sheets refuses switch-on until the server builds its
//  own .xlsx (decision 0011 condition 1, as for Docs). The operator's switch
//  refuses to turn it on (SheetsAdminEndpoints, SheetsSwitch.ServerRender-
//  Landed). This checks that it refuses, that switching OFF still works, that
//  the refusal changed nothing, and that Docs' own switch is not caught by it.
//
//  RED FIRST: against an API without the refusal, "switching Sheets ON is
//  refused" FAILS (200).
//
//  Run against an API that refuses as production does. On a developer's
//  machine the refusal is off (tests/sheets must switch Sheets on), so the API
//  runs with the one setting that ADDS it back:
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

  console.log('Sheets cannot be switched on before the server builds its file');
  // Start from off. Switching OFF must work whatever state an earlier run left.
  const off = await P('sheets', 'PUT', { enabled: false });
  check('switching Sheets OFF is allowed (200)', off.status === 200 && off.body.enabled === false,
    `status ${off.status} ${JSON.stringify(off.body)}`);

  const on = await P('sheets', 'PUT', { enabled: true });
  check('switching Sheets ON is refused (409, sheets_before_render)',
    on.status === 409 && on.body.reason === 'sheets_before_render', `status ${on.status} ${JSON.stringify(on.body)}`);
  check('…with a sentence that says why', /built on the server/.test(on.body.error ?? ''), JSON.stringify(on.body.error));

  const after = await P('sheets', 'GET');
  check('…and Sheets is still off afterwards', after.status === 200 && after.body.enabled === false,
    `status ${after.status} ${JSON.stringify(after.body)}`);
  // If the refusal failed, put Sheets back off so this run leaves nothing on.
  if (on.status === 200) await P('sheets', 'PUT', { enabled: false });

  // Docs' switch is its own: the Sheets refusal must not catch it. Under this
  // production setting Docs answers by ITS rule — refused (409
  // docs_before_render) before Docs' own switch-on change, allowed after it;
  // never sheets_before_render.
  const docsOn = await P('docs', 'PUT', { enabled: true });
  check('Docs\' switch is not refused by the Sheets rule (its own answer, not sheets_before_render)',
    (docsOn.status === 200 || (docsOn.status === 409 && docsOn.body.reason === 'docs_before_render')),
    `status ${docsOn.status} ${JSON.stringify(docsOn.body)}`);
  if (docsOn.status === 200) await P('docs', 'PUT', { enabled: false });

  console.log(`\n  passed: ${passed}   failed: ${failed}`);
  // exitCode, not process.exit(): on Windows, Node 24 aborts in libuv when
  // exit() runs with fetch's keep-alive sockets still closing, and the run
  // ends with 127 whatever the result (measured 29 Sept).
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('ERROR:', e.message); process.exitCode = 2; });
