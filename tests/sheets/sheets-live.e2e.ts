// ============================================================================
//  TatvaOS Sheets — end-to-end checks against a running API
// ============================================================================
//
//  Drives the real endpoints and the real WebSocket with the real model
//  (lib/sheets/model.ts) and the real .xlsx writer and reader, as three
//  people: the owner and an employee of tenant 1, and a person in tenant 2.
//  Each check says what it proves; the run ends with a count and exits
//  non-zero if anything failed.
//
//    node --import ./tests/sheets/register.mjs tests/sheets/sheets-live.e2e.ts
//
//  Environment: SHEETS_API (default http://localhost:5151/api) and
//  SHEETS_PHONES "owner,employee,otherTenant" (default the local seed
//  numbers +919999900002/3/4). The local stack must show OTP codes on
//  screen. NOT for production: it signs in with on-screen codes.
//
//  TRAP (see tests/docs/docs-live.test.mjs): the OTP request returns its
//  code only on the first request inside the 60-second resend window.
//  Wait a minute between runs.
// ============================================================================

import * as Y from '../../apps/web/node_modules/yjs/dist/yjs.mjs';
import { SheetsModel } from '../../apps/web/lib/sheets/model.ts';
import { writeXlsx, readXlsx } from '../../apps/web/lib/sheets/io/xlsx.ts';

const API = process.env.SHEETS_API ?? 'http://localhost:5151/api';
const [OWNER, EMPLOYEE, OTHER] = (process.env.SHEETS_PHONES ?? '+919999900002,+919999900003,+919999900004').split(',') as [string, string, string];

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64');

async function signIn(phone: string) {
  const r1 = await fetch(`${API}/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
  const b1 = await r1.json() as { devCode?: string };
  if (!b1.devCode) throw new Error(`no devCode for ${phone.slice(0, 6)}… (status ${r1.status}); wait 60 s and rerun`);
  const r2 = await fetch(`${API}/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: b1.devCode }) });
  const b2 = await r2.json() as { accessToken?: string; user?: { id: string } };
  if (!b2.accessToken) throw new Error(`verify failed for ${phone.slice(0, 6)}… (status ${r2.status})`);
  return { token: b2.accessToken, id: b2.user!.id };
}

type Call = (p: string, init?: RequestInit) => Promise<{ status: number; body: any; headers: Headers; bytes: Uint8Array }>;
function client(who: { token: string }): Call {
  return async (p, init = {}) => {
    const res = await fetch(`${API}${p}`, {
      ...init,
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${who.token}` },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let body: unknown = null;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
    return { status: res.status, body, headers: res.headers, bytes };
  };
}

// ---- the live channel: a minimal browser, wired as lib/docsLive.ts is -------

const MSG = { update: 1, ack: 4, synced: 5, event: 6, state: 7 };
const seqOf = (b: Uint8Array) => Number(new DataView(b.buffer, b.byteOffset + 1, 8).getBigInt64(0));

async function connect(call: Call, id: string) {
  const t = await call(`/docs/${id}/live-ticket`, { method: 'POST' });
  if (t.status !== 200) return null;
  const ws = new WebSocket(API.replace(/^http/, 'ws') + `/docs/${id}/live?ticket=${encodeURIComponent(t.body.ticket)}`);
  ws.binaryType = 'arraybuffer';
  const doc = new Y.Doc();
  const s = { doc, ws, synced: false, lastSeq: 0, acks: 0, events: [] as { type: string; perm?: string }[], model: null as SheetsModel | null };
  ws.onmessage = (ev) => {
    const b = new Uint8Array(ev.data as ArrayBuffer);
    switch (b[0]) {
      case MSG.state: if (b.length > 9) Y.applyUpdate(doc, b.subarray(9), 'server'); s.lastSeq = Math.max(s.lastSeq, seqOf(b)); break;
      case MSG.update: Y.applyUpdate(doc, b.subarray(9), 'server'); s.lastSeq = Math.max(s.lastSeq, seqOf(b)); break;
      case MSG.ack: s.acks += 1; s.lastSeq = Math.max(s.lastSeq, seqOf(b)); break;
      case MSG.synced: s.synced = true; s.lastSeq = Math.max(s.lastSeq, seqOf(b)); break;
      case MSG.event: s.events.push(JSON.parse(new TextDecoder().decode(b.subarray(1)))); break;
    }
  };
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'server') return;
    const f = new Uint8Array(u.length + 1); f[0] = MSG.update; f.set(u, 1);
    if (ws.readyState === WebSocket.OPEN) ws.send(f);
  });
  for (let i = 0; i < 50 && !s.synced; i += 1) await sleep(100);
  s.model = new SheetsModel(doc);
  return s;
}

async function waitFor(fn: () => boolean, ms = 3000) {
  for (let i = 0; i < ms / 50; i += 1) { if (fn()) return true; await sleep(50); }
  return fn();
}

// ============================================================================

async function main() {
  console.log(`Sheets end-to-end against ${API}\n`);
  const owner = await signIn(OWNER);
  const employee = await signIn(EMPLOYEE);
  const other = await signIn(OTHER);
  const A = client(owner), B = client(employee), C = client(other);

  console.log('Create, list, visibility');
  const created = await A('/docs', { method: 'POST', body: JSON.stringify({ title: 'E2E fees', scope: 'personal', kind: 'spreadsheet' }) });
  check('owner creates a spreadsheet (201)', created.status === 201, `${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.id as string;
  const bad = await A('/docs', { method: 'POST', body: JSON.stringify({ kind: 'slides' }) });
  check('an unknown kind is refused (400)', bad.status === 400, `${bad.status}`);

  const sheetsList = await A('/docs?kind=spreadsheet&view=owned');
  const docsList = await A('/docs?view=owned');
  check('it is in the Sheets list', sheetsList.body.documents.some((d: { id: string }) => d.id === id));
  // Calibrated by the check above: the same row, the other list.
  check('it is NOT in the Docs list', !docsList.body.documents.some((d: { id: string }) => d.id === id));
  check('its Space file carries the spreadsheet type',
    sheetsList.body.documents.find((d: { id: string }) => d.id === id)?.mimeType === 'application/vnd.tatvaos.spreadsheet');

  check('owner opens it (200, level owner)', (await A(`/docs/${id}`)).body?.myPermission === 'owner');
  check('unshared colleague gets 404', (await B(`/docs/${id}`)).status === 404);
  check('other organisation gets 404', (await C(`/docs/${id}`)).status === 404);
  check('other organisation cannot get a live ticket', (await C(`/docs/${id}/live-ticket`, { method: 'POST' })).status === 404);
  const cList = await C('/docs?kind=spreadsheet&view=recent');
  check("other organisation's Sheets list does not include it", cList.status === 200 && !cList.body.documents.some((d: { id: string }) => d.id === id));

  console.log('Live editing: two connections, one spreadsheet');
  const a1 = await connect(A, id);
  const a2 = await connect(A, id);
  check('two connections sync', !!a1?.synced && !!a2?.synced);
  a1!.model!.ensureSeeded();
  a2!.model!.ensureSeeded(); // both seed at once, as two people opening a new sheet would
  await waitFor(() => a1!.acks >= 1 && a2!.acks >= 1);
  await sleep(300);
  check('two simultaneous seeds make ONE sheet, not two', a1!.model!.sheets().length === 1 && a2!.model!.sheets().length === 1,
    `a1 ${a1!.model!.sheets().map((s) => s.name)} a2 ${a2!.model!.sheets().map((s) => s.name)}`);

  const s1 = a1!.model!.sheetIds()[0]!;
  a1!.model!.setInputs(s1, [
    { r: 0, c: 0, input: 'Fee' }, { r: 1, c: 0, input: '₹1,25,000' }, { r: 2, c: 0, input: '75000' },
    { r: 3, c: 0, input: '=SUM(A2:A3)' },
  ]);
  const got = await waitFor(() => a2!.model!.value(s1, 3, 0) === 200000);
  check("the other connection calculates the sum of the first's edits (200000)", got, `saw ${JSON.stringify(a2!.model!.value(s1, 3, 0))}`);

  // A row inserted by one person while the other types below it: the typed
  // value must stay in its row, and the formula must follow.
  // a2 types beside the row it SEES holding ₹1,25,000, in the same instant
  // a1 inserts a row above it — so a2 has not yet seen the insert, and its
  // row number for ₹1,25,000 is stale by the time the edit lands.
  const seen = [0, 1, 2, 3].find((r) => a2!.model!.input(s1, r, 0) === '₹1,25,000')!;
  a1!.model!.insert(s1, 'row', 1, 1);
  a2!.model!.setInputs(s1, [{ r: seen, c: 1, input: 'typed beside ₹1,25,000' }]);
  await sleep(600);
  const row = (m: SheetsModel) => [m.input(s1, 2, 0), m.input(s1, 2, 1) ?? m.input(s1, 3, 1)];
  check('after a concurrent insert, both see the same cells',
    JSON.stringify(row(a1!.model!)) === JSON.stringify(row(a2!.model!)), `${JSON.stringify(row(a1!.model!))} vs ${JSON.stringify(row(a2!.model!))}`);
  const typedRow = [0, 1, 2, 3, 4].find((r) => a1!.model!.input(s1, r, 1) === 'typed beside ₹1,25,000');
  check('the value typed beside ₹1,25,000 is still beside it', typedRow !== undefined && a1!.model!.input(s1, typedRow, 0) === '₹1,25,000',
    `typed at row ${typedRow}, A there = ${typedRow === undefined ? '-' : a1!.model!.input(s1, typedRow, 0)}`);
  check('the SUM moved down with its rows and still totals 200000',
    a1!.model!.input(s1, 4, 0) === '=SUM(A3:A4)' && a1!.model!.value(s1, 4, 0) === 200000,
    `${a1!.model!.input(s1, 4, 0)} = ${JSON.stringify(a1!.model!.value(s1, 4, 0))}`);

  console.log('Checkpoint: the Space copy is a real .xlsx');
  const snap = a1!.model!.snapshot();
  const xlsx = await writeXlsx(snap);
  const cp = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: b64(Y.encodeStateAsUpdate(a1!.doc)), upToSeq: a1!.lastSeq, html: '<table></table>', text: 'Fee', xlsx: b64(xlsx),
  }) });
  check('checkpoint with an .xlsx is accepted', cp.status === 200 && cp.body?.saved === true, `${cp.status} ${JSON.stringify(cp.body)}`);
  const noX = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: b64(Y.encodeStateAsUpdate(a1!.doc)), upToSeq: a1!.lastSeq, html: '', text: '' }) });
  check('a spreadsheet checkpoint WITHOUT its .xlsx is refused (400)', noX.status === 400, `${noX.status}`);
  const notZip = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: b64(Y.encodeStateAsUpdate(a1!.doc)), upToSeq: a1!.lastSeq, html: '', text: '', xlsx: b64(new TextEncoder().encode('<html>not a zip</html>')) }) });
  check('an .xlsx that is not a zip is refused (400)', notZip.status === 400, `${notZip.status}`);

  const dl = await A(`/space/files/${id}/content`);
  check('Space download answers 200', dl.status === 200, `${dl.status}`);
  check('…typed as an Excel file', (dl.headers.get('content-type') ?? '').includes('spreadsheetml'), dl.headers.get('content-type') ?? '');
  check('…named .xlsx', /\.xlsx/.test(dl.headers.get('content-disposition') ?? ''), dl.headers.get('content-disposition') ?? '');
  let readBack = null;
  try { readBack = await readXlsx(dl.bytes); } catch (e) { readBack = null; console.log('   ', e); }
  const cell = readBack?.sheets[0]?.cells.get('4,0');
  check('…and it reads back with the formula and its value', cell?.input === '=SUM(A3:A4)' && cell?.value === 200000, JSON.stringify(cell));

  console.log('Documents and spreadsheets do not cross');
  const doc = await A('/docs', { method: 'POST', body: JSON.stringify({ title: 'E2E doc', scope: 'personal' }) });
  const docCp = await A(`/docs/${doc.body.id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: b64(new Y.Doc() && Y.encodeStateAsUpdate(new Y.Doc())), upToSeq: 0, html: '<p>x</p>', text: 'x', xlsx: b64(xlsx) }) });
  check('a DOCUMENT checkpoint carrying an .xlsx is refused (400)', docCp.status === 400, `${docCp.status}`);
  const docAi = await A(`/sheets/${doc.body.id}/ai`, { method: 'POST', body: JSON.stringify({ action: 'analyze', context: 'a\tb' }) });
  check('Sheets AI on a document is 404', docAi.status === 404, `${docAi.status}`);

  console.log('Space protects the spreadsheet');
  const form = new FormData();
  form.append('file', new Blob([new TextEncoder().encode('overwrite')]), 'x.xlsx');
  const ow = await fetch(`${API}/space/files/${id}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${owner.token}` }, body: form });
  check('replacing the Space file\'s content is refused (409)', ow.status === 409, `${ow.status}`);

  console.log('Sheets AI');
  const ai = await A(`/sheets/${id}/ai`, { method: 'POST', body: JSON.stringify({ action: 'formula', prompt: 'total fees', context: 'Sheet: Sheet1' }) });
  check('owner reaches the AI endpoint (200, or 503/403 when AI is off here)', [200, 403, 503].includes(ai.status), `${ai.status} ${JSON.stringify(ai.body)}`);
  if (ai.status === 200) check('…and a formula comes back starting with =', typeof ai.body.text === 'string' && ai.body.text.startsWith('='), ai.body.text);
  check('other organisation gets 404 from the AI endpoint', (await C(`/sheets/${id}/ai`, { method: 'POST', body: JSON.stringify({ action: 'formula', prompt: 'x' }) })).status === 404);
  check('an unknown AI action is 400 (when AI is on) or the AI-off answer', [400, 403, 503].includes(
    (await A(`/sheets/${id}/ai`, { method: 'POST', body: JSON.stringify({ action: 'nope' }) })).status));

  for (const s of [a1, a2]) { s?.model?.destroy(); s?.ws.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
