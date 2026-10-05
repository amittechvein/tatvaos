// ============================================================================
//  TatvaOS Docs — "exactly one API container" is enforced, not just written
// ============================================================================
//
//  Proof for DocsInstanceGuard and decision 0008's deployment rule. Needs TWO
//  API processes against the SAME database (locally: launch.json docs-api on
//  :5141 and docs-api-2 on :5149; DOCS_PORTS="first,second" to change). Asks each for a live ticket and attempts
//  the WebSocket handshake, reporting the raw HTTP status:
//
//    101  this instance serves live editing (it holds the lock)
//    503  this instance refuses live editing (another one holds the lock)
//
//    node tests/docs/docs-single-instance.test.mjs [expect]
//
//  expect = "first" (default): the first port serves, the second refuses.
//  expect = "second": after stopping the first, the second serves (the takeover).
//
//  Signs in as the platform operator by password (DOCS_ADMIN, default the
//  local BOOTSTRAP_ADMIN_* values) — no OTP, so no 60 s throttle between
//  runs — switches Docs on for the operator's own organisation and creates a
//  document of its own to connect to.
// ============================================================================

import http from 'node:http';
import crypto from 'node:crypto';

const [EXPECT = 'first'] = process.argv.slice(2);
const [ADMIN_EMAIL, ADMIN_PASSWORD] = (process.env.DOCS_ADMIN ?? 'platform@docs.local,dev-only-platform-pass').split(',');
const PORTS = (process.env.DOCS_PORTS ?? '5141,5149').split(',').map(Number);

async function signIn(port) {
  const r = await fetch(`http://localhost:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const b = await r.json().catch(() => ({}));
  if (!b.accessToken) throw new Error(`operator sign-in failed on :${port} (status ${r.status})`);
  return { token: b.accessToken };
}

/** The handshake status, without a WebSocket library: 101 or the refusal. */
function upgradeStatus(port, ticket) {
  return new Promise((resolve) => {
    const req = http.request({
      host: 'localhost', port, path: `/api/docs/${DOC}/live?ticket=${encodeURIComponent(ticket)}`,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => resolve(`error ${e.code}`));
    req.end();
  });
}

let failed = 0;
const who = await signIn(PORTS[0]).catch(() => signIn(PORTS[1]));
const token = who.token;
// Any live instance will do for the setup calls (REST is not guarded).
const setupPort = await fetch(`http://localhost:${PORTS[0]}/health`).then(() => PORTS[0]).catch(() => PORTS[1]);
const api = `http://localhost:${setupPort}/api`;
// The organisation is the token's own tenant_id claim (read, never printed).
const tenantId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).tenant_id;
await fetch(`${api}/admin/organisations/${tenantId}/docs`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ enabled: true }),
});
const created = await fetch(`${api}/docs`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ title: 'Single-instance guard test' }),
});
const DOC = (await created.json()).id;
if (!DOC) throw new Error(`could not create a test document (status ${created.status}, tenant ${tenantId})`);
for (const port of PORTS) {
  let status;
  try {
    // Signed in on THIS instance: a token from one local instance is not
    // accepted by the other (measured: 401), which is not what is under test.
    const own = (await signIn(port)).token;
    const t = await fetch(`http://localhost:${port}/api/docs/${DOC}/live-ticket`, {
      method: 'POST', headers: { Authorization: `Bearer ${own}` },
    });
    status = t.ok ? await upgradeStatus(port, (await t.json()).ticket) : `ticket ${t.status}`;
  } catch (e) {
    status = `down (${e.cause?.code ?? e.message})`;
  }
  const want = EXPECT === 'first' ? (port === PORTS[0] ? 101 : 503) : (port === PORTS[1] ? 101 : 'down');
  const ok = want === 'down' ? String(status).startsWith('down') : status === want;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  :${port} live handshake -> ${status} (expected ${want})`);
}
process.exit(failed ? 1 : 0);
