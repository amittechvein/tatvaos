// ============================================================================
//  The sanitiser's output, loaded in a real browser.
//
//  Mr. Singh, 30 Sept 2026 (PR 273): "cannot run" was checked by reading the
//  output as a string. A string check is a claim about text; whether
//  something runs is decided by a browser's parser, which is exactly where
//  sanitisers are beaten. So every output is loaded in Chromium, and three
//  things are read from the BROWSER, not from the text:
//
//    ran      any script the browser compiled (Debugger.scriptParsed — this
//             fires for a <script>, an inline handler and a javascript: URL
//             alike, whether or not it then does anything visible), and any
//             alert/confirm/prompt
//    fetched  any request the page made, except a picture named by an <img>
//             the sanitiser kept (pictures from the web are allowed — see
//             "pictures" in the summary)
//    parsed   any element or attribute in the browser's OWN tree that is not
//             on the list, any link that is not http/https/mailto
//
//  After loading, every element is sent click, mouseover, focus, error, load
//  and the rest, so a handler that needs a person still gets its chance.
//
//  THE PAGE IS SERVED WITH NO CONTENT-SECURITY-POLICY, on purpose. The real
//  file carries one that forbids every script; with it, this test would pass
//  for a sanitiser that did nothing. This measures the sanitiser alone.
//
//  NOTHING LEAVES THE LAPTOP: every host name resolves to nowhere
//  (--host-resolver-rules). A request is recorded when the page ASKS.
//
//  Two controls run every time, so a green run is never an empty one:
//    - a hostile page served UNCLEANED must be caught running and fetching
//    - the real editor's page must load its elements and ask for its pictures
//
//  No test framework and no browser package: Chrome's own DevTools protocol
//  over a WebSocket (Node 22+). Not in CI (a workflow change goes to
//  Mr. Singh).
//
//  Usage:   DUMP=pairs.json dotnet run --project tests/docs-html -c Release
//           node tests/docs-html/browser.mjs pairs.json
//           EXPECT=dirty …   calibration: the pairs came from CONTROL=passthrough
//                            and MUST be caught; exit 0 only if they are
//  Exit:    0 as expected, 1 otherwise.
// ============================================================================

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pairsFile = process.argv[2];
if (!pairsFile) { console.error('usage: node tests/docs-html/browser.mjs <pairs.json>'); process.exit(1); }
const expectDirty = process.env.EXPECT === 'dirty';
const pairs = JSON.parse(readFileSync(pairsFile, 'utf8'));

const CHROME = [process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
if (!CHROME) { console.error('No Chromium found. Set CHROME to its path.'); process.exit(1); }

const ALLOWED = ['p', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'hr', 'br',
  'strong', 'em', 's', 'u', 'sub', 'sup', 'a', 'span', 'mark',
  'table', 'colgroup', 'col', 'tbody', 'tr', 'th', 'td', 'label', 'input', 'div', 'img'];

// The control: what a sanitiser that did nothing would let through.
const CONTROL = '<p>control</p><script>fetch("/beacon-script")</script>'
  + '<img src="/missing.png" onerror="alert(1)">'
  + '<p onclick="fetch(\'/beacon-click\')">click me</p>'
  + '<a href="javascript:fetch(\'/beacon-link\')">link</a>';

const cases = [
  { section: 'control', input: CONTROL, output: CONTROL },
  ...pairs,
];

// ---- the page server ---------------------------------------------------------
const server = createServer((req, res) => {
  const m = /^\/case\/(\d+)$/.exec(req.url ?? '');
  if (!m || !cases[Number(m[1])]) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>case</title></head><body>${cases[Number(m[1])].output}</body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- the browser ---------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'docs-html-browser-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = null;
for (let i = 0; i < 100 && !port; i += 1) {
  const f = join(profile, 'DevToolsActivePort');
  if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0].trim();
  else await sleep(100);
}
if (!port) { console.error('Chromium did not start.'); chrome.kill(); process.exit(1); }
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const waiting = new Map();
const listeners = new Set();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId; nextId += 1;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

let targetId;
let sessionId;
const mine = new Set(); // tabs this harness opened; any other new page was opened by content
async function newTab() {
  ({ targetId } = await send('Target.createTarget', { url: 'about:blank' }));
  mine.add(targetId);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  for (const d of ['Page', 'Network', 'Runtime', 'Debugger']) await send(`${d}.enable`, {}, sessionId);
}
await send('Target.setDiscoverTargets', { discover: true });
await newTab();

// ---- what the page is asked to do, and what is read from its own tree ------------
const INTERACT = `(() => {
  const allowed = new Set(${JSON.stringify(ALLOWED)});
  const bad = [];
  const pictures = [];
  // An uncleaned page can replace the body (a frameset) or have none.
  const root = document.body ?? document.documentElement;
  const all = [...root.querySelectorAll('*')];
  for (const el of all) {
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') bad.push('foreign element ' + el.localName);
    else if (!allowed.has(el.localName)) bad.push('element ' + el.localName);
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) bad.push(el.localName + ' has ' + a.name);
      if (['srcdoc', 'srcset', 'action', 'formaction', 'id', 'name'].includes(a.name)) bad.push(el.localName + ' has ' + a.name);
      if (a.name === 'style' && /url\\(|expression|@import|position|var\\(/i.test(a.value)) bad.push(el.localName + ' style: ' + a.value.slice(0, 60));
    }
    if (el.localName === 'input' && (el.type !== 'checkbox' || !el.disabled)) bad.push('input ' + el.type + (el.disabled ? '' : ' enabled'));
  }
  for (const a of root.querySelectorAll('a[href]')) {
    // a.protocol is the BROWSER's reading of the address, after it has
    // removed whatever it removes.
    if (!['http:', 'https:', 'mailto:'].includes(a.protocol)) bad.push('link ' + a.protocol);
    else a.removeAttribute('href'); // a good link would leave the page when clicked
  }
  for (const i of root.querySelectorAll('img')) {
    pictures.push(i.src);
    let protocol = '(none)';
    try { protocol = new URL(i.src).protocol; } catch { /* no address, or not one */ }
    if (!/^https?:$/.test(protocol)) bad.push('picture ' + protocol);
  }
  for (const head of document.head?.children ?? []) {
    if (!['meta', 'title'].includes(head.localName)) bad.push('in head: ' + head.localName);
  }
  for (const el of all) {
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseenter', 'mousemove',
      'pointerdown', 'pointerover', 'focus', 'focusin', 'blur', 'keydown', 'input', 'change',
      'load', 'error', 'toggle', 'scroll', 'animationstart', 'animationend', 'transitionend']) {
      try { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); } catch { /* keep going */ }
    }
    try { if (typeof el.focus === 'function') el.focus(); } catch { /* keep going */ }
  }
  return JSON.stringify({ elements: all.length, bad, pictures, text: (root.innerText ?? '').length });
})()
//# sourceURL=harness://interact`;

async function runCase(index) {
  const url = `${origin}/case/${index}`;
  const seen = { scripts: [], dialogs: [], requests: [], windows: [] };
  let loaded;
  const onLoad = new Promise((r) => { loaded = r; });
  const listen = (msg) => {
    if (msg.method === 'Target.targetCreated' && !mine.has(msg.params.targetInfo.targetId)
      && msg.params.targetInfo.type === 'page') seen.windows.push(msg.params.targetInfo.url);
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Debugger.scriptParsed' && msg.params.url !== 'harness://interact') seen.scripts.push(msg.params.url || '(inline)');
    if (msg.method === 'Page.javascriptDialogOpening') {
      seen.dialogs.push(msg.params.type);
      send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
    }
    if (msg.method === 'Network.requestWillBeSent') seen.requests.push({ url: msg.params.request.url, type: msg.params.type });
    if (msg.method === 'Page.loadEventFired') loaded();
  };
  listeners.add(listen);
  try {
    // An uncleaned page can hang the tab outright (a script that never
    // ends, a page that reloads itself). Only calibration meets one; the
    // tab is thrown away and the case counted as having run.
    const HUNG = Symbol('hung');
    const work = (async () => {
      await send('Page.navigate', { url }, sessionId);
      await Promise.race([onLoad, sleep(3000)]);
      return send('Runtime.evaluate', { expression: INTERACT, returnByValue: true }, sessionId);
    })();
    work.catch(() => {});
    const r = await Promise.race([work, sleep(8000).then(() => HUNG)]);
    if (r === HUNG) {
      const old = targetId;
      await newTab();
      send('Target.closeTarget', { targetId: old }).catch(() => {});
      return { ran: ['the page hung the tab', ...seen.scripts.map((x) => 'script ' + x)], fetched: [], parsed: [], pictures: 0, elements: 0, text: 0 };
    }
    if (r.exceptionDetails) throw new Error('the harness itself threw: ' + r.exceptionDetails.text);
    const dom = JSON.parse(r.result.value);
    await sleep(40); // handlers and requests started by the events above
    const pictures = new Set(dom.pictures);
    const fetched = seen.requests.filter((q) => q.url !== url
      && !(q.type === 'Image' && pictures.has(q.url))
      && q.url !== `${origin}/favicon.ico`);
    return {
      ran: [...seen.scripts.map((s) => 'script ' + s), ...seen.dialogs.map((d) => 'dialog ' + d),
        ...seen.windows.map((w) => 'new window ' + w)],
      fetched: fetched.map((q) => `${q.type} ${q.url}`),
      parsed: dom.bad,
      pictures: seen.requests.filter((q) => q.type === 'Image' && pictures.has(q.url)).length,
      elements: dom.elements,
      text: dom.text,
    };
  } finally {
    listeners.delete(listen);
  }
}

// ---- the run -------------------------------------------------------------------
let passed = 0;
let failed = 0;
const ok = (what, good, detail = '') => {
  if (good) { passed += 1; console.log(`    ok  ${what}`); }
  else { failed += 1; console.log(`  FAIL  ${what}${detail ? `\n          ${detail}` : ''}`); }
};

console.log(`\n  Docs: the stored HTML, in a real browser (${cases.length - 1} outputs, ${CHROME.split('/').pop()})`);
console.log('  ========================================================');
if (expectDirty) console.log('\n  EXPECT=dirty: these outputs were NOT cleaned. Being caught is the point.');

let results;
try {
  results = [];
  for (let i = 0; i < cases.length; i += 1) {
    results.push({ ...cases[i], index: i, ...(await runCase(i)) });
    if (i > 0 && i % 100 === 0) console.error(`        … ${i} of ${cases.length - 1}`);
  }
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may still hold it */ }
}

const control = results[0];
console.log('\n  Controls');
ok('the uncleaned control page is caught RUNNING', control.ran.length >= 3, control.ran.join(' | ') || 'nothing seen');
ok('…and caught FETCHING', control.fetched.length >= 2, control.fetched.join(' | ') || 'nothing seen');
ok('…and its handler and link are seen in the tree', control.parsed.length >= 2, control.parsed.join(' | '));

const rest = results.slice(1);
const page = rest.find((r) => r.section === 'page' && r.input.includes('<table'));
if (!expectDirty) {
  ok('the real editor\'s page loads: its elements are in the tree', !!page && page.elements > 60, `${page?.elements} elements`);
  ok('…its words are on the page', !!page && page.text > 400, `${page?.text} characters`);
  ok('…its two pictures are asked for', !!page && page.pictures === 2, `${page?.pictures} asked for`);
}

const sections = [...new Set(rest.map((r) => r.section))];
console.log('\n  Outputs');
for (const section of sections) {
  const rows = rest.filter((r) => r.section === section);
  const ran = rows.filter((r) => r.ran.length > 0);
  const fetched = rows.filter((r) => r.fetched.length > 0);
  const parsed = rows.filter((r) => r.parsed.length > 0);
  const show = (list, key) => list.slice(0, 5).map((r) => `#${r.index} ${r[key].slice(0, 3).join(', ')}  <=  ${r.input.slice(0, 90).replace(/\s+/g, ' ')}`).join('\n          ');
  if (expectDirty) {
    console.log(`        ${section}: ${rows.length} outputs — ran ${ran.length}, fetched ${fetched.length}, off-list in the tree ${parsed.length}`);
  } else {
    ok(`${section}: ${rows.length} outputs, nothing RAN`, ran.length === 0, show(ran, 'ran'));
    ok(`${section}: ${rows.length} outputs, nothing FETCHED but kept pictures`, fetched.length === 0, show(fetched, 'fetched'));
    ok(`${section}: ${rows.length} outputs, the browser's tree holds only the list`, parsed.length === 0, show(parsed, 'parsed'));
  }
}

const total = (key) => rest.filter((r) => r[key].length > 0).length;
if (expectDirty) {
  console.log('\n  Calibration');
  ok(`uncleaned outputs are caught running (${total('ran')} of ${rest.length})`, total('ran') >= 10);
  ok(`uncleaned outputs are caught fetching (${total('fetched')} of ${rest.length})`, total('fetched') >= 3);
  ok(`uncleaned outputs are caught in the tree (${total('parsed')} of ${rest.length})`, total('parsed') >= 10);
}

const pictures = rest.reduce((n, r) => n + r.pictures, 0);
console.log(`\n  pictures: ${pictures} requests for pictures the sanitiser kept (http/https <img>). Allowed by design;`);
console.log('            a picture from the web tells its host that the page was opened.');
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
