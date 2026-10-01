// ============================================================================
//  THE PDF GATE (decision 0011 condition 2; docs/DOCS_PDF_DESIGN.md §5, §8)
// ============================================================================
//
//  Runs INSIDE the gate image (apps/render/Dockerfile.pdf-gate = the real
//  render image + test tools), under the render container's own limits, from
//  tests/docs-render/pdf-gate.sh. Nothing past it is built if it fails.
//
//    1. THE SAME DOCUMENT, AS TEXT. pdftotext of each PDF equals the render
//       service's text for the same stored state (0011's proof), and every
//       page carries its number at the foot. Calibrated: one changed word
//       is caught.
//    2. DATA, NEVER MARKUP; A LOCKED ROOT (Mr. Singh's conditions 1 and 2).
//       Red first on a deliberately unsafe template: markup in the text is
//       interpreted, a "#read" of the data file runs, and with the root
//       opened "/etc/passwd" is read — each caught. Then the real template:
//       every planted string prints literally, no file outside the job
//       folder and the fonts is opened, no socket is made, no link to
//       javascript:, a planted "_pic" is ignored.
//    3. SHAPING (tool check, every script). The glyphs drawn in the Indian-
//       script font equal hb-shape's for the same text and font (by outline).
//       Calibrated: with shaping switched off in the reference, the conjunct
//       lines differ.
//    4. EVERY NODE AND MARK. Fonts (bold, italic, mono, serif), the link
//       addresses, colour, the stored picture drawn and the web one named,
//       the page break.
//    5. INSIDE THE LIMITS (condition 4). Time and memory for the largest
//       fixture; a build past its deadline is killed and nothing is left
//       running.
//
//  Writes sample PDFs to $GATE_OUT for the people who check them.
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { documentExtensions } from '/app/apps/web/components/docs/schema.ts';
import { renderDoc } from '/app/apps/render/src/render-doc.mjs';
import { buildPdf, PdfFailed, SCRIPTS, scriptsIn, CHECKED_SCRIPTS } from '/app/apps/render/src/render-pdf.mjs';

const FX = '/gate/fixtures/';
const OUT = process.env.GATE_OUT ?? '/out';
const FONTS = process.env.PDF_FONT_DIR ?? '/usr/share/fonts';
const ALL = new Set(Object.keys(SCRIPTS));
const schema = getSchema(documentExtensions());
// A 1x1 PNG: a stored picture's bytes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `\n        ${String(detail).slice(0, 600)}` : ''}`); }
}
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20 });
const fixture = (name) => JSON.parse(readFileSync(`${FX}${name}.json`, 'utf8'));
const stateOf = (json) => Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, json, 'default'));

async function pdfOf(state, opts = {}) {
  const r = renderDoc([state]);
  const p = await buildPdf({ json: r.json, text: r.text, deadline: Date.now() + 10_000, checkedScripts: ALL, ...opts });
  return { r, ...p };
}
async function tryPdf(state, opts) {
  try { return await pdfOf(state, opts); } catch (e) { return { error: e }; }
}

/** pdftotext, with the page number at each foot checked and removed. */
function textOf(pdf) {
  writeFileSync('/tmp/g.pdf', pdf);
  const raw = sh('pdftotext', ['-enc', 'UTF-8', '/tmp/g.pdf', '-']);
  const pages = raw.split('\f');
  if (pages.length && pages[pages.length - 1].trim() === '') pages.pop();
  let numbersOk = pages.length > 0;
  const body = pages.map((pg, i) => {
    const lines = pg.split('\n').filter((l) => l.trim());
    const last = lines.pop();
    if ((last ?? '').trim() !== String(i + 1)) numbersOk = false;
    return lines.join('\n');
  }).join('\n');
  return { body, pages: pages.length, numbersOk };
}

// Bullets, list numbers and task boxes are the PDF's own; nothing else may be extra.
const DECOR = /^(\d{1,3}[.)]|[a-z][.)]|[ivxlc]{1,6}[.)]|[•◦▪‣–☐☑])$/;
// Words in an Indian script are NOT compared through pdftotext: the first CI
// run (1 Oct 2026) showed the PDF's text layer splits and repeats clusters
// (कृपया -> "कृ पया"), so copy and search are imperfect — a finding reported
// on its own (indicTextLayer below). What the page SHOWS for those words is
// checked against the stored text glyph by glyph in part 3.
const INDIC = /[ऀ-ൿ]/;
function bagDiff(server, pdf) {
  const tok = (s) => s.normalize('NFC').split(/\s+/).filter((t) => t && !INDIC.test(t));
  const count = new Map();
  for (const t of tok(server)) count.set(t, (count.get(t) ?? 0) + 1);
  const extra = [];
  for (const t of tok(pdf)) { const c = count.get(t) ?? 0; if (c > 0) count.set(t, c - 1); else extra.push(t); }
  const missing = [...count].flatMap(([t, c]) => Array(c).fill(t));
  return { missing, extra: extra.filter((t) => !DECOR.test(t)) };
}
const sameText = (d) => d.missing.length === 0 && d.extra.length === 0;
const flat = (s) => s.replace(/\s+/g, ' ').trim();

/** Every path opened and every socket made, from an strace log. */
function traced(file) {
  const log = readFileSync(file, 'utf8');
  const opened = [...log.matchAll(/open(?:at2?)?\([^"]*"([^"]+)"/g)].map((m) => m[1]);
  const sockets = log.split('\n').filter((l) => /\b(socket|connect)\(/.test(l));
  return { opened, sockets };
}
const SYSTEM = [/^\/lib\//, /^\/usr\/lib\//, /^\/usr\/local\/lib\/[^/]+\.so[.\d]*$/, /^\/etc\/(localtime|timezone|config\/system)$/, /^\/etc\/ld-musl/, /^\/proc\/self\//, /^\/dev\/(null|urandom)$/, /^\/sys\/devices\/system\/cpu/, /^\/sys\/fs\/cgroup/, /^\/proc\/(stat|meminfo|cpuinfo)$/];
function outside(opened, dir) {
  return opened.filter((p) => !(p.startsWith(`${dir}/`) || p === dir || p.startsWith(`${FONTS}/`) || p === FONTS || SYSTEM.some((r) => r.test(p))));
}

console.log('0. The engine in this image');
{
  const v = sh('typst', ['--version']).trim();
  check(`Typst is Alpine's 0.14.2 (${v})`, /0\.14\.2/.test(v));
  const fams = sh('typst', ['fonts', '--font-path', FONTS, '--ignore-system-fonts']);
  for (const f of ['Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'DejaVu Sans', 'DejaVu Serif', 'Noto Sans',
    ...Object.keys(SCRIPTS).map((s) => `Noto Sans ${s === 'Odia' ? 'Oriya' : s}`)]) {
    check(`font family the template names is installed: ${f}`, fams.split('\n').some((l) => l.trim() === f));
  }
  check('only Devanagari is switched on beyond English (Amit, 1 Oct 2026)', [...CHECKED_SCRIPTS].join() === 'Devanagari');
}

console.log('\n1. The same document, as text (every fixture)');
const FIXTURES = ['editor-page', 'word-paste', 'nested-lists', 'merged-cells', 'every-mark-pair', 'google-docs-paste', 'indian-scripts'];
const built = {};
for (const name of FIXTURES) {
  const res = await tryPdf(stateOf(fixture(name)), name === 'editor-page' ? { pictures: picturesOf(fixture(name)) } : {});
  if (res.error) { check(`${name}: built`, false, `${res.error.code ?? ''} ${JSON.stringify(res.error.detail ?? res.error.message)}`); continue; }
  built[name] = res;
  writeFileSync(`${OUT}/${name}.pdf`, res.pdf);
  const t = textOf(res.pdf);
  const d = bagDiff(res.r.text, t.body);
  check(`${name}: the PDF's text is the server's text (${t.pages} page(s), ${res.ms} ms)`, sameText(d),
    `missing ${JSON.stringify(d.missing.slice(0, 12))} extra ${JSON.stringify(d.extra.slice(0, 12))}`);
  check(`${name}: every page has its number at the foot`, t.numbersOk);
  if (INDIC.test(res.r.text)) {
    const want = res.r.text.normalize('NFC').split(/\s+/).filter((w) => INDIC.test(w));
    const got = new Set(t.body.normalize('NFC').split(/\s+/));
    const exact = want.filter((w) => got.has(w)).length;
    console.log(`  info  ${name}: the PDF's TEXT LAYER (copy, search) has ${exact} of ${want.length} Indian-script words intact — a finding, not a gate check`);
  }
}
{
  const ep = built['editor-page'];
  if (ep) {
    const words = ep.r.text.split(/\s+/);
    const i = words.findIndex((w) => w.length > 4);
    const planted = [...words.slice(0, i), `${words[i]}x`, ...words.slice(i + 1)].join(' ');
    check('calibration: one changed word is caught', !sameText(bagDiff(planted, textOf(ep.pdf).body)));
  }
}

function picturesOf(json) {
  const m = new Map();
  (function w(n) { if (n?.type === 'image' && typeof n.attrs?.src === 'string' && n.attrs.src.startsWith('/api/')) m.set(n.attrs.src, PNG); (n?.content ?? []).forEach(w); })(json);
  return m;
}

console.log('\n2. Data, never markup; a locked root (Mr. Singh, conditions 1 and 2)');
const UNSAFE = new URL('file:///gate/pdf-unsafe.typ');
const READ = '#read("/etc/passwd")';
{
  // RED FIRST: the unsafe template, which evaluates document text as markup.
  const one = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const u = await tryPdf(stateOf(one('*bold* = heading $ x^2 $')), { template: UNSAFE });
  const ut = u.error ? '' : flat(textOf(u.pdf).body);
  check('red first: the unsafe template interprets the text (the literal-text check FAILS on it)',
    !u.error && ut !== '' && !ut.includes('*bold* = heading $ x^2 $'), u.error ? `${u.error.code} ${JSON.stringify(u.error.detail)}` : ut.slice(0, 160));
  const u2 = await tryPdf(stateOf(one('#read("doc.json")')), { template: UNSAFE });
  const ut2 = u2.error ? '' : flat(textOf(u2.pdf).body);
  check('red first: …and a "#read" in the text ran — the data file is in the PDF', ut2.includes('"type"'), ut2.slice(0, 160));

  const readDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: READ }] }] };
  const wide = await tryPdf(stateOf(readDoc), { template: UNSAFE, root: '/', traceTo: '/tmp/wide.trace' });
  const wt = wide.error ? '' : textOf(wide.pdf).body;
  const wtr = traced('/tmp/wide.trace');
  check('red first: with the root opened, the unsafe template reads /etc/passwd — the checks SEE it',
    wt.includes('root:') && wtr.opened.includes('/etc/passwd'), wide.error ? `${wide.error.code}` : `root: ${wt.includes('root:')}, opened: ${wtr.opened.includes('/etc/passwd')}`);

  const locked = await tryPdf(stateOf(readDoc), { template: UNSAFE, traceTo: '/tmp/locked.trace' });
  const ltr = traced('/tmp/locked.trace');
  check('the locked root alone stops it: the unsafe template cannot read /etc/passwd (the build fails, nothing opened)',
    locked.error?.code === 'typst_failed' && !ltr.opened.includes('/etc/passwd'),
    locked.error ? `${locked.error.code} ${JSON.stringify(locked.error.detail)}` : 'it built');
}
{
  // The real template, on the injection fixture, with a "_pic" planted the
  // way a hand-made client would: straight into the stored Yjs.
  const ydoc = prosemirrorJSONToYDoc(schema, fixture('pdf-injection'), 'default');
  const para = new Y.XmlElement('paragraph');
  const planted = new Y.XmlElement('image');
  planted.setAttribute('src', '/api/docs/x/images/y');
  planted.setAttribute('alt', 'stored picture');
  planted.setAttribute('_pic', 'doc.json');
  const planted2 = new Y.XmlElement('image');
  planted2.setAttribute('src', '/api/docs/x/images/none');
  planted2.setAttribute('alt', 'no bytes supplied');
  planted2.setAttribute('_pic', 'pic-0.png');
  para.insert(0, [planted, planted2]);
  ydoc.getXmlFragment('default').insert(ydoc.getXmlFragment('default').length, [para]);
  const res = await tryPdf(Y.encodeStateAsUpdate(ydoc), {
    traceTo: '/tmp/inj.trace', pictures: new Map([['/api/docs/x/images/y', PNG]]),
  });
  if (res.error) check('the injection fixture builds with the real template', false, `${res.error.code} ${JSON.stringify(res.error.detail)}`);
  else {
    writeFileSync(`${OUT}/pdf-injection.pdf`, res.pdf);
    const t = flat(textOf(res.pdf).body);
    for (const s of [READ, '#include "doc.json"', '#import "@preview/cetz:0.3.4": *', '#eval("read(\\"/etc/passwd\\")")',
      '#image("/etc/passwd")', '#{ panic("injected") }', '#set page(paper: "a0")',
      '$ x^2 $ = heading *bold* _emph_ `raw` <label> @ref ]] [[', '#include "main.typ"', '#read("doc.json")']) {
      check(`prints literally: ${s}`, t.includes(s));
    }
    check('no line of /etc/passwd is in the PDF', !t.includes('root:'));
    check('the page is A4 (a planted "#set page(paper: \\"a0\\")" did nothing)', /595\.2\d* x 841\.8\d* pts/.test(sh('pdfinfo', ['/tmp/g.pdf'])));
    const tr = traced('/tmp/inj.trace');
    const out = outside(tr.opened, res.dir);
    check(`no file opened outside the job folder and the fonts (${tr.opened.length} opens)`, out.length === 0, JSON.stringify(out.slice(0, 10)));
    check('no socket made, no connection tried', tr.sockets.length === 0, tr.sockets.slice(0, 3).join(' | '));
    sh('mutool', ['clean', '-d', '/tmp/g.pdf', '/tmp/g-plain.pdf']);
    const plain = readFileSync('/tmp/g-plain.pdf', 'latin1');
    check('no link to javascript: in the PDF', !/javascript/i.test(plain));
    const trace = sh('mutool', ['trace', '/tmp/g.pdf']);
    // Two image nodes name the one stored picture (the fixture's own, and the
    // one planted with _pic "doc.json"): both drawn from its bytes, and a
    // planted name never used (doc.json is not an image: the build would fail).
    check('the stored picture is drawn for both nodes that name it — a planted "_pic" ignored', (trace.match(/<fill_image/g) ?? []).length === 2,
      `${(trace.match(/<fill_image/g) ?? []).length} drawn`);
    check('a picture with no stored bytes is named, not drawn (its planted "_pic" ignored)', t.includes('[picture: no bytes supplied]'));
    check('pictures by path or web address are named, not fetched',
      t.includes('[picture: a path as a picture]') && t.includes('[picture: the data file as a picture]') && t.includes('[picture: from the web]'));
  }
}

console.log('\n3. Shaping: the glyphs drawn equal HarfBuzz\'s (tool check, every script)');
{
  const ind = built['indian-scripts'];
  if (!ind) check('indian-scripts built', false);
  else {
    const exp = fixture('indian-scripts').content.map((p) => ({ text: p.content[0].text, script: scriptsIn(p.content[0].text)[0] }));
    writeFileSync('/tmp/exp.json', JSON.stringify(exp));
    writeFileSync('/tmp/ind.pdf', ind.pdf);
    const run = (env = {}) => {
      const r = spawnSync('python3', ['/gate/pdf-shaping.py', '/tmp/ind.pdf', '/tmp/exp.json', FONTS], { encoding: 'utf8', env: { ...process.env, ...env } });
      try { return JSON.parse(r.stdout); } catch { return { ok: false, error: (r.stderr || r.stdout).slice(-600) }; }
    };
    const s = run();
    if (s.error) check('the shaping check ran', false, s.error);
    else {
      check(`the PDF has one line per expected line (${s.pdf_lines}/${s.expected_lines})`, s.pdf_lines === s.expected_lines,
        s.trace_sample ? `the trace looked like: ${JSON.stringify(s.trace_sample)}` : '');
      for (const l of s.lines) {
        check(`line ${l.line} (${l.script}${l.font ? `, ${l.font}` : ''}): ${l.pdf_glyphs ?? '?'} glyphs equal hb-shape's`, l.ok,
          l.why ?? `pdf ${l.pdf_glyphs} vs reference ${l.reference_glyphs}, first difference at glyph ${l.first_difference_at_glyph}`);
      }
      // Calibration: the same comparison with shaping SWITCHED OFF in the
      // reference must fail on the conjunct lines — the check sees shaping.
      const off = run({ SHAPING_FEATURES: '-akhn,-rphf,-rkrf,-pref,-blwf,-abvf,-half,-pstf,-vatu,-cjct,-pres,-abvs,-blws,-psts' });
      const conj = (off.lines ?? []).filter((l) => l.script === 'Devanagari');
      check('calibration: with shaping switched off in the reference, Devanagari lines NO LONGER match (only meaningful once they matched above)',
        s.lines.filter((l) => l.script === 'Devanagari').every((l) => l.ok) && conj.filter((l) => !l.ok).length >= 3,
        JSON.stringify(conj.map((l) => l.ok)));
    }
  }
}

console.log('\n4. Every node and mark (editor-page)');
{
  const ep = built['editor-page'];
  if (!ep) check('editor-page built', false);
  else {
    writeFileSync('/tmp/ep.pdf', ep.pdf);
    const fonts = sh('pdffonts', ['/tmp/ep.pdf']);
    for (const f of ['LiberationSans-Bold', 'LiberationSans-Italic', 'LiberationMono', 'DejaVuSerif']) {
      check(`font used: ${f}`, fonts.includes(f), fonts.split('\n').slice(2).map((l) => l.split(/\s+/)[0]).join(' '));
    }
    sh('mutool', ['clean', '-d', '/tmp/ep.pdf', '/tmp/ep-plain.pdf']);
    const plain = readFileSync('/tmp/ep-plain.pdf', 'latin1');
    for (const href of ['https://tatvaos.com/admissions', 'mailto:office@school.example']) {
      check(`link kept: ${href}`, plain.includes(href));
    }
    const trace = sh('mutool', ['trace', '/tmp/ep.pdf']);
    check('colour kept: rgb(26, 115, 232) text', /color="0\.10\d* 0\.45\d* 0\.9\d*"/.test(trace),
      `colours in the trace: ${JSON.stringify([...new Set(trace.match(/<fill_text[^>]*>/g) ?? [])].slice(0, 6))}`);
    check('the stored picture is drawn', (trace.match(/<fill_image/g) ?? []).length >= 1);
    check('the web picture is named, not fetched', textOf(ep.pdf).body.includes('[picture: From the web]'));
    check('the page break makes a second page', textOf(ep.pdf).pages >= 2);
  }
}

console.log('\n5. Inside the limits (condition 4)');
{
  const g = built['google-docs-paste'];
  if (g) check(`the largest fixture builds well inside 10 s (${g.ms} ms for the PDF)`, g.ms < 5_000);
  const t0 = Date.now();
  const r = await tryPdf(stateOf(fixture('google-docs-paste')), { deadline: Date.now() + 50 });
  const took = Date.now() - t0;
  check(`a build past its deadline is killed and refused (timeout after ${took} ms)`, r.error instanceof PdfFailed && r.error.code === 'timeout',
    r.error ? `${r.error.code}` : `it built in ${r.ms} ms — the deadline was not reached`);
  check('…and no Typst process is left running', spawnSync('pgrep', ['-x', 'typst']).status === 1);
  let peak = '';
  try { peak = readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(); } catch { /* cgroup v1 */ }
  check(`memory stayed under the container's 512 MB (peak ${peak ? `${Math.round(Number(peak) / 1048576)} MB` : 'not readable'})`,
    peak !== '' && Number(peak) < 512 * 1048576);
}

console.log('\n6. A sample for the reader (Devanagari, day one)');
{
  const s = await tryPdf(stateOf(fixture('devanagari-sample')));
  if (s.error) check('devanagari-sample built', false, `${s.error.code}`);
  else { writeFileSync(`${OUT}/devanagari-sample.pdf`, s.pdf); check(`devanagari-sample.pdf written (${s.pdf.length} bytes) for a reader`, true); }
}

console.log(`\n  passed: ${passed}   failed: ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
