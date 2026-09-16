// Stage 4, second pass. Run from apps/web:
//   node ../../infra/scripts/ui-migration/codemod-unimportant.cjs --dry|--write <files...>
//
// The stage 3 codemod kept every migrated utility `!important` and pinned
// the values both frameworks disagreed on as arbitrary values (`!mb-[1rem]`),
// because Bootstrap's !important rules were still loaded and would have won.
// They are not loaded any more, so this pass:
//   - strips the `!` from every utility (and from inside variants: `md:!flex`);
//   - folds the pinned values back onto Tailwind's scale where a scale step
//     has exactly that value: 0.25rem→1, 0.5rem→2, 0.75rem→3, 1rem→4,
//     1.25rem→5, 1.5rem→6, 3rem→12.
// Font sizes stay arbitrary (`text-[0.75rem]`): Tailwind's text-xs also sets
// a line-height, and these never did.
//
// ─────────────────────────────────────────────────────────────────────────
//  WHERE IT LOOKS, AND WHY THAT IS NARROW.
//
//  Only inside className attributes and class-ish constants — the same
//  contexts the stage 3 codemod used. The first version of this file scanned
//  EVERY string literal in the file, and a backtick inside a comment opened a
//  fake template literal that ran until the next backtick: every `!` in the
//  code between them was "a class". `meeting !== null` became `meeting ==
//  null`, `!over` became `over`, in 35 files, and typecheck caught exactly
//  three of them. Found 16 Sept 2026; the files were reverted from git.
//
//  Two guards on top of the narrow context, because a scanner can still be
//  wrong: a token is only rewritten if it looks like a utility (LOOKS_LIKE),
//  and never if it is in KEEP, the hand-written `!`s that carry a comment.
// ─────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MODE = process.argv[2];
const FILES = process.argv.slice(3);
if (!['--dry', '--write'].includes(MODE) || FILES.length === 0) {
  console.error('usage: node codemod-unimportant.cjs --dry|--write <files...>');
  process.exit(2);
}

const SCALE = { '0.25rem': '1', '0.5rem': '2', '0.75rem': '3', '1rem': '4', '1.25rem': '5', '1.5rem': '6', '3rem': '12' };
const SPACING = /^(m|mt|mb|ms|me|mx|my|p|pt|pb|ps|pe|px|py|gap|space-x|space-y)-\[(0\.25rem|0\.5rem|0\.75rem|1rem|1\.25rem|1\.5rem|3rem)\]$/;
// A utility: lowercase words joined by '-', optionally with an arbitrary
// value in brackets or a fraction. Never a '.', never an operator.
const LOOKS_LIKE = /^[a-z][a-z0-9]*(?:-[a-z0-9\[\]().%/,_:'"#-]+)*$|^\[[a-z-]+:[a-z0-9.%-]+\]$/;

const KEEP = new Set(['group-hover:!opacity-100', 'focus-within:!opacity-100', 'focus-visible:!opacity-100', '[@media(hover:none)]:!opacity-100']);

function convert(tok) {
  if (KEEP.has(tok)) return null;
  let depth = 0; let i = -1;
  for (let k = 0; k < tok.length; k++) {
    if (tok[k] === '[') depth++;
    else if (tok[k] === ']') depth--;
    else if (tok[k] === ':' && depth === 0) i = k;
  }
  const variants = i === -1 ? '' : tok.slice(0, i + 1);
  let util = i === -1 ? tok : tok.slice(i + 1);
  if (!util.startsWith('!')) return null;
  util = util.slice(1);
  if (!LOOKS_LIKE.test(util) || util.includes('..')) return null;
  const m = util.match(SPACING);
  if (m) util = `${m[1]}-${SCALE[m[2]]}`;
  if (util === '[display:grid]') util = 'grid';
  if (util === 'rounded-[50rem]' || util === 'rounded-[50%]') util = 'rounded-full';
  return variants + util;
}

// ---- the string-aware scanning from codemod-utilities, restricted to class contexts ----
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') { j = skipBraces(src, j + 1) - 1; continue; }
    if (src[j] === q) return j + 1;
    if (q !== '`' && src[j] === '\n') return j + 1;
  }
  return src.length;
}
function skipBraces(src, i) {
  let d = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(src, j) - 1; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return j + 1; }
  }
  return src.length;
}
function literalSegments(src, a, b) {
  const segs = [];
  for (let i = a; i < b; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < b && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? b : e + 1; continue; }
    if (c === '"' || c === "'") { const e = skipString(src, i); segs.push([i + 1, e - 1]); i = e - 1; continue; }
    if (c === '`') {
      let s = i + 1; let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          segs.push([s, j]);
          const e = skipBraces(src, j + 1);
          segs.push(...literalSegments(src, j + 2, e - 1));
          j = e - 1; s = e; continue;
        }
        if (src[j] === '`') break;
      }
      segs.push([s, j]); i = j; continue;
    }
  }
  return segs;
}
function classSegments(src) {
  const segs = [];
  let m;
  const attr = /\b[a-zA-Z]*[cC]lass(?:Name)?\s*=\s*/g;
  while ((m = attr.exec(src))) {
    const i = m.index + m[0].length;
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') segs.push(...literalSegments(src, i, skipString(src, i)));
    else if (c === '{') segs.push(...literalSegments(src, i + 1, skipBraces(src, i) - 1));
  }
  const consts = /(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*/g;
  while ((m = consts.exec(src))) {
    if (!/cls|class|btn|base|input|style|tone|badge|chip|variant|pill|ring|field|card|link|size/i.test(m[1])) continue;
    const i = m.index + m[0].length;
    let j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '"' || c === "'" || c === '`') { j = skipString(src, j) - 1; continue; }
      if (c === '{' || c === '(' || c === '[') { j = skipBraces(src.replace(/[([]/g, '{').replace(/[)\]]/g, '}'), j) - 1; continue; }
      if (c === ';' || (c === '\n' && src[j + 1] !== ' ' && src[j + 1] !== '\t')) break;
    }
    segs.push(...literalSegments(src, i, j));
  }
  const seen = new Set();
  return segs.filter(([s, e]) => e > s && !seen.has(`${s}:${e}`) && seen.add(`${s}:${e}`))
    .sort((x, y) => y[0] - x[0]);
}

let total = 0;
for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  let out = src;
  const changes = {};
  for (const [s, e] of classSegments(src)) {
    const text = out.slice(s, e);
    if (!text.includes('!')) continue;
    const next = text.split(/(\s+)/).map((p) => {
      if (!p || /^\s+$/.test(p)) return p;
      const r = convert(p);
      if (r) { changes[`${p} -> ${r}`] = (changes[`${p} -> ${r}`] || 0) + 1; return r; }
      return p;
    }).join('');
    if (next !== text) out = out.slice(0, s) + next + out.slice(e);
  }
  // THE GUARD THAT WOULD HAVE CAUGHT THE FIRST VERSION: with every string
  // literal blanked, the file must be byte-identical before and after.
  const blank = (t) => t.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (q) => ' '.repeat(q.length));
  if (blank(src).replace(/ +/g, ' ') !== blank(out).replace(/ +/g, ' ')) {
    console.error(`REFUSED ${f}: a change landed outside a string literal`);
    process.exit(1);
  }
  const n = Object.values(changes).reduce((a, b) => a + b, 0);
  total += n;
  if (n) console.log(`${path.relative(process.cwd(), f).replace(/\\/g, '/')}: ${n}`);
  if (MODE === '--write' && n) fs.writeFileSync(f, out);
}
console.log(`total rewritten: ${total} (${MODE})`);
