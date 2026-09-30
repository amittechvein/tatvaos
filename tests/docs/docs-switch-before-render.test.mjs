// ============================================================================
//  Docs cannot be switched on before the file is built on the server
// ============================================================================
//
//  Amit, 29 Sept 2026: Docs stays off for every organisation, Techvein
//  included, until decision 0011 condition 1 lands (the server render). The
//  operator's switch refuses to turn it on (DocsAdminEndpoints,
//  DocsSwitch.ServerRenderLanded). This checks that it refuses, that
//  switching OFF still works, and that the refusal changed nothing.
//
//  Run against an API that refuses as production does. On a developer's
//  machine the refusal is off (tests/docs must switch Docs on), so start the
//  API with the one setting that ADDS it:
//
//    Docs__RefuseSwitchOnInDevelopment=true   (in the API's environment)
//    node tests/docs/docs-switch-before-render.test.mjs
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

  console.log('Docs cannot be switched on before the server render');
  // Start from off. Switching OFF must work whatever state an earlier run left.
  const off = await P('PUT', { enabled: false });
  check('switching Docs OFF is allowed (200)', off.status === 200 && off.body.enabled === false,
    `status ${off.status} ${JSON.stringify(off.body)}`);

  const on = await P('PUT', { enabled: true });
  check('switching Docs ON is refused (409, docs_before_render)',
    on.status === 409 && on.body.reason === 'docs_before_render', `status ${on.status} ${JSON.stringify(on.body)}`);
  check('…with a sentence that says why', /built on the server/.test(on.body.error ?? ''), JSON.stringify(on.body.error));

  const after = await P('GET');
  check('…and Docs is still off afterwards', after.status === 200 && after.body.enabled === false,
    `status ${after.status} ${JSON.stringify(after.body)}`);

  // If the refusal failed, put Docs back off so this run leaves nothing on.
  if (on.status === 200) await P('PUT', { enabled: false });

  console.log(`\n  passed: ${passed}   failed: ${failed}`);
  // exitCode, not process.exit(): on Windows, Node 24 aborts in libuv when
  // exit() runs with fetch's keep-alive sockets still closing, and the run
  // ends with 127 whatever the result (measured 29 Sept).
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('ERROR:', e.message); process.exitCode = 2; });
