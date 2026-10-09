// ============================================================================
//  The PDF of a document, built from what the server stored
// ============================================================================
//
//  Decision 0011 condition 2; docs/DOCS_PDF_DESIGN.md (Typst approved by Mr.
//  Singh, 1 Oct 2026, with four conditions — each is marked below).
//
//  Input: the document JSON renderDoc() made from the stored Yjs state and
//  every stored update (never the browser's copy), its plain text, and the
//  bytes of the document's own stored pictures, keyed by their stored
//  address (/api/docs/...). Output: the PDF bytes.
//
//  (1) DATA, NEVER MARKUP. The JSON is written to doc.json and read by one
//      fixed template (apps/render/pdf/main.typ). No document text is ever
//      put into Typst source. Proven by the gate's injection fixture.
//  (2) A LOCKED ROOT. Typst runs with --root set to a fresh empty folder that
//      holds only the template, doc.json and the pictures this code wrote,
//      under names it chose. No package path, no cache, no network (the
//      container has none). A picture is the stored bytes, never a path.
//  (4) INSIDE THE LIMITS. Typst runs inside the same locked-down container,
//      against the same deadline as the render: past it, it is killed and
//      the send fails with a clear message, as a failed render does.
//
//  SCRIPTS (Amit, 1 Oct 2026). Every script below is built in and checked by
//  the tool check from day one, but a document containing one is turned
//  into a PDF only once a person who reads that script has checked a sample
//  PDF. Who checked which, and when: docs/DOCS_PDF_DESIGN.md, section 9.
// ============================================================================

import { mkdtemp, writeFile, copyFile, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export const SCRIPTS = {
  Devanagari: [0x0900, 0x097f], Bengali: [0x0980, 0x09ff], Gurmukhi: [0x0a00, 0x0a7f],
  Gujarati: [0x0a80, 0x0aff], Odia: [0x0b00, 0x0b7f], Tamil: [0x0b80, 0x0bff],
  Telugu: [0x0c00, 0x0c7f], Kannada: [0x0c80, 0x0cff], Malayalam: [0x0d00, 0x0d7f],
};

/** Checked by a reader (Amit, 1 Oct 2026: day one is English and Devanagari — Hindi and Marathi). */
export const CHECKED_SCRIPTS = new Set(['Devanagari']);

/** The Indian scripts that appear in a text. */
export function scriptsIn(text) {
  const found = new Set();
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp < 0x0900 || cp > 0x0d7f) continue;
    for (const [name, [lo, hi]] of Object.entries(SCRIPTS)) if (cp >= lo && cp <= hi) { found.add(name); break; }
  }
  return [...found];
}

/** png / jpg / gif / webp by their first bytes; anything else (SVG included) is not drawn. */
export function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

export class PdfFailed extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

// ---------------------------------------------------------------------------
//  No room in the job folder. In the container /tmp is a 16 MB tmpfs and the
//  request body limit is 48 MB, so ONE document with a few dozen photographs
//  fills it (docs/DOCS_PDF_DESIGN.md §10, Mr. Singh 7 Oct 2026). Until this,
//  the write threw a plain ENOSPC and the person read only "The PDF could not
//  be built" — true, and nothing they could act on. Now it is its own reason:
//    pictures_too_large  THIS job's own pictures cannot fit, however empty
//                        /tmp is (the server's 413 and its sentence: remove
//                        some and try again)
//    no_room             they could have fitted: OTHER jobs filled /tmp at the
//                        same moment. Still the generic 500 to the person
//                        until Mr. Singh words a "busy, try again" sentence,
//                        but named in the log so the two are never confused
//  Caught wherever the folder fills: making it, writing into it, and Typst
//  writing out.pdf (its message carries the OS error, "os error 28").
//
//  Corrected 7 Oct 2026 by measurement (§10, cases 2 and 3): the first
//  version chose pictures_too_large whenever the job HAD pictures. With five
//  or ten one-photo PDFs at once, the shared /tmp filled with the others'
//  files and single-photo documents were told to remove pictures - wrong
//  advice; trying again would have worked. The test is now the job's OWN
//  need against what /tmp can hold at all. The need is twice the pictures:
//  Typst puts a JPEG into the PDF unchanged, so out.pdf is as big as the
//  pictures and sits beside them (case 0: 1 photo of 4.6 MB -> PDF 4.6 MB;
//  2 photos overflowed 16 MB at Typst's write, not before).
// ---------------------------------------------------------------------------
export const isNoRoom = (e) => e?.code === 'ENOSPC';
export const TYPST_NO_ROOM = /os error 28|no space left on device/i;

/** Typst's stderr with every quoted string blanked: Typst quotes source values
 *  in its messages, so a document containing the words "no space left on
 *  device" must not read as a full /tmp (Mr. Singh, 8 Oct 2026: a check
 *  matching on text that can contain user content). The log line below
 *  blanks quotes the same way. */
export const unquoted = (stderr) => String(stderr).replace(/"[^"]*"/g, '"…"');
export const typstSaysNoRoom = (stderr) => TYPST_NO_ROOM.test(unquoted(stderr));

/** The reason for a full /tmp: the job's own need (2 x its pictures) against what /tmp holds at all. */
export function noRoomReason(pictureBytes, capacityBytes) {
  return pictureBytes > 0 && pictureBytes * 2 > capacityBytes ? 'pictures_too_large' : 'no_room';
}

async function tmpCapacity() {
  try { const s = await statfs(tmpdir()); return s.blocks * s.bsize; } catch { return Infinity; }
}

async function noRoom(stage, files) {
  const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
  const capacity = await tmpCapacity();
  return new PdfFailed(noRoomReason(bytes, capacity), { stage, pictures: files.length, bytes, capacity });
}

/**
 * The template's input. Attributes starting with "_" are the service's own
 * (a hand-made client could put one in a stored document), so every one is
 * removed first; then each picture whose stored bytes were supplied gets
 * _pic = a file name chosen HERE. The template trusts nothing else.
 *
 * @param {object} json   renderDoc().json
 * @param {Map<string, Uint8Array>} pictures  stored address -> bytes
 */
export function templateInput(json, pictures = new Map()) {
  const doc = structuredClone(json);
  const files = [];
  const byAddress = new Map();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.attrs && typeof n.attrs === 'object') {
      for (const k of Object.keys(n.attrs)) if (k.startsWith('_')) delete n.attrs[k];
      if (n.type === 'image') {
        const src = typeof n.attrs.src === 'string' ? n.attrs.src : '';
        if (src.startsWith('/api/') && pictures.has(src)) {
          if (!byAddress.has(src)) {
            const bytes = pictures.get(src);
            const kind = sniff(bytes);
            byAddress.set(src, kind ? `pic-${files.length}.${kind}` : null);
            if (kind) files.push({ name: `pic-${files.length}.${kind}`, bytes });
          }
          const name = byAddress.get(src);
          if (name) n.attrs._pic = name;
        }
      }
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  })(doc);
  return { data: { doc }, files };
}

const TEMPLATE = new URL('../pdf/main.typ', import.meta.url);

/**
 * @param {{json: object, text: string, pictures?: Map<string, Uint8Array>, deadline: number,
 *          typst?: string, fontDir?: string, checkedScripts?: Set<string>,
 *          template?: URL, traceTo?: string, root?: string}} job
 *   deadline: Date.now() value past which the build is killed.
 *   template, traceTo, root: THE GATE ONLY (tests/docs-render/pdf-gate.mjs) — a
 *   deliberately unsafe template to show the checks catch one, and an strace
 *   log of every file Typst opens and every connection it tries, and a wider
 *   --root to show the gate would see a read outside the job folder. The API
 *   never sets them.
 * @returns {Promise<{pdf: Buffer, ms: number}>}
 */
export async function buildPdf(job) {
  const typst = job.typst ?? process.env.TYPST_BIN ?? 'typst';
  const fontDir = job.fontDir ?? process.env.PDF_FONT_DIR ?? '/usr/share/fonts';
  const checked = job.checkedScripts ?? CHECKED_SCRIPTS;

  const unchecked = scriptsIn(job.text).filter((s) => !checked.has(s));
  if (unchecked.length) throw new PdfFailed('script_not_checked', { scripts: unchecked });

  const { data, files } = templateInput(job.json, job.pictures);
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'pdf-'));
  } catch (e) {
    if (isNoRoom(e)) throw await noRoom('folder', files);
    throw e;
  }
  const t0 = Date.now();
  try {
    try {
      await copyFile(job.template ?? TEMPLATE, join(dir, 'main.typ'));
      await writeFile(join(dir, 'doc.json'), JSON.stringify(data));
      for (const f of files) await writeFile(join(dir, f.name), f.bytes);
    } catch (e) {
      if (isNoRoom(e)) throw await noRoom('write', files);
      throw e;
    }

    const left = job.deadline - Date.now();
    if (left <= 0) throw new PdfFailed('timeout');
    const { code, stderr, killed } = await new Promise((resolve, reject) => {
      const args = ['compile', '--root', job.root ?? dir, '--font-path', fontDir, '--ignore-system-fonts',
        join(dir, 'main.typ'), join(dir, 'out.pdf')];
      const child = spawn(job.traceTo ? 'strace' : typst, job.traceTo
        ? ['-f', '-qq', '-e', 'trace=open,openat,openat2,connect,socket', '-o', job.traceTo, typst, ...args]
        : args, {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'pipe'],
        // Nothing inherited: no package path or cache Typst could use, no
        // HOME to find one in. The container has no network either.
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: dir,
          XDG_CACHE_HOME: join(dir, 'none'),
          XDG_DATA_HOME: join(dir, 'none'),
          TYPST_PACKAGE_PATH: join(dir, 'none'),
          TYPST_PACKAGE_CACHE_PATH: join(dir, 'none'),
        },
      });
      let err = '';
      child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
      let killedByUs = false;
      const timer = setTimeout(() => { killedByUs = true; child.kill('SIGKILL'); }, left);
      child.on('error', (e) => { clearTimeout(timer); reject(new PdfFailed('typst_missing', { message: String(e.message).slice(0, 120) })); });
      child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, stderr: err, killed: killedByUs }); });
    });
    if (killed) throw new PdfFailed('timeout');
    // Typst's message names the place in main.typ; a value it quotes could be
    // document text, so every quoted string is blanked before it is logged.
    if (code !== 0) {
      if (typstSaysNoRoom(stderr)) throw await noRoom('typst', files);
      const line = stderr.split('\n').find((l) => /error/i.test(l)) ?? `exit ${code}`;
      throw new PdfFailed('typst_failed', { message: unquoted(line).slice(0, 160) });
    }
    return { pdf: await readFile(join(dir, 'out.pdf')), ms: Date.now() - t0, dir }; // dir: gone by now; the gate reads its traces against it
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
