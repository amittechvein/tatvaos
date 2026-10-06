// ============================================================================
//  TatvaOS Docs — end-to-end checks against a running API
// ============================================================================
//
//  Drives the real endpoints and the real WebSocket with real Yjs, as three
//  people: the owner and an employee of tenant 1, and an admin of tenant 2.
//  Each check states what it proves and fails loudly; the run ends with a
//  count and a non-zero exit if anything failed.
//
//    node tests/docs/docs-live.test.mjs
//
//  Environment:
//    DOCS_API      API base, default http://localhost:5141/api
//    DOCS_PHONES   three OTP phones "owner,employee,otherTenant", default the
//                  local seed numbers (+919999900002/3/4). The local stack
//                  must have sms.show_otp_on_screen = true.
//    DOCS_ADMIN    "email,password" of the platform operator (super_admin),
//                  who turns Docs on per organisation. Default the local
//                  BOOTSTRAP_ADMIN_* values in the preview launcher.
//    DOCS_TENANTS  "owner's tenant,other tenant", default the two seed tenants.
//
//  Starts from Docs OFF for both tenants (a fresh database) and turns it on
//  through the operator's route, so the switch itself is under test.
//
//  NOT for production: it signs in with on-screen OTP codes and creates
//  documents. It is the proof that goes with the Docs pull request.
//
//  TRAP, measured: the OTP request returns devCode ONLY on the first request
//  inside the 60 s resend throttle. Re-running within a minute gets no code
//  and the sign-in step fails — wait a minute between runs.
// ============================================================================

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../apps/web/package.json'));
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');

const API = process.env.DOCS_API ?? 'http://localhost:5141/api';
const [OWNER, EMPLOYEE, OTHER] = (process.env.DOCS_PHONES ?? '+919999900002,+919999900003,+919999900004').split(',');
const [ADMIN_EMAIL, ADMIN_PASSWORD] = (process.env.DOCS_ADMIN ?? 'platform@docs.local,dev-only-platform-pass').split(',');
const [TENANT_A, TENANT_C] = (process.env.DOCS_TENANTS
  ?? '11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222').split(',');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- HTTP ------------------------------------------------------------------

async function signIn(phone) {
  const r1 = await fetch(`${API}/auth/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
  });
  const b1 = await r1.json().catch(() => ({}));
  if (!b1.devCode) throw new Error(`no devCode for ${phone.slice(0, 6)}… (status ${r1.status}); wait 60 s and rerun`);
  const r2 = await fetch(`${API}/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: b1.devCode }),
  });
  const b2 = await r2.json();
  if (!b2.accessToken) throw new Error(`verify failed for ${phone.slice(0, 6)}… (status ${r2.status})`);
  return { token: b2.accessToken, id: b2.user?.id };
}

function client(who) {
  return async (p, init = {}) => {
    const isForm = init.body instanceof FormData;
    const res = await fetch(`${API}${p}`, {
      ...init,
      headers: {
        ...(isForm || init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${who.token}`,
        ...(init.headers ?? {}),
      },
    });
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  };
}

// ---- the live channel --------------------------------------------------------

const MSG = { update: 1, awareness: 2, ack: 4, synced: 5, event: 6, state: 7 };
const seqOf = (b) => Number(new DataView(b.buffer, b.byteOffset + 1, 8).getBigInt64(0));

/** A minimal browser: a Y.Doc wired to the socket the way lib/docsLive.ts wires it. */
// ticketIn: open with a ticket taken earlier, as a browser that fetched one
// just before something changed would.
async function connect(call, id, label, ticketIn) {
  const t = ticketIn ? { status: 200, body: { ticket: ticketIn } }
    : await call(`/docs/${id}/live-ticket`, { method: 'POST' });
  if (t.status !== 200) return { refused: t.status };
  const url = API.replace(/^http/, 'ws') + `/docs/${id}/live?ticket=${encodeURIComponent(t.body.ticket)}`;
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const s = { doc, awareness, events: [], acks: [], updatesIn: 0, awarenessIn: [], lastSeq: 0, stateSeq: null,
    synced: false, closed: null, ticket: t.body.ticket, label, sent: [] };
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  ws.onmessage = (ev) => {
    const b = new Uint8Array(ev.data);
    switch (b[0]) {
      case MSG.state: s.stateSeq = seqOf(b); if (b.length > 9) Y.applyUpdate(doc, b.subarray(9), 'server'); break;
      case MSG.update: s.updatesIn += 1; s.lastSeq = Math.max(s.lastSeq, seqOf(b)); Y.applyUpdate(doc, b.subarray(9), 'server'); break;
      case MSG.ack: s.acks.push(seqOf(b)); s.lastSeq = Math.max(s.lastSeq, seqOf(b)); break;
      case MSG.synced: s.synced = true; s.lastSeq = Math.max(s.lastSeq, seqOf(b)); break;
      case MSG.event: s.events.push(JSON.parse(new TextDecoder().decode(b.subarray(1)))); break;
      case MSG.awareness: s.awarenessIn.push(b.subarray(1)); awarenessProtocol.applyAwarenessUpdate(awareness, b.subarray(1), 'server'); break;
    }
  };
  ws.onclose = (ev) => { s.closed = { code: ev.code, reason: ev.reason }; };
  doc.on('update', (u, origin) => {
    if (origin === 'server') return;
    const f = new Uint8Array(u.length + 1); f[0] = MSG.update; f.set(u, 1);
    s.sent.push(f);
    if (ws.readyState === WebSocket.OPEN) ws.send(f);
  });
  s.sendAwareness = (state) => {
    awareness.setLocalState(state);
    const u = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]);
    const f = new Uint8Array(u.length + 1); f[0] = MSG.awareness; f.set(u, 1);
    ws.send(f);
  };
  for (let i = 0; i < 50 && !s.synced && !s.closed; i += 1) await sleep(100);
  return s;
}

const textOf = (doc) => doc.getXmlFragment('default').toString().replace(/<[^>]+>/g, '');

function appendParagraph(doc, text) {
  const frag = doc.getXmlFragment('default');
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText(text)]);
    frag.insert(frag.length, [p]);
  });
}

async function waitFor(fn, ms = 3000) {
  for (let i = 0; i < ms / 50; i += 1) { if (fn()) return true; await sleep(50); }
  return fn();
}

const toB64 = (u8) => Buffer.from(u8).toString('base64');

// ============================================================================

// ---- the render service (0011 condition 1) ------------------------------------
// This test owns it: started here on DOCS_RENDER_PORT (the API's
// Docs:RenderUrl must point at it — tests/docs/run-docs-live.sh does that),
// stopped mid-run to prove a failed render fails the save, started again.
const RENDER_PORT = Number(process.env.DOCS_RENDER_PORT ?? 18450);
// The API talks to a PROXY on RENDER_PORT (Docs:RenderUrl); the real service
// runs on RENDER_PORT + 1. The proxy lets the test hold render requests and
// release them in the order it chooses (two saves at once), with no test
// hook in production code. With the real service stopped it answers 502,
// which the API must treat as a failed render.
const REAL_PORT = RENDER_PORT + 1;
const held = [];
let holding = false;
// The NEXT /render/doc request is answered by this function instead of the
// real service: a 504, a 200 missing its fields, or a dropped connection.
// Each is a failure DocsRenderClient.PostAsync must turn into a refused save
// (Mr. Singh on PR 391, 7 Oct 2026: which test drives each failure mode
// through the shared POST path). No hook in production code.
let injectNext = null;
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (injectNext && req.url === '/render/doc') { const answer = injectNext; injectNext = null; answer(req, res); return; }
    const forward = () => {
      const up = http.request({ host: '127.0.0.1', port: REAL_PORT, path: req.url, method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' } }, (r) => {
        res.writeHead(r.statusCode ?? 502, { 'content-type': r.headers['content-type'] ?? 'application/json' });
        r.pipe(res);
      });
      up.on('error', () => { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"render service down"}'); });
      up.end(Buffer.concat(chunks));
    };
    if (holding && req.url === '/render/doc') held.push(forward); else forward();
  });
});
let renderChild = null;
async function startRender() {
  const dir = path.join(here, '../../apps/render');
  renderChild = spawn(process.execPath, ['--import', './src/register.mjs', 'src/server.mjs'],
    { cwd: dir, env: { ...process.env, PORT: String(REAL_PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 300; i += 1) { // up to 30 s: a cold start beside the API can take >10 s
    try { if ((await fetch(`http://127.0.0.1:${REAL_PORT}/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}
function stopRender() { if (renderChild) { renderChild.kill(); renderChild = null; } }
function stopAll() { stopRender(); proxy.close(); proxy.closeAllConnections?.(); }

// SQL for the two checks only a database can set up (the browser-file guard).
// TATVAOS_PSQL is exported by tests/lib/throwaway-db.sh: "<psql> -d <db> -Atc".
function pg(sql) {
  if (!process.env.TATVAOS_PSQL) throw new Error('TATVAOS_PSQL not set: run through tests/docs/run-docs-live.sh');
  return execSync(`${process.env.TATVAOS_PSQL} "${sql}"`, { encoding: 'utf8' })
    .split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l && !l.startsWith('wsl:')).pop() ?? '';
}

async function main() {
  console.log(`Docs end-to-end against ${API}\n`);
  await new Promise((r) => proxy.listen(RENDER_PORT, '127.0.0.1', r));
  if (!(await startRender())) throw new Error(`the render service did not start on ${REAL_PORT}`);

  // The browser's state/HTML/text were accepted and ignored for a grace
  // period, then REMOVED on 3 Oct 2026, past the end date Mr. Singh set (by
  // 14 Oct 2026). This keeps them out: the API's request records must carry
  // only what the server reads. Red on main before the removal (both found).
  // The calls below still SEND those fields, as an old tab would: they must
  // be skipped, and nothing they carry may reach the file.
  const endpoints = readFileSync(path.join(here, '../../apps/api/Modules/Docs/DocsEndpoints.cs'), 'utf8');
  const leftovers = [
    /record CheckpointRequest\([^)]*\b(State|Html|Text)\b/.test(endpoints) && 'CheckpointRequest',
    /record VersionRequest\([^)]*\b(State|Html)\b/.test(endpoints) && 'VersionRequest',
  ].filter(Boolean);
  check('the browser\'s old fields are gone from Docs\' requests (removed 3 Oct 2026)', leftovers.length === 0,
    `still there: ${leftovers.join(', ')}`);

  const owner = await signIn(OWNER);
  const employee = await signIn(EMPLOYEE);
  const other = await signIn(OTHER);
  const A = client(owner), B = client(employee), C = client(other);

  const login = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const adminBody = await login.json().catch(() => ({}));
  if (!adminBody.accessToken) throw new Error(`platform operator sign-in failed (status ${login.status})`);
  const P = client({ token: adminBody.accessToken });

  // ---- the switch: Docs is off until the operator turns it on ---------------
  // A fresh database has no switch row, which IS off. A database an earlier
  // run left on is put back to off first, and the run says so.
  console.log('Switched off by default');
  const found = await A('/docs/status');
  if (found.body?.enabled) {
    console.log('  (Docs was left on by an earlier run; switching it off first)');
    await P(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    await P(`/admin/organisations/${TENANT_C}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  }
  const off = await A('/docs/status');
  check('Docs reports off for a fresh organisation', off.status === 200 && off.body.enabled === false,
    JSON.stringify(off.body));
  const offCreate = await A('/docs', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
  check('creating a document while off is refused (403 docs_off)', offCreate.status === 403 && offCreate.body.reason === 'docs_off',
    `status ${offCreate.status}`);
  check('listing while off is refused', (await A('/docs?view=recent')).status === 403);
  const selfOn = await A(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  check('an organisation owner cannot switch Docs on (403)', selfOn.status === 403, `status ${selfOn.status}`);
  check('Docs is still off after that attempt', (await A('/docs/status')).body.enabled === false);
  const onA = await P(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const onC = await P(`/admin/organisations/${TENANT_C}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  check('the platform operator switches Docs on for both organisations', onA.status === 200 && onC.status === 200,
    `status ${onA.status}/${onC.status}`);
  check('Docs now reports on', (await A('/docs/status')).body.enabled === true);

  // ---- create + visibility -------------------------------------------------
  console.log('Create and visibility');
  const created = await A('/docs', { method: 'POST', body: JSON.stringify({ title: 'E2E plan', scope: 'personal' }) });
  check('owner creates a document (201)', created.status === 201, `status ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.id;

  const aGet = await A(`/docs/${id}`);
  check('owner sees it with level owner', aGet.status === 200 && aGet.body.myPermission === 'owner', JSON.stringify(aGet.body));
  // Calibrates the next two: the same call as the owner answered 200 just above.
  check('unshared colleague gets 404, not 403', (await B(`/docs/${id}`)).status === 404);
  check('other organisation gets 404', (await C(`/docs/${id}`)).status === 404);
  check('other organisation cannot get a live ticket', (await C(`/docs/${id}/live-ticket`, { method: 'POST' })).status === 404);
  const cList = await C('/docs?view=recent');
  check('other organisation\'s list does not include it',
    cList.status === 200 && !cList.body.documents.some((d) => d.id === id));
  const aList = await A('/docs?view=owned');
  check('owner\'s "owned" list includes it (list query sees own rows)',
    aList.status === 200 && aList.body.documents.some((d) => d.id === id));

  // ---- live editing ----------------------------------------------------------
  console.log('Live editing');
  const a1 = await connect(A, id, 'owner');
  check('owner connects and is told level owner', a1.synced && a1.events.some((e) => e.type === 'perm' && e.perm === 'owner'),
    JSON.stringify({ synced: a1.synced, closed: a1.closed, events: a1.events }));
  const permFirst = a1.events.findIndex((e) => e.type === 'perm');
  check('level arrives before "synced" (the browser needs it to resend offline edits)', permFirst === 0);

  appendParagraph(a1.doc, 'Hello');
  check('owner\'s update is acked with a seq', await waitFor(() => a1.acks.length >= 1), `acks ${a1.acks}`);

  const reuse = await (async () => {
    const url = API.replace(/^http/, 'ws') + `/docs/${id}/live?ticket=${encodeURIComponent(a1.ticket)}`;
    const ws = new WebSocket(url);
    return new Promise((res) => { ws.onopen = () => { ws.close(); res('opened'); }; ws.onerror = () => res('refused'); });
  })();
  check('a used ticket cannot open a second connection', reuse === 'refused', reuse);

  // Share with the employee as a VIEWER.
  const share = await A(`/space/files/${id}/shares`, { method: 'PUT', body: JSON.stringify({ userId: employee.id, permission: 'view' }) });
  check('owner shares it with the employee as viewer', share.status === 200 || share.status === 201, `status ${share.status}`);

  const b1 = await connect(B, id, 'employee-viewer');
  check('viewer connects, is told level view', b1.synced && b1.events.some((e) => e.type === 'perm' && e.perm === 'view'),
    JSON.stringify({ closed: b1.closed, events: b1.events }));
  check('viewer receives the owner\'s text from the database', textOf(b1.doc) === 'Hello', JSON.stringify(textOf(b1.doc)));

  const ownerUpdatesBefore = a1.updatesIn;
  appendParagraph(b1.doc, 'VIEWER WROTE THIS');
  // Kept byte for byte: the calibration below re-sends this exact frame.
  const viewerFrame = b1.sent[b1.sent.length - 1];
  check('viewer\'s edit is refused with a readonly event', await waitFor(() => b1.events.some((e) => e.type === 'readonly')));
  await sleep(300);
  check('viewer\'s edit never reaches the owner', a1.updatesIn === ownerUpdatesBefore && !textOf(a1.doc).includes('VIEWER'));
  b1.ws.close();
  const bFresh = await connect(B, id, 'viewer-reload');
  check('viewer\'s edit was not stored (a fresh load does not have it)', !textOf(bFresh.doc).includes('VIEWER'), textOf(bFresh.doc));
  bFresh.ws.close();

  // Upgrade to EDITOR and edit live.
  await A(`/space/files/${id}/shares`, { method: 'PUT', body: JSON.stringify({ userId: employee.id, permission: 'edit' }) });
  const b2 = await connect(B, id, 'employee-editor');
  check('editor connects, is told level edit', b2.events.some((e) => e.type === 'perm' && e.perm === 'edit'));
  appendParagraph(b2.doc, 'world');
  check('editor\'s edit reaches the owner live', await waitFor(() => textOf(a1.doc) === 'Helloworld'), JSON.stringify(textOf(a1.doc)));
  check('both converge to the same content', textOf(a1.doc) === textOf(b2.doc));

  // Concurrent edits from both at once still converge.
  appendParagraph(a1.doc, 'A-one'); appendParagraph(b2.doc, 'B-one');
  appendParagraph(a1.doc, 'A-two'); appendParagraph(b2.doc, 'B-two');
  await waitFor(() => textOf(a1.doc).length === textOf(b2.doc).length && textOf(a1.doc).includes('B-two') && textOf(b2.doc).includes('A-two'));
  check('simultaneous edits converge', textOf(a1.doc) === textOf(b2.doc) && textOf(a1.doc).includes('A-two') && textOf(a1.doc).includes('B-two'),
    `${textOf(a1.doc)} vs ${textOf(b2.doc)}`);

  // CALIBRATION of the viewer checks above, by raising the fixture rather
  // than weakening the code (Mr. Singh, PR 273): the SAME person, now an
  // editor, sends the IDENTICAL frame the server refused from them as a
  // viewer. It must now be stored and relayed. If the level check dropped
  // every update regardless of level, this goes red; if it keyed on anything
  // but the level, the earlier refusal would not have happened.
  const ownerInBefore = a1.updatesIn;
  b2.ws.send(viewerFrame);
  check('calibration: the refused viewer frame, re-sent at edit level, is accepted and relayed',
    await waitFor(() => a1.updatesIn > ownerInBefore && textOf(a1.doc).includes('VIEWER WROTE THIS')),
    `owner text ${JSON.stringify(textOf(a1.doc))}`);

  // Presence.
  b2.sendAwareness({ user: { name: 'Employee', color: '#1a73e8' } });
  check('presence (awareness) reaches the other editor',
    await waitFor(() => [...a1.awareness.getStates().values()].some((s) => s.user?.name === 'Employee')));
  b2.ws.close();
  check('presence is withdrawn when the tab closes',
    await waitFor(() => ![...a1.awareness.getStates().values()].some((s) => s.user?.name === 'Employee')));

  // ---- checkpoint --------------------------------------------------------------
  // The server builds the file from what IT stored (0011 condition 1; Mr.
  // Singh, 29-30 Sept 2026). A checkpoint is "save now": the state, HTML and
  // text a browser sends are accepted for one release and IGNORED.
  console.log('Checkpoint and reload (the file is built by the server)');
  const lie = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: toB64(new Uint8Array([0, 0])), upToSeq: a1.lastSeq + 1000,
    html: '<p>Fees 5,000</p>', text: 'Fees 5,000' }) });
  check('a checkpoint whose file and state say something else is taken as "save now" (200)',
    lie.status === 200 && lie.body.saved === true, `status ${lie.status} ${JSON.stringify(lie.body)}`);
  const lieDl = String((await A(`/space/files/${id}/content`)).body);
  check('MR. SINGH\'S PROOF: a checkpoint with a mismatching file does not change what Space serves — it serves the document',
    lieDl.includes('<p>Hello</p>') && lieDl.includes('B-two') && !lieDl.includes('Fees 5,000'),
    `Hello=${lieDl.includes('<p>Hello</p>')} B-two=${lieDl.includes('B-two')} lie=${lieDl.includes('Fees 5,000')}`);

  const cp = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: a1.lastSeq }) });
  check('a save with nothing new since the last one changes nothing (200, unchanged)',
    cp.status === 200 && cp.body.unchanged === true, `status ${cp.status} ${JSON.stringify(cp.body)}`);

  // A colleague's edit the SAVING browser never saw is in the file: the
  // server merges what it stored, it does not take one browser's state.
  const b3 = await connect(B, id, 'employee-editor-late');
  appendParagraph(b3.doc, 'COLLEAGUE WROTE THIS');
  check('the colleague\'s edit is acked', await waitFor(() => b3.acks.length >= 1));
  b3.ws.close();
  const blindState = new Y.Doc(); // the owner's browser, as if it had not received the colleague's edit
  Y.applyUpdate(blindState, Y.encodeStateAsUpdate(a1.doc));
  const blind = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: toB64(Y.encodeStateAsUpdate(blindState)), upToSeq: 0, html: '<p>Hello</p>', text: 'Hello' }) });
  const blindDl = String((await A(`/space/files/${id}/content`)).body);
  check('a colleague\'s stored edit the saving browser never saw is in the file',
    blind.status === 200 && blindDl.includes('COLLEAGUE WROTE THIS'), `status ${blind.status}`);
  const a1Seen = await waitFor(() => textOf(a1.doc).includes('COLLEAGUE WROTE THIS'));
  check('…and it reached the owner live, as everyone\'s edits do', a1Seen);

  const a2 = await connect(A, id, 'owner-reload');
  check('a fresh load starts from the compacted state', a2.stateSeq === a1.lastSeq, `stateSeq ${a2.stateSeq} vs ${a1.lastSeq}`);
  check('a fresh load has the full text', textOf(a2.doc) === textOf(a1.doc), `${textOf(a2.doc)} vs ${textOf(a1.doc)}`);
  a2.ws.close();

  const dl = await A(`/space/files/${id}/content`);
  check('Space download is the HTML rendering, named .html',
    dl.status === 200 && /E2E plan\.html/.test(dl.headers.get('content-disposition') ?? '') && String(dl.body).includes('<p>Hello</p>'),
    `status ${dl.status} cd=${dl.headers.get('content-disposition')}`);
  check('the downloaded page carries a script-forbidding CSP', String(dl.body).includes("default-src 'none'"));

  const form = new FormData();
  form.append('sizeBytes', '3');
  form.append('file', new Blob(['abc']), 'x.txt');
  const over = await A(`/space/files/${id}/content`, { method: 'PUT', body: form });
  check('Space refuses to overwrite a document\'s bytes (409)', over.status === 409, `status ${over.status}`);

  // ---- versions ------------------------------------------------------------------
  console.log('Versions');
  const v1 = await A(`/docs/${id}/versions`);
  check('the first checkpoint took an automatic version', v1.status === 200 && v1.body.versions.some((v) => v.kind === 'auto'),
    JSON.stringify(v1.body));
  // The version is the server's stored document (the body names it, nothing more).
  const named = await A(`/docs/${id}/versions`, { method: 'POST', body: JSON.stringify({
    kind: 'named', name: 'Draft v1', state: toB64(new Uint8Array([0, 0])), html: '<p>not this</p>' }) });
  check('owner names a version (201)', named.status === 201, `status ${named.status}`);
  const one = await A(`/docs/${id}/versions/${named.body.id}`);
  const rebuilt = new Y.Doc(); Y.applyUpdate(rebuilt, Buffer.from(one.body.state, 'base64'));
  check('a version\'s state rebuilds to the text it was taken from', textOf(rebuilt) === textOf(a1.doc));
  check('other organisation cannot read versions', (await C(`/docs/${id}/versions/${named.body.id}`)).status === 404);

  // ---- the HTML that is stored ------------------------------------------------------
  // The browser's HTML is never stored now. What can still reach the file is
  // what is IN the document, so the hostile parts go in through the live
  // channel, as an attacker with edit access would have to put them: a link
  // to javascript: and a picture over http. The file comes from the render
  // service AND is cleaned (DocsHtml.cs) — two layers; here, that the chain
  // as a whole lets neither through, and keeps the words around them.
  console.log('The HTML that is stored (hostile content IN the document)');
  const acksBeforeHostile = a1.acks.length; // counted from here: a1 was acked for earlier edits already
  a1.doc.transact(() => {
    const frag = a1.doc.getXmlFragment('default');
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'Words that stay ');
    t.insert(t.length, 'a link', { link: { href: 'javascript:steal()', target: '_blank', rel: 'noopener', class: null } });
    p.insert(0, [t]);
    const img = new Y.XmlElement('image');
    img.setAttribute('src', 'http://pictures.example/y.png');
    img.setAttribute('alt', 'A chart');
    p.insert(1, [img]);
    frag.insert(frag.length, [p]);
  });
  check('the hostile paragraph is acked', await waitFor(() => a1.acks.length > acksBeforeHostile));
  const browserHostile = '<p onclick="steal()">BROWSER SENT THIS</p><script>steal(document.cookie)</script>';
  const hostileCp = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    upToSeq: a1.lastSeq, html: browserHostile, text: 'BROWSER SENT THIS' }) });
  check('the save is accepted (200)', hostileCp.status === 200 && hostileCp.body.saved === true,
    `status ${hostileCp.status} ${JSON.stringify(hostileCp.body)}`);
  const hostileDl = String((await A(`/space/files/${id}/content`)).body);
  const gone = ['javascript:', 'steal(', 'http://pictures.example', 'BROWSER SENT THIS', '<script', 'onclick'];
  check('Space\'s copy holds none of the hostile parts, and nothing the browser sent',
    gone.every((g) => !hostileDl.includes(g)), gone.filter((g) => hostileDl.includes(g)).join(' | '));
  check('…and keeps the words, the link text and the picture (over https)',
    ['Words that stay', 'a link', 'src="https://pictures.example/y.png"'].every((k) => hostileDl.includes(k)),
    ['Words that stay', 'a link', 'src="https://pictures.example/y.png"'].filter((k) => !hostileDl.includes(k)).join(' | '));

  const hostileV = await A(`/docs/${id}/versions`, { method: 'POST', body: JSON.stringify({
    kind: 'named', name: 'Hostile', html: browserHostile }) });
  const hostileRead = String((await A(`/docs/${id}/versions/${hostileV.body.id}`)).body.html);
  check('a version\'s HTML holds none of the hostile parts, and nothing the browser sent',
    hostileV.status === 201 && gone.every((g) => !hostileRead.includes(g)), gone.filter((g) => hostileRead.includes(g)).join(' | '));
  check('…and keeps the words', hostileRead.includes('Words that stay') && hostileRead.includes('Hello'));

  // ---- a failed render fails the save, visibly ------------------------------------
  // Mr. Singh, 30 Sept 2026: "a failed render is a failed save, shown to the
  // person — never a silent fallback to the browser's HTML".
  console.log('The render service stops (a failed render fails the save)');
  const fileBefore = String((await A(`/space/files/${id}/content`)).body);
  stopRender();
  const acksBeforeDown = a1.acks.length;
  appendParagraph(a1.doc, 'TYPED WHILE DOWN');
  check('typing still reaches the server while the renderer is down (acked)', await waitFor(() => a1.acks.length > acksBeforeDown));
  const down = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    upToSeq: a1.lastSeq, html: '<p>TYPED WHILE DOWN</p><p>BROWSER COPY</p>', text: 'BROWSER COPY' }) });
  check('the save FAILS, and says why: 503 render_failed with a sentence',
    down.status === 503 && down.body.reason === 'render_failed' && /typing is safe/.test(down.body.error ?? ''),
    `status ${down.status} ${JSON.stringify(down.body)}`);
  const fileDuring = String((await A(`/space/files/${id}/content`)).body);
  check('…Space\'s file is unchanged — not the browser\'s copy',
    fileDuring === fileBefore && !fileDuring.includes('BROWSER COPY'), `changed=${fileDuring !== fileBefore}`);
  const downV = await A(`/docs/${id}/versions`, { method: 'POST', body: JSON.stringify({ kind: 'named', name: 'While down' }) });
  check('…and a version is refused the same way (503)', downV.status === 503 && downV.body.reason === 'render_failed');
  check('the render service comes back', await startRender());
  const upAgain = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: a1.lastSeq }) });
  const fileAfter = String((await A(`/space/files/${id}/content`)).body);
  check('the next save works, and the typing done while it was down is in the file',
    upAgain.status === 200 && fileAfter.includes('TYPED WHILE DOWN') && !fileAfter.includes('BROWSER COPY'),
    `status ${upAgain.status} ${JSON.stringify(upAgain.body)}`);

  // ---- every other way the render can fail, through the same POST path ------------
  // The service stopped (above) is "unreachable behind a proxy that answers
  // 502". These are the rest of DocsRenderClient.PostAsync's failures: the
  // service's own 504 (over its limit), a 200 that lacks the fields a save
  // needs, and a connection dropped mid-request. Each must refuse the save
  // visibly (503 render_failed) and leave Space's file untouched.
  console.log('Every other render failure refuses the save, visibly');
  const failures = [
    ['the render service answers 504 (over its limit)', (_q, r) => { r.writeHead(504, { 'content-type': 'application/json' }); r.end('{"error":"render timed out","limitMs":10000}'); }],
    ['the render service answers 200 without html and text (an incomplete answer)', (_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"state":"AAA=","schema":"docs-1"}'); }],
    ['the connection is dropped mid-request (unreachable)', (q) => { q.socket.destroy(); }],
  ];
  for (const [label, answer] of failures) {
    const before = String((await A(`/space/files/${id}/content`)).body);
    const acks = a1.acks.length;
    appendParagraph(a1.doc, `TYPED BEFORE: ${label}`);
    await waitFor(() => a1.acks.length > acks);
    injectNext = answer;
    const failed = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: a1.lastSeq }) });
    check(`${label}: the save is refused (503 render_failed)`, failed.status === 503 && failed.body?.reason === 'render_failed',
      `status ${failed.status} ${JSON.stringify(failed.body)}`);
    check('…the injected answer was really used (calibration)', injectNext === null);
    check("…and Space's file is unchanged", String((await A(`/space/files/${id}/content`)).body) === before);
  }
  const recovered = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: a1.lastSeq }) });
  check('after all three, the next save works and carries the typing', recovered.status === 200
    && String((await A(`/space/files/${id}/content`)).body).includes('TYPED BEFORE: the connection is dropped'),
    `status ${recovered.status} ${JSON.stringify(recovered.body)}`);

  // ---- two saves at once: an older build never overwrites a newer file -------------
  // Mr. Singh, 30 Sept 2026. The render runs outside the editing lock, so
  // two saves can build at once and finish in either order. The proxy holds
  // both render requests (each save has taken its snapshot by then) and
  // releases them in the order each case needs.
  console.log('Two saves at once (an older build never overwrites a newer file)');
  const save = () => A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: a1.lastSeq }) });
  async function twoSaves(olderText, newerText) {
    holding = true;
    let acks = a1.acks.length;
    appendParagraph(a1.doc, olderText);
    await waitFor(() => a1.acks.length > acks);
    const older = save();
    await waitFor(() => held.length === 1);
    acks = a1.acks.length;
    appendParagraph(a1.doc, newerText);
    await waitFor(() => a1.acks.length > acks);
    const newer = save();
    await waitFor(() => held.length === 2);
    holding = false;
    return { older, newer, releaseOlder: held[0], releaseNewer: held[1] };
  }

  // Mr. Singh's case: the NEWER build finishes first, the OLDER one last.
  let pair = await twoSaves('OLDER EDIT', 'NEWER EDIT');
  check('both saves were building at once (the proxy held two render requests)', held.length === 2);
  pair.releaseNewer();
  const newerFirst = await pair.newer;
  pair.releaseOlder();
  const olderLast = await pair.older;
  held.length = 0;
  let file = String((await A(`/space/files/${id}/content`)).body);
  check('the newer build, finishing first, is written (200 saved)',
    newerFirst.status === 200 && newerFirst.body.saved === true, `status ${newerFirst.status} ${JSON.stringify(newerFirst.body)}`);
  check('THE OLDER BUILD, FINISHING LAST, IS DISCARDED (stale) — not written over the newer file',
    olderLast.status === 200 && olderLast.body.stale === true && olderLast.body.saved === false,
    `status ${olderLast.status} ${JSON.stringify(olderLast.body)}`);
  check('…and the file is the newer one (it holds the newer edit, and the older one before it)',
    file.includes('NEWER EDIT') && file.includes('OLDER EDIT'), `newer=${file.includes('NEWER EDIT')} older=${file.includes('OLDER EDIT')}`);

  // The reverse order: the OLDER build finishes first, the NEWER after it.
  // The newer one must still be written — the first version of the check
  // threw it away because the stored state had moved.
  pair = await twoSaves('OLDER EDIT 2', 'NEWER EDIT 2');
  pair.releaseOlder();
  const olderFirst = await pair.older;
  pair.releaseNewer();
  const newerLast = await pair.newer;
  held.length = 0;
  file = String((await A(`/space/files/${id}/content`)).body);
  check('the older build, finishing first, is written (it was newer than the stored file then)',
    olderFirst.status === 200 && olderFirst.body.saved === true, `status ${olderFirst.status} ${JSON.stringify(olderFirst.body)}`);
  check('THE NEWER BUILD, FINISHING AFTER IT, IS WRITTEN TOO — not thrown away',
    newerLast.status === 200 && newerLast.body.saved === true && file.includes('NEWER EDIT 2'),
    `status ${newerLast.status} ${JSON.stringify(newerLast.body)} newer-in-file=${file.includes('NEWER EDIT 2')}`);

  // ---- comments -------------------------------------------------------------------
  console.log('Comments');
  const c1 = await B(`/docs/${id}/comments`, { method: 'POST', body: JSON.stringify({
    body: 'Please check this', anchor: JSON.stringify({ from: {}, to: {} }), quote: 'Hello' }) });
  check('editor comments (201)', c1.status === 201, `status ${c1.status} ${JSON.stringify(c1.body)}`);
  const r1 = await A(`/docs/${id}/comments/${c1.body.id}/replies`, { method: 'POST', body: JSON.stringify({ body: 'Done' }) });
  check('owner replies (201)', r1.status === 201);
  const res = await A(`/docs/${id}/comments/${c1.body.id}`, { method: 'PATCH', body: JSON.stringify({ resolved: true }) });
  check('owner resolves the thread', res.status === 200);
  const list = await B(`/docs/${id}/comments`);
  const t = list.body.threads?.find((x) => x.id === c1.body.id);
  check('thread shows the reply and the resolution', t && t.replies.length === 1 && t.resolvedAt, JSON.stringify(t));
  const notMine = await A(`/docs/${id}/comments/${c1.body.id}`, { method: 'PATCH', body: JSON.stringify({ body: 'rewritten' }) });
  check('nobody edits someone else\'s words (403)', notMine.status === 403, `status ${notMine.status}`);
  check('other organisation cannot list comments', (await C(`/docs/${id}/comments`)).status === 404);

  await A(`/space/files/${id}/shares`, { method: 'PUT', body: JSON.stringify({ userId: employee.id, permission: 'view' }) });
  const viewerComment = await B(`/docs/${id}/comments`, { method: 'POST', body: JSON.stringify({ body: 'x' }) });
  check('a viewer cannot comment (403)', viewerComment.status === 403, `status ${viewerComment.status}`);
  await A(`/space/files/${id}/shares`, { method: 'PUT', body: JSON.stringify({ userId: employee.id, permission: 'comment' }) });
  const commenter = await B(`/docs/${id}/comments`, { method: 'POST', body: JSON.stringify({ body: 'as commenter' }) });
  check('a commenter can comment (201)', commenter.status === 201, `status ${commenter.status}`);
  const commenterCp = await B(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: toB64(new Uint8Array([0, 0])), upToSeq: 0, html: '', text: '' }) });
  check('a commenter cannot save content (403)', commenterCp.status === 403, `status ${commenterCp.status}`);

  // ---- pictures ------------------------------------------------------------------
  console.log('Pictures');
  const png = Buffer.from('89504E470D0A1A0A0000000D4948445200000001000000010806000000'
    + '1F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
  const pf = new FormData(); pf.append('file', new Blob([png], { type: 'image/png' }), 'dot.png');
  const up = await A(`/docs/${id}/images`, { method: 'POST', body: pf });
  check('owner adds a PNG (201)', up.status === 201, `status ${up.status} ${JSON.stringify(up.body)}`);
  const img = await fetch(`${API}${up.body.src.replace(/^\/api/, '')}`, { headers: { Authorization: `Bearer ${owner.token}` } });
  check('the picture is served back as image/png', img.status === 200 && img.headers.get('content-type') === 'image/png');
  const imgOther = await fetch(`${API}${up.body.src.replace(/^\/api/, '')}`, { headers: { Authorization: `Bearer ${other.token}` } });
  check('other organisation cannot fetch the picture (404)', imgOther.status === 404, `status ${imgOther.status}`);
  const svg = new FormData(); svg.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    { type: 'image/png' }), 'evil.png');
  const svgUp = await A(`/docs/${id}/images`, { method: 'POST', body: svg });
  check('an SVG claiming to be a PNG is refused (415)', svgUp.status === 415, `status ${svgUp.status}`);

  // ---- per-person connection cap ------------------------------------------------------
  console.log('Connection cap');
  // The owner already holds one connection (a1). Nineteen more reach the cap
  // of twenty; each must sync (the control), and the next must be told 4429.
  const extra = [];
  for (let i = 0; i < 19; i += 1) extra.push(await connect(A, id, `cap-${i}`));
  check('up to twenty connections per person all sync', extra.every((x) => x.synced),
    // Says WHICH one and HOW it failed: "18/19 synced" (28 Sept) could not be
    // told apart from a refused ticket, a close, or a sync that took too long.
    `${extra.filter((x) => x.synced).length}/19 synced; ` + extra.map((x, i) => (x.synced ? null
      : `cap-${i}: ${x.refused ? `ticket refused ${x.refused}` : x.closed ? `closed ${x.closed.code} ${x.closed.reason}` : 'no sync within 5 s, still open'}`))
      .filter(Boolean).join('; ')
      // Found by 28 Sept 2026, after this failed 2 runs in 9 and looked like
      // timing. It was not: both times a browser tab was signed in as this
      // test's owner with a document open, holding one of the twenty.
      // Reproduced on purpose (one held connection -> exactly this line).
      + (extra.some((x) => x.closed?.code === 4429)
        ? ' — the cap was reached EARLY: this person holds a connection this test did not open. Close any browser tab signed in as the owner this test uses, and run again.'
        : ''));
  const overCap = await connect(A, id, 'cap-over');
  await waitFor(() => overCap.closed);
  check('the twenty-first is closed with 4429', overCap.closed?.code === 4429, JSON.stringify(overCap.closed));
  extra.forEach((x) => x.ws.close());
  await sleep(500);
  const after = await connect(A, id, 'cap-after');
  check('closing tabs frees the slots again', after.synced, JSON.stringify(after.closed));
  after.ws.close();

  // ---- removing access ends an open session --------------------------------------------
  console.log('Access removed while open (waits up to 50 s for the recheck)');
  const bOpen = await connect(B, id, 'employee-open');
  check('the commenter is connected', bOpen.synced);
  const shares = await A(`/space/files/${id}/shares`);
  const mine = shares.body.shares?.find((s) => s.userId === employee.id);
  const un = await A(`/space/files/${id}/shares/${mine?.id}`, { method: 'DELETE' });
  check('owner removes the share', un.status === 200 || un.status === 204, `status ${un.status}`);
  await waitFor(() => bOpen.closed, 50_000);
  check('the open session is closed with 4403 (do not reconnect)', bOpen.closed?.code === 4403, JSON.stringify(bOpen.closed));
  check('and the colleague can no longer open it', (await B(`/docs/${id}`)).status === 404);

  // ---- switching off reaches open editors -------------------------------------------
  console.log('Switched off while open (waits up to 50 s for the recheck)');
  const openBeforeOff = await connect(A, id, 'owner-before-off');
  check('owner is connected before the switch-off', openBeforeOff.synced);
  // A ticket in hand when the switch goes off (tickets live 60 s).
  const heldTicket = (await A(`/docs/${id}/live-ticket`, { method: 'POST' })).body?.ticket;
  const offA = await P(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  check('the operator switches Docs off', offA.status === 200 && offA.body.enabled === false);
  check('Docs is refused at once for new requests', (await A(`/docs/${id}`)).status === 403);
  // Found 28 Sept: opening a connection checked the file and the level but
  // not the switch, so this ticket opened the editor after "off" and kept
  // it until the 45 s recheck — up to ~105 s of editing past the switch.
  const late = await connect(A, id, 'ticket-from-before-off', heldTicket);
  check('a ticket taken before the switch-off cannot open the editor after it',
    heldTicket && !late.synced && late.closed !== null, `synced=${late.synced} closed=${JSON.stringify(late.closed)}`);
  try { late.ws?.close(); } catch { /* already gone */ }
  await waitFor(() => openBeforeOff.closed, 50_000);
  check('the open editor is closed with 4403', openBeforeOff.closed?.code === 4403, JSON.stringify(openBeforeOff.closed));
  // Off withdraws the EDITOR, never the data (0011; Mr. Singh, 28 Sept):
  // while off, Space must still list the file and hand out its readable
  // copy. Until this, the run only showed the document back after
  // switching ON again — which would pass even if "off" hid it.
  const offList = await A('/space/list?scope=personal');
  check('while off, Space still lists the document',
    offList.status === 200 && (offList.body.files ?? []).some((f) => f.id === id),
    `status ${offList.status}`);
  const offDl = await A(`/space/files/${id}/content`);
  check('while off, Space still downloads its readable copy',
    offDl.status === 200 && String(offDl.body).includes('<p>Hello</p>'),
    `status ${offDl.status}`);
  const cStill = await C('/docs/status');
  check('the other organisation is unaffected (still on)', cStill.body.enabled === true);
  await P(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const back = await A(`/docs/${id}`);
  check('switching back on loses nothing (the document is still there)', back.status === 200 && back.body.title === 'E2E plan',
    `status ${back.status}`);

  // ---- the browser-file guard (Mr. Singh, 30 Sept 2026, in place of a backfill) ----
  // Switching Docs on is refused while any of the organisation's files was
  // written by a browser (rendered_seq NULL with checkpoint_at set). Only the
  // database can make such a file now, so the test sets one up directly.
  console.log('The browser-file guard');
  check('this document was built by the server (rendered_seq set)',
    pg(`SELECT rendered_seq IS NOT NULL FROM docs.documents WHERE file_id='${id}'`) === 't');
  pg(`UPDATE docs.documents SET rendered_seq = NULL WHERE file_id='${id}'`);
  // Why the guard needs a definer function: through the app role and RLS, the
  // operator cannot see this document at all, so a plain count reads 0.
  const plain = pg(`SET ROLE tatvaos_app; SELECT set_config('app.tenant_id', '${TENANT_A}', false); `
    + `SELECT count(*) FROM docs.documents WHERE rendered_seq IS NULL AND checkpoint_at IS NOT NULL`);
  const definer = pg(`SELECT docs.browser_written_count('${TENANT_A}')`);
  check('calibration: a plain count through RLS reads 0 — the definer function reads 1', plain === '0' && definer === '1',
    `plain ${plain}, definer ${definer}`);
  await P(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  const guarded = await P(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  check('switching Docs on is REFUSED while a browser-written file exists (409 browser_files, with the count)',
    guarded.status === 409 && guarded.body.reason === 'browser_files' && guarded.body.count === 1,
    `status ${guarded.status} ${JSON.stringify(guarded.body)}`);
  check('…and Docs stays off', (await A('/docs/status')).body.enabled === false);
  pg(`UPDATE docs.documents SET rendered_seq = state_seq WHERE file_id='${id}'`);
  const unguarded = await P(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  check('the same request once the file is server-built is allowed (200) — the refusal was the file, nothing else',
    unguarded.status === 200 && unguarded.body.enabled === true, `status ${unguarded.status}`);

  // ---- rename + trash ---------------------------------------------------------------
  console.log('Rename and trash');
  // A fresh connection: the switch-off above rightly closed every earlier one.
  const listener = await connect(A, id, 'owner-listener');
  const rn = await A(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'E2E plan (final)' }) });
  check('owner renames (200)', rn.status === 200 && rn.body.title === 'E2E plan (final)');
  check('the open editor hears the rename', await waitFor(() => listener.events.some((e) => e.type === 'meta' && e.title === 'E2E plan (final)')));

  const del = await A(`/space/files/${id}`, { method: 'DELETE' });
  check('owner moves it to the trash via Space', del.status === 200 || del.status === 204, `status ${del.status}`);
  check('a trashed document gives no live ticket (409)', (await A(`/docs/${id}/live-ticket`, { method: 'POST' })).status === 409);
  const trashList = await A('/docs?view=trash');
  check('it is listed in the owner\'s trash', trashList.body.documents?.some((d) => d.id === id));
  listener.ws.close();
  a1.ws.close();

  // Leave the database as found: Docs off for both organisations.
  await P(`/admin/organisations/${TENANT_A}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  await P(`/admin/organisations/${TENANT_C}/docs`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });

  stopAll();
  console.log(`\n  passed: ${passed}   failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { stopAll(); console.error(`\nERROR: ${e.message}`); process.exit(2); });
