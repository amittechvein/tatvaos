// ============================================================================
//  The render service: POST /render/doc, GET /health. Reached by the API only.
// ============================================================================
//
//  Request:  {"updates": ["<base64>", ...]} — the stored state, then every
//            stored update after it.
//  Answers:  200 {state, html, text, dropped, schema}   (state is base64)
//            400 not that shape      413 too large
//            422 the bytes are not a document the renderer can read
//            504 the render ran past the time limit — the worker is killed
//                and replaced; the API fails the save and says so
//
//  The time limit is 10 s (Mr. Singh, 29 Sept 2026). RENDER_TIMEOUT_MS can
//  only LOWER it (a test proves the kill quickly); it is never raised.
//  Logs name sizes, times and element NAMES — never a document's content.
// ============================================================================

import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { SCHEMA_VERSION } from './render-doc.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const LIMIT_MS = Math.min(10_000, Number(process.env.RENDER_TIMEOUT_MS ?? 10_000) || 10_000);
const WORKERS = Math.max(1, Math.min(4, Number(process.env.RENDER_WORKERS ?? 2) || 2));
// A stored state may be 32 MB (DocsEndpoints.MaxStateBytes); base64 and JSON add a third.
const MAX_BODY = 48 * 1024 * 1024;

const log = (msg) => process.stdout.write(`${new Date().toISOString()} render ${msg}\n`);

// ---- a small pool of workers, each replaced when it is killed ----------------
let seq = 0;
const idle = [];
const waiting = [];
function spawn() {
  const w = new Worker(new URL('./worker.mjs', import.meta.url));
  w.unref();
  w.on('error', (e) => log(`worker error: ${String(e?.message ?? e).slice(0, 120)}`));
  // Into the pool only once it has loaded the schema (worker.mjs says ready).
  w.once('message', (m) => { if (m?.ready) { idle.push(w); drain(); } });
}
for (let i = 0; i < WORKERS; i += 1) spawn();

function drain() {
  while (idle.length && waiting.length) run(idle.pop(), waiting.shift());
}

function run(w, job) {
  const id = ++seq;
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    w.removeListener('message', onMessage);
    w.terminate().catch(() => {});
    spawn(); // the killed worker's replacement
    job.resolve({ status: 504, body: { error: 'render timed out', limitMs: LIMIT_MS } });
  }, LIMIT_MS);
  function onMessage(m) {
    if (m.id !== id || done) return;
    done = true;
    clearTimeout(timer);
    w.removeListener('message', onMessage);
    idle.push(w);
    drain();
    job.resolve(m.ok
      ? { status: 200, body: { ...m.result, state: Buffer.from(m.result.state).toString('base64') } }
      : { status: 422, body: { error: 'not a document the renderer can read' } });
  }
  w.on('message', onMessage);
  w.postMessage({ id, updates: job.updates }, job.updates.map((u) => u.buffer));
}

function render(updates) {
  return new Promise((resolve) => { waiting.push({ updates, resolve }); drain(); });
}

// ---- HTTP -------------------------------------------------------------------
function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, schema: SCHEMA_VERSION, limitMs: LIMIT_MS });
  if (req.method !== 'POST' || req.url !== '/render/doc') return send(res, 404, { error: 'not found' });

  const chunks = [];
  let size = 0;
  let refused = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY && !refused) { refused = true; send(res, 413, { error: 'too large' }); req.destroy(); }
    else if (!refused) chunks.push(c);
  });
  req.on('end', async () => {
    if (refused) return;
    let updates;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(body?.updates) || body.updates.length === 0 || body.updates.length > 100_000
        || !body.updates.every((u) => typeof u === 'string')) throw new Error('shape');
      updates = body.updates.map((u) => new Uint8Array(Buffer.from(u, 'base64')));
    } catch {
      return send(res, 400, { error: 'expected {"updates": ["<base64>", ...]}' });
    }
    const t0 = Date.now();
    const r = await render(updates);
    const dropped = r.body.dropped?.length ? ` unknown=${r.body.dropped.map((d) => `${d.name}x${d.count}`).join(',')}` : '';
    log(`doc ${r.status} in=${size}B updates=${updates.length} ms=${Date.now() - t0}${r.status === 200 ? ` html=${r.body.html.length}` : ''}${dropped}`);
    send(res, r.status, r.body);
  });
});

server.listen(PORT, '0.0.0.0', () => log(`listening on ${PORT}; schema ${SCHEMA_VERSION}; limit ${LIMIT_MS} ms; ${WORKERS} workers`));
