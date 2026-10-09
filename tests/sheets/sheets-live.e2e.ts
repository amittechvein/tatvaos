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
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// ---- the render service: spreadsheets are built on the server -----------------
// This test owns it, as tests/docs/docs-live.test.mjs does: started on
// DOCS_RENDER_PORT (the API's Docs:RenderUrl points there; run-docs-live.sh
// sets both), stopped mid-run to prove a failed build fails the save.
const RENDER_PORT = Number(process.env.DOCS_RENDER_PORT ?? 18450);
let renderChild: ChildProcess | null = null;
async function startRender() {
  renderChild = spawn(process.execPath, ['--import', './src/register.mjs', 'src/server.mjs'], {
    cwd: fileURLToPath(new URL('../../apps/render/', import.meta.url)),
    // NODE_OPTIONS cleared: CI runs THIS test with --import ./tests/sheets/register.mjs,
    // a path relative to the repo root that the service, started in apps/render, would
    // not find (and its own loader is ./src/register.mjs).
    env: { ...process.env, NODE_OPTIONS: '', PORT: String(RENDER_PORT) }, stdio: 'ignore',
  });
  for (let i = 0; i < 300; i += 1) { // up to 30 s: a cold start beside the API can take >10 s
    try { if ((await fetch(`http://127.0.0.1:${RENDER_PORT}/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}
async function stopRender() {
  renderChild?.kill();
  renderChild = null;
  for (let i = 0; i < 50; i += 1) { // until the port really refuses
    try { await fetch(`http://127.0.0.1:${RENDER_PORT}/health`); } catch { return; }
    await sleep(100);
  }
}
// The one fact only the database holds (the stored search text). TATVAOS_PSQL
// is exported by tests/lib/throwaway-db.sh: "<psql> -d <db> -Atc".
function pg(sql: string) {
  if (!process.env.TATVAOS_PSQL) throw new Error('TATVAOS_PSQL not set: run through tests/docs/run-docs-live.sh');
  return execSync(`${process.env.TATVAOS_PSQL} "${sql}"`, { encoding: 'utf8' })
    .split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l && !l.startsWith('wsl:')).pop() ?? '';
}

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

// ticketIn: open with a ticket taken earlier, as a browser that fetched one
// just before something changed would.
async function connect(call: Call, id: string, ticketIn?: string) {
  const t = ticketIn ? { status: 200, body: { ticket: ticketIn } }
    : await call(`/docs/${id}/live-ticket`, { method: 'POST' });
  if (t.status !== 200) return null;
  const ws = new WebSocket(API.replace(/^http/, 'ws') + `/docs/${id}/live?ticket=${encodeURIComponent(t.body.ticket)}`);
  ws.binaryType = 'arraybuffer';
  const doc = new Y.Doc();
  const s = { doc, ws, synced: false, closed: null as number | null, lastSeq: 0, acks: 0, events: [] as { type: string; perm?: string }[], model: null as SheetsModel | null };
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
  ws.onclose = (ev) => { s.closed = ev.code; };
  for (let i = 0; i < 50 && !s.synced && s.closed === null; i += 1) await sleep(100);
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
  if (!(await startRender())) throw new Error(`the render service did not start on ${RENDER_PORT}`);
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

  console.log('Checkpoint: the server builds the Space copy from what it stored');
  // Sheets server build, stage 2 (docs/SHEETS_SERVER_RENDER_DESIGN.md): the
  // browser says only how far it has seen; the render service builds the
  // .xlsx from the stored updates. Nothing else the browser sends is read.
  const save = (extra: Record<string, unknown> = {}) => A(`/sheets/${id}/checkpoint`, { method: 'POST',
    body: JSON.stringify({ upToSeq: a1!.lastSeq, ...extra }) });
  const download = async () => {
    const dl = await A(`/space/files/${id}/content`);
    let wb = null;
    let parts: Map<string, Uint8Array> | null = null;
    try { wb = await readXlsx(dl.bytes); parts = await readZip(dl.bytes); } catch (e) { console.log('   ', e); }
    return { dl, wb, parts };
  };
  const cp = await save();
  check('a checkpoint carrying nothing but upToSeq is saved (200)', cp.status === 200 && cp.body?.saved === true, `${cp.status} ${JSON.stringify(cp.body)}`);
  const first = await download();
  check('Space download answers 200', first.dl.status === 200, `${first.dl.status}`);
  check('…typed as an Excel file', (first.dl.headers.get('content-type') ?? '').includes('spreadsheetml'), first.dl.headers.get('content-type') ?? '');
  check('…named .xlsx', /\.xlsx/.test(first.dl.headers.get('content-disposition') ?? ''), first.dl.headers.get('content-disposition') ?? '');
  const cell = first.wb?.sheets[0]?.cells.get('4,0');
  check('…and it reads back with the formula and its value, built by the server', cell?.input === '=SUM(A3:A4)' && cell?.value === 200000, JSON.stringify(cell));

  console.log("A colleague's edit is in the file, though the person saving never sent it");
  const colleague = 'Typed by the second connection';
  check('control: before the edit, the file does not have it', first.wb?.sheets[0]?.cells.get('10,0')?.input !== colleague);
  const acksBefore = a2!.acks;
  a2!.model!.setInputs(s1, [{ r: 10, c: 0, input: colleague }]);
  await waitFor(() => a2!.acks > acksBefore);
  // The OWNER saves, sending nothing of a2's edit (a stale upToSeq, even).
  const cp2 = await A(`/sheets/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: 0 }) });
  check('the owner saves (200)', cp2.status === 200 && cp2.body?.saved === true, `${cp2.status} ${JSON.stringify(cp2.body)}`);
  const second = await download();
  check("…and the colleague's edit is in the file", second.wb?.sheets[0]?.cells.get('10,0')?.input === colleague,
    JSON.stringify(second.wb?.sheets[0]?.cells.get('10,0')));

  console.log("The browser's own .xlsx is ignored: a hostile one is never stored");
  // Built from an ordinary workbook's parts: a macro project, a link outside
  // the file and a DDE formula, sent where the old checkpoint read the .xlsx.
  // The formulas are what XlsxGuard refuses (tests/sheets-xlsx-guard, its
  // own corpus); here the point is that the server never stores the
  // browser's file at all, so none of it can reach Space.
  const plainSheet = emptySheet('Fees');
  plainSheet.cells.set(cellKey(0, 0), { input: '10' });
  plainSheet.cells.set(cellKey(1, 0), { input: '=SUM(A1:A1)*2', value: 20 });
  const base = await readZip(await writeXlsx({ sheets: [plainSheet] }));
  const text = (name: string) => new TextDecoder().decode(base.get(name)!);
  const hostileFiles = new Map(base);
  hostileFiles.set('xl/vbaProject.bin', new Uint8Array([1, 2, 3]));
  hostileFiles.set('xl/externalLinks/externalLink1.xml', new TextEncoder().encode('<externalLink/>'));
  hostileFiles.set('xl/worksheets/sheet1.xml', new TextEncoder().encode(
    text('xl/worksheets/sheet1.xml').replace(/<f>SUM\(A1:A1\)\*2<\/f>/, "<f>cmd|' /c calc'!A0</f>")));
  check('…the hostile workbook really carries the DDE formula (calibration)',
    new TextDecoder().decode(hostileFiles.get('xl/worksheets/sheet1.xml')!).includes('cmd|'));
  const hostile = await writeZip([...hostileFiles].map(([name, data]) => ({ name, data })));
  a1!.model!.setInputs(s1, [{ r: 11, c: 0, input: 'Saved with a hostile file attached' }]);
  await sleep(600);
  const cp3 = await save({ state: b64(new Uint8Array([1, 2, 3])), html: '<script>x</script>', text: 'not the text', xlsx: b64(hostile) });
  check("a save sending a hostile .xlsx, a fake state and fake HTML is not refused: they are ignored (200)",
    cp3.status === 200 && cp3.body?.saved === true, `${cp3.status} ${JSON.stringify(cp3.body)}`);
  const third = await download();
  const names = [...(third.parts?.keys() ?? [])];
  const sheetXml = new TextDecoder().decode(third.parts?.get('xl/worksheets/sheet1.xml') ?? new Uint8Array());
  check('…the stored file has no macro project and no external link', names.length > 0
    && !names.some((n) => /vbaProject|externalLink/i.test(n)), JSON.stringify(names));
  check('…no DDE formula', sheetXml.length > 0 && !sheetXml.includes('cmd|'));
  check("…and it is the server's build of the real spreadsheet", third.wb?.sheets[0]?.cells.get('11,0')?.input === 'Saved with a hostile file attached'
    && third.wb?.sheets[0]?.cells.get('4,0')?.value === 200000, JSON.stringify(third.wb?.sheets[0]?.cells.get('11,0')));
  // The stored search text, read from the database (only it can say).
  check("…and its stored text is the server's: the spreadsheet's words, not the browser's",
    pg(`SELECT (text_content LIKE '%Saved with a hostile file attached%')::int || ',' || (text_content LIKE '%not the text%')::int FROM docs.documents WHERE file_id = '${id}'`) === '1,0');

  console.log('A failed build fails the save, visibly, and keeps the edits');
  await stopRender();
  a1!.model!.setInputs(s1, [{ r: 12, c: 0, input: 'Typed while the render service was down' }]);
  await sleep(600);
  const down = await save();
  check('with the render service down, the save is refused (503 render_failed)', down.status === 503 && down.body?.reason === 'render_failed',
    `${down.status} ${JSON.stringify(down.body)}`);
  check('…with a sentence to show', typeof down.body?.error === 'string' && down.body.error.length > 20);
  const downVer = await A(`/sheets/${id}/versions`, { method: 'POST', body: JSON.stringify({ kind: 'named', name: 'While down' }) });
  check('…and so is a named version (503 render_failed)', downVer.status === 503 && downVer.body?.reason === 'render_failed', `${downVer.status}`);
  const during = await download();
  check('…and Space still serves the last good file, unchanged', during.wb?.sheets[0]?.cells.get('11,0')?.input === 'Saved with a hostile file attached'
    && during.wb?.sheets[0]?.cells.get('12,0') === undefined);
  if (!(await startRender())) throw new Error('the render service did not restart');
  const up = await save();
  check('the render service back, the next save succeeds (200)', up.status === 200 && up.body?.saved === true, `${up.status} ${JSON.stringify(up.body)}`);
  const after = await download();
  check('…and the edit typed while it was down is in the file', after.wb?.sheets[0]?.cells.get('12,0')?.input === 'Typed while the render service was down');

  console.log('A spreadsheet created with content (a template or an imported file)');
  // What SheetsHome.createWith does (stage 3): create it empty, send the whole
  // workbook as ONE edit over the live channel, wait for the server to store
  // it, then save with nothing but upToSeq. The browser sends no file.
  const made = await A('/docs', { method: 'POST', body: JSON.stringify({ title: 'E2E imported', scope: 'personal', kind: 'spreadsheet' }) });
  const imp = made.status === 201 ? await connect(A, made.body.id) : null;
  check('a new spreadsheet opens on the live channel', !!imp?.synced, `${made.status}`);
  if (imp?.model) {
    const rows = Array.from({ length: 2000 }, (_, r) => ({ r, c: 0, input: `Imported row ${r + 1}` }));
    const impSheet = emptySheet('Imported');
    impSheet.rows = 2500; // a sheet holds its size; a real import sets it from the file (a default sheet is 1,000 rows)
    for (const x of rows) impSheet.cells.set(cellKey(x.r, x.c), { input: x.input });
    impSheet.cells.set(cellKey(0, 1), { input: '=COUNTA(A1:A2000)' });
    const acksBefore = imp.acks;
    imp.model.load({ sheets: [impSheet] }, 'replace');
    await waitFor(() => imp.acks > acksBefore, 10_000);
    await sleep(500); // in case the load went out as more than one edit
    const impSave = await A(`/sheets/${made.body.id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: imp.lastSeq }) });
    check('…filled by one live edit and saved with only upToSeq (200)', impSave.status === 200 && impSave.body?.saved === true,
      `${impSave.status} ${JSON.stringify(impSave.body)}`);
    let impBook = null;
    try { impBook = await readXlsx((await A(`/space/files/${made.body.id}/content`)).bytes); } catch (e) { console.log('   ', e); }
    const impCells = impBook?.sheets[0]?.cells;
    check("…and its file holds the imported content, built by the server",
      impBook?.sheets[0]?.name === 'Imported' && impCells?.get('1999,0')?.input === 'Imported row 2000' && impCells?.get('0,1')?.value === 2000,
      `${impBook?.sheets[0]?.name} ${JSON.stringify(impCells?.get('1999,0'))} ${JSON.stringify(impCells?.get('0,1'))}`);
    imp.model.destroy(); imp.ws.close();
  }

  console.log('Documents and spreadsheets do not cross');
  const doc = await A('/docs', { method: 'POST', body: JSON.stringify({ title: 'E2E doc', scope: 'personal' }) });
  // Each kind saves through its own routes (1 Oct 2026), and each is built
  // by its own renderer: a spreadsheet given to the Docs renderer would come
  // back as an empty page. Each route refuses the other kind; the permit
  // twins are the spreadsheet saves above and the named version below.
  const docCp = await A(`/sheets/${doc.body.id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: 0 }) });
  check('a DOCUMENT saved through the spreadsheet route is refused (400)', docCp.status === 400, `${docCp.status} ${JSON.stringify(docCp.body)}`);
  const sheetViaDocs = await A(`/docs/${id}/checkpoint`, { method: 'POST', body: JSON.stringify({ upToSeq: a1!.lastSeq }) });
  check('a SPREADSHEET saved through the document route is refused (400)', sheetViaDocs.status === 400, `${sheetViaDocs.status} ${JSON.stringify(sheetViaDocs.body)}`);
  const sheetVerViaDocs = await A(`/docs/${id}/versions`, { method: 'POST', body: JSON.stringify({ kind: 'named', name: 'x' }) });
  check('a SPREADSHEET version through the document route is refused (400)', sheetVerViaDocs.status === 400, `${sheetVerViaDocs.status} ${JSON.stringify(sheetVerViaDocs.body)}`);
  const docVerViaSheets = await A(`/sheets/${doc.body.id}/versions`, { method: 'POST', body: JSON.stringify({ kind: 'named', name: 'x' }) });
  check('a DOCUMENT version through the spreadsheet route is refused (400)', docVerViaSheets.status === 400, `${docVerViaSheets.status} ${JSON.stringify(docVerViaSheets.body)}`);
  const sheetVer = await A(`/sheets/${id}/versions`, { method: 'POST', body: JSON.stringify({
    kind: 'named', name: 'E2E named', html: '<table><tr><td>not the server</td></tr></table>' }) });
  check('…its permit twin: a spreadsheet version through its own route is saved (201)', sheetVer.status === 201, `${sheetVer.status} ${JSON.stringify(sheetVer.body)}`);
  const verBody = sheetVer.status === 201 ? await A(`/docs/${id}/versions/${sheetVer.body.id}`) : null;
  const verText = JSON.stringify(verBody?.body ?? {});
  check("…built by the server from what it stored: it holds the spreadsheet, not the browser's HTML",
    verText.includes('Typed while the render service was down') && !verText.includes('not the server'), verText.slice(0, 200));
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
  // A ticket in hand when the switch goes off (tickets live 60 s).
  const heldTicket = (await A(`/docs/${id}/live-ticket`, { method: 'POST' })).body?.ticket as string | undefined;
  await sw('sheets', TENANT_A, false);
  const refused = await A(`/docs/${id}`);
  check('Sheets off: the spreadsheet is refused at once (403 sheets_off)', refused.status === 403 && refused.body?.reason === 'sheets_off',
    `${refused.status} ${JSON.stringify(refused.body)}`);
  check('…its AI is refused at once (403)', (await A(`/sheets/${id}/ai`, { method: 'POST', body: JSON.stringify({ action: 'analyze', context: 'a	b' }) })).status === 403);
  check('…while the document opens (200)', (await A(`/docs/${docId}`)).status === 200);
  // Found 28 Sept in Docs (PR 351): opening a connection checked the file
  // and the level, not the switch, so a ticket taken before "off" opened the
  // editor after it. Sheets shares that hub; here it must be SHEETS' switch
  // that refuses — Docs is on at this moment, so a Docs-switch check passes.
  const late = heldTicket ? await connect(A, id, heldTicket) : null;
  check('Sheets off: a ticket taken before the switch-off cannot open the spreadsheet after it',
    !!heldTicket && !!late && !late.synced && late.closed !== null, `synced=${late?.synced} closed=${late?.closed}`);
  try { late?.ws.close(); } catch { /* already gone */ }
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

  // ---- the browser-file guard, Sheets' own (9 Oct 2026) ----------------------------
  // Until this the Sheets switch had no guard: an operator ran
  // docs.browser_written_count by hand before each switch-on (Mr. Singh: a
  // switch should refuse by itself). Only the database can make a
  // browser-written file now, so the test makes one, as Docs' test does.
  console.log('The browser-file guard refuses Sheets switch-on');
  check('this spreadsheet was built by the server (rendered_seq and checkpoint_at set)',
    pg(`SELECT rendered_seq IS NOT NULL AND checkpoint_at IS NOT NULL FROM docs.documents WHERE file_id='${id}'`) === 't');
  const builtFrom = pg(`SELECT rendered_seq FROM docs.documents WHERE file_id='${id}'`);
  pg(`UPDATE docs.documents SET rendered_seq = NULL WHERE file_id='${id}'`);
  // Calibration: through the app role and RLS the operator sees none of this
  // organisation's files, so a plain count reads 0 and would pass.
  const plainCount = pg(`SET ROLE tatvaos_app; SELECT set_config('app.tenant_id', '${TENANT_A}', false); `
    + `SELECT count(*) FROM docs.documents WHERE rendered_seq IS NULL AND checkpoint_at IS NOT NULL`);
  const definerCount = pg(`SELECT docs.browser_written_count('${TENANT_A}')`);
  check('calibration: a plain count through RLS reads 0 — the definer function reads 1',
    plainCount === '0' && definerCount === '1', `plain ${plainCount}, definer ${definerCount}`);
  await sw('sheets', TENANT_A, false);
  const guardedOn = await sw('sheets', TENANT_A, true);
  check('switching Sheets on is REFUSED while a browser-written file exists (409 browser_files, with the count)',
    guardedOn.status === 409 && guardedOn.body?.reason === 'browser_files' && guardedOn.body?.count === 1,
    `${guardedOn.status} ${JSON.stringify(guardedOn.body)}`);
  check('…and Sheets stays off', (await A('/sheets/status')).body?.enabled === false);
  check('…while the other organisation, with no such file, is unaffected (still on)', (await C('/sheets/status')).body?.enabled === true);
  pg(`UPDATE docs.documents SET rendered_seq = ${Number(builtFrom)} WHERE file_id='${id}'`);
  const unguardedOn = await sw('sheets', TENANT_A, true);
  check('the same request once the file is server-built is allowed (200) — the refusal was the file, nothing else',
    unguardedOn.status === 200 && unguardedOn.body?.enabled === true, `${unguardedOn.status} ${JSON.stringify(unguardedOn.body)}`);

  for (const s of [a1, a2]) { s?.model?.destroy(); s?.ws.close(); }
  await stopRender();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); renderChild?.kill(); process.exit(2); });
