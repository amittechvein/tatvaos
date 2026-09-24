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

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../apps/web/package.json'));
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/awareness');

const API = process.env.DOCS_API ?? 'http://localhost:5141/api';
const [OWNER, EMPLOYEE, OTHER] = (process.env.DOCS_PHONES ?? '+919999900002,+919999900003,+919999900004').split(',');

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
async function connect(call, id, label) {
  const t = await call(`/docs/${id}/live-ticket`, { method: 'POST' });
  if (t.status !== 200) return { refused: t.status };
  const url = API.replace(/^http/, 'ws') + `/docs/${id}/live?ticket=${encodeURIComponent(t.body.ticket)}`;
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const s = { doc, awareness, events: [], acks: [], updatesIn: 0, awarenessIn: [], lastSeq: 0, stateSeq: null,
    synced: false, closed: null, ticket: t.body.ticket, label };
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

async function main() {
  console.log(`Docs end-to-end against ${API}\n`);

  const owner = await signIn(OWNER);
  const employee = await signIn(EMPLOYEE);
  const other = await signIn(OTHER);
  const A = client(owner), B = client(employee), C = client(other);

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

  // Presence.
  b2.sendAwareness({ user: { name: 'Employee', color: '#1a73e8' } });
  check('presence (awareness) reaches the other editor',
    await waitFor(() => [...a1.awareness.getStates().values()].some((s) => s.user?.name === 'Employee')));
  b2.ws.close();
  check('presence is withdrawn when the tab closes',
    await waitFor(() => ![...a1.awareness.getStates().values()].some((s) => s.user?.name === 'Employee')));

  // ---- checkpoint --------------------------------------------------------------
  console.log('Checkpoint and reload');
  const future = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: toB64(Y.encodeStateAsUpdate(a1.doc)), upToSeq: a1.lastSeq + 1000, html: '<p>x</p>', text: 'x' }) });
  check('a checkpoint claiming unseen updates is refused (409)', future.status === 409, `status ${future.status}`);

  const htmlNow = '<p>Hello</p><p>world</p>';
  const cp = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: toB64(Y.encodeStateAsUpdate(a1.doc)), upToSeq: a1.lastSeq, html: htmlNow, text: textOf(a1.doc) }) });
  check('owner checkpoints (200)', cp.status === 200, `status ${cp.status} ${JSON.stringify(cp.body)}`);

  // An editor whose browser is BEHIND (seq 0, empty content) must change nothing.
  const staleCp = await B(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: toB64(new Uint8Array([0, 0])), upToSeq: 0, html: '', text: '' }) });
  check('a stale checkpoint is accepted and ignored', staleCp.status === 200 && staleCp.body.stale === true,
    `status ${staleCp.status} ${JSON.stringify(staleCp.body)}`);

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
  const named = await A(`/docs/${id}/versions`, { method: 'POST', body: JSON.stringify({
    kind: 'named', name: 'Draft v1', state: toB64(Y.encodeStateAsUpdate(a1.doc)), html: htmlNow }) });
  check('owner names a version (201)', named.status === 201, `status ${named.status}`);
  const one = await A(`/docs/${id}/versions/${named.body.id}`);
  const rebuilt = new Y.Doc(); Y.applyUpdate(rebuilt, Buffer.from(one.body.state, 'base64'));
  check('a version\'s state rebuilds to the text it was taken from', textOf(rebuilt) === textOf(a1.doc));
  check('other organisation cannot read versions', (await C(`/docs/${id}/versions/${named.body.id}`)).status === 404);

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

  // ---- rename + trash ---------------------------------------------------------------
  console.log('Rename and trash');
  const rn = await A(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'E2E plan (final)' }) });
  check('owner renames (200)', rn.status === 200 && rn.body.title === 'E2E plan (final)');
  check('the open editor hears the rename', await waitFor(() => a1.events.some((e) => e.type === 'meta' && e.title === 'E2E plan (final)')));

  const del = await A(`/space/files/${id}`, { method: 'DELETE' });
  check('owner moves it to the trash via Space', del.status === 200 || del.status === 204, `status ${del.status}`);
  check('a trashed document gives no live ticket (409)', (await A(`/docs/${id}/live-ticket`, { method: 'POST' })).status === 409);
  const trashList = await A('/docs?view=trash');
  check('it is listed in the owner\'s trash', trashList.body.documents?.some((d) => d.id === id));
  a1.ws.close();

  console.log(`\n  passed: ${passed}   failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(2); });
