// ============================================================================
//  The render service: POST /render/doc, /render/sheet and /render/pdf, GET /health.
//  Reached by the API only.
// ============================================================================
//
//  Request:  {"updates": ["<base64>", ...]} — the stored state, then every
//            stored update after it. The same for all three routes.
//  Answers:  200 /render/doc   {state, html, text, dropped, schema}
//                /render/sheet {state, xlsx, html, text, sheets, cells, schema}
//                (state and xlsx are base64)
//            400 not that shape      413 too large
//            422 the bytes are not a document (spreadsheet) the renderer can read
//            504 the render ran past the time limit — the worker is killed
//                and replaced; the API fails the save and says so
//
//  POST /render/pdf (decision 0011 condition 2, docs/DOCS_PDF_DESIGN.md):
//  Request:  {"updates": [...], "pictures": {"/api/docs/...": "<base64>"}}
//            — pictures are the document's own stored pictures, optional.
//  Answers:  200 {pdf (base64), ms, dropped, schema}
//            422 {reason: "script_not_checked", scripts} — a script no reader
//                has checked yet (Amit, 1 Oct 2026); the send says so
//            413 {reason: "pictures_too_large"} — its pictures do not fit in
//                the job folder (/tmp, a 16 MB tmpfs); the sentence says to
//                remove some and try again (Mr. Singh, 7 Oct 2026)
//            504 past the SAME time limit as a render (render + PDF together)
//            500 {reason: "pdf_failed"} — Typst could not build it (the log
//                says no_room when /tmp filled with no pictures of its own)
//
//  The time limit is 10 s (Mr. Singh, 29 Sept 2026). RENDER_TIMEOUT_MS can
//  only LOWER it (a test proves the kill quickly); it is never raised.
//  Logs name sizes, times and element NAMES — never a document's content.
// ============================================================================

import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { SCHEMA_VERSION } from './render-doc.mjs';
import { SHEETS_SCHEMA_VERSION } from './render-sheet.mjs';
import { buildPdf, PdfFailed } from './render-pdf.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const LIMIT_MS = Math.min(10_000, Number(process.env.RENDER_TIMEOUT_MS ?? 10_000) || 10_000);
const WORKERS = Math.max(1, Math.min(4, Number(process.env.RENDER_WORKERS ?? 2) || 2));
// A stored state may be 32 MB (DocsEndpoints.MaxStateBytes); base64 and JSON add a third.
const MAX_BODY = 48 * 1024 * 1024;
// The refusal a person can act on (docs/DOCS_PDF_DESIGN.md §10, Mr. Singh's
// wording, 7 Oct 2026). MAX_BODY still admits about 36 MB of pictures, more
// than twice what /tmp holds; that inconsistency is a switch-on item the
// measurements decide. This sentence is owed whatever they show.
const PICTURES_TOO_LARGE =
  'This document has too many pictures, or pictures too large, to make a PDF. Remove some and try again.';

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
    const b64 = (u8) => Buffer.from(u8).toString('base64');
    job.resolve(m.ok
      ? { status: 200, body: { ...m.result, state: b64(m.result.state), ...(m.result.xlsx ? { xlsx: b64(m.result.xlsx) } : {}) } }
      : { status: 422, body: { error: `not a ${job.kind === 'sheet' ? 'spreadsheet' : 'document'} the renderer can read` } });
  }
  w.on('message', onMessage);
  w.postMessage({ id, kind: job.kind, updates: job.updates }, job.updates.map((u) => u.buffer));
}

function render(kind, updates) {
  return new Promise((resolve) => { waiting.push({ kind, updates, resolve }); drain(); });
}

// ---- HTTP -------------------------------------------------------------------
const ROUTES = new Map([['/render/doc', 'doc'], ['/render/sheet', 'sheet'], ['/render/pdf', 'pdf']]);

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, schema: SCHEMA_VERSION, sheetsSchema: SHEETS_SCHEMA_VERSION, limitMs: LIMIT_MS });
  }
  // ONE route table for all three routes (merged 6 Oct 2026: 390's spreadsheet
  // route met 370's PDF route on these lines; Mr. Singh: one shape, both
  // downstream uses rewired to it). A Map, not an object literal: an object
  // would answer '/constructor' or '/__proto__' with something truthy.
  const route = req.method === 'POST' ? ROUTES.get(req.url) : undefined;
  if (!route) return send(res, 404, { error: 'not found' });

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
    const pictures = new Map();
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(body?.updates) || body.updates.length === 0 || body.updates.length > 100_000
        || !body.updates.every((u) => typeof u === 'string')) throw new Error('shape');
      updates = body.updates.map((u) => new Uint8Array(Buffer.from(u, 'base64')));
      if (route === 'pdf' && body.pictures != null) {
        if (typeof body.pictures !== 'object' || Array.isArray(body.pictures)) throw new Error('shape');
        const entries = Object.entries(body.pictures);
        if (entries.length > 500) throw new Error('shape');
        for (const [src, b] of entries) {
          if (typeof src !== 'string' || !src.startsWith('/api/') || typeof b !== 'string') throw new Error('shape');
          pictures.set(src, new Uint8Array(Buffer.from(b, 'base64')));
        }
      }
    } catch {
      return send(res, 400, { error: 'expected {"updates": ["<base64>", ...]}' });
    }
    const t0 = Date.now();
    // The WORKER only ever sees 'doc' or 'sheet': a PDF is a document rendered
    // first, then built by Typst in this process under the same deadline.
    const r = await render(route === 'sheet' ? 'sheet' : 'doc', updates);
    const ok = r.status === 200;
    if (route === 'sheet') {
      // Sizes and counts only; never a cell.
      log(`sheet ${r.status} in=${size}B updates=${updates.length} ms=${Date.now() - t0}${ok ? ` xlsx=${Math.floor(r.body.xlsx.length * 3 / 4)}B html=${r.body.html.length} sheets=${r.body.sheets} cells=${r.body.cells}` : ''}`);
      return send(res, r.status, r.body);
    }
    const dropped = r.body.dropped?.length ? ` unknown=${r.body.dropped.map((d) => `${d.name}x${d.count}`).join(',')}` : '';
    // The document's structure (json) is for the PDF only: a document's own
    // answer stays exactly what it was before either pull request.
    const { json, ...docBody } = r.body;
    if (route === 'doc') {
      log(`doc ${r.status} in=${size}B updates=${updates.length} ms=${Date.now() - t0}${ok ? ` html=${r.body.html.length}` : ''}${dropped}`);
      return send(res, r.status, docBody);
    }
    if (!ok) {
      log(`pdf ${r.status} (render) in=${size}B ms=${Date.now() - t0}${dropped}`);
      return send(res, r.status, docBody);
    }
    try {
      // One deadline for render and PDF together (Mr. Singh's condition 4).
      const p = await buildPdf({ json, text: r.body.text, pictures, deadline: t0 + LIMIT_MS });
      log(`pdf 200 in=${size}B pictures=${pictures.size} ms=${Date.now() - t0} typst_ms=${p.ms} out=${p.pdf.length}B${dropped}`);
      return send(res, 200, { pdf: p.pdf.toString('base64'), ms: Date.now() - t0, dropped: r.body.dropped, schema: SCHEMA_VERSION });
    } catch (e) {
      const code = e instanceof PdfFailed ? e.code : 'pdf_failed';
      const d = e?.detail ?? {};
      log(`pdf FAILED ${code} ms=${Date.now() - t0}${d.scripts ? ` scripts=${d.scripts.join(',')}` : ''}${d.message ? ` typst: ${d.message}` : ''}`
        + `${d.stage ? ` stage=${d.stage} pictures=${d.pictures} bytes=${d.bytes}` : ''}${code === 'pdf_failed' && e?.code ? ` error=${e.code}` : ''}`);
      if (code === 'pictures_too_large') return send(res, 413, { error: PICTURES_TOO_LARGE, reason: code });
      if (code === 'script_not_checked') return send(res, 422, { error: 'This document contains text in a script whose PDF has not been checked by a reader yet.', reason: code, scripts: e.detail.scripts });
      if (code === 'timeout') return send(res, 504, { error: 'render timed out', limitMs: LIMIT_MS });
      return send(res, 500, { error: 'The PDF could not be built.', reason: 'pdf_failed' });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => log(`listening on ${PORT}; schema ${SCHEMA_VERSION}, ${SHEETS_SCHEMA_VERSION}; limit ${LIMIT_MS} ms; ${WORKERS} workers`));
