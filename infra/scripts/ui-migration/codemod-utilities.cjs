// Stage 3 codemod, utilities only. Run from apps/web:
//   node codemod-utilities.cjs --dry|--write <file> [<file> ...]
//
// Rewrites Bootstrap/YZEN UTILITY classes, inside className attributes and
// class-constant strings, into the Tailwind class that renders the SAME value.
// Every Bootstrap utility is declared !important and YZEN's stylesheet loads
// after Tailwind, so each replacement carries Tailwind's `!` to keep the
// cascade identical while YZEN is still loaded. Stage 4 (delete YZEN) strips
// the `!` and folds arbitrary values back onto the scale mechanically.
//
// Components (btn, form-*, card, badge, alert, nav, row/col ...) are NOT
// touched: they need a person, and they are reported as residue.
const fs = require('fs');
const path = require('path');

const MODE = process.argv[2];
const FILES = process.argv.slice(3);
if (!['--dry', '--write'].includes(MODE) || FILES.length === 0) {
  console.error('usage: node codemod-utilities.cjs --dry|--write <files...>');
  process.exit(2);
}

// token -> replacement (space-separated classes, each gets `!`)
const MAP = {
  'd-flex': 'flex', 'd-block': 'block', 'd-inline-block': 'inline-block',
  'd-inline-flex': 'inline-flex', 'd-none': 'hidden',
  // `grid` would pick up YZEN's .grid gap (1.5rem); Bootstrap's d-grid has none.
  'd-grid': '[display:grid]',
  'd-md-block': 'md:block', 'd-lg-flex': 'min-[992px]:flex',
  'd-lg-none': 'min-[992px]:hidden', 'd-lg-block': 'min-[992px]:block',
  'align-items-center': 'items-center', 'align-items-start': 'items-start',
  'align-items-end': 'items-end', 'align-items-baseline': 'items-baseline',
  'align-self-start': 'self-start',
  'justify-content-between': 'justify-between', 'justify-content-center': 'justify-center',
  'justify-content-end': 'justify-end',
  'flex-column': 'flex-col', 'flex-sm-row': 'min-[576px]:flex-row', 'flex-md-row': 'md:flex-row',
  'flex-fill': 'flex-auto', 'flex-grow-1': 'grow',
  'fw-semibold': 'font-semibold', 'fw-medium': 'font-medium', 'fw-normal': 'font-normal',
  'fw-bold': 'font-bold',
  'text-muted': 'text-ink-muted', 'text-truncate': 'truncate',
  'text-decoration-none': 'no-underline', 'text-uppercase': 'uppercase',
  'text-capitalize': 'capitalize', 'text-warning': 'text-warn', 'text-primary': 'text-brand-500',
  'rounded-circle': 'rounded-[50%]', 'rounded-pill': 'rounded-[50rem]', // Bootstrap's pill is 50rem, not 9999px — measured
  'position-absolute': 'absolute', 'position-relative': 'relative',
  'position-sticky': 'sticky', 'position-fixed': 'fixed',
  'w-100': 'w-full', 'h-100': 'h-full',
  'font-monospace': 'font-mono', 'list-unstyled': 'list-none pl-0',
  'visually-hidden': 'sr-only', 'user-select-none': 'select-none',
  'bg-success': 'bg-ok', 'bg-warning': 'bg-warn', 'border-success': 'border-ok',
  'px-md-4': 'md:px-[1.5rem]', 'p-sm-5': 'min-[576px]:p-[3rem]',
  'ms-sm-auto': 'min-[576px]:ms-auto', 'mx-lg-0': 'min-[992px]:mx-0',
  // YZEN
  'fs-11': 'text-[0.6875rem]', 'fs-12': 'text-[0.75rem]', 'fs-13': 'text-[0.8125rem]',
  'fs-14': 'text-[0.875rem]', 'fs-18': 'text-[1.125rem]', 'fs-20': 'text-[1.25rem]',
  'fs-24': 'text-[1.5rem]',
  'bg-success-transparent': 'bg-ok/10 text-ok', 'bg-warning-transparent': 'bg-warn/10 text-warn',
  'bg-danger-transparent': 'bg-danger/10 text-danger',
  'bg-primary-transparent': 'bg-brand-500/10 text-brand-500',
};

// Same name in both frameworks, different value: keep the value that renders today.
const SCALE = { 3: '1rem', 4: '1.5rem', 5: '3rem' };
function spacing(tok) {
  const m = tok.match(/^(m|mt|mb|ms|me|mx|my|p|pt|pb|ps|pe|px|py|gap)-([345])$/);
  return m ? `${m[1]}-[${SCALE[m[2]]}]` : null;
}

// Classes that still mark legacy markup after this pass (reported, not changed).
const RESIDUE = /^(btn|btn-.+|badge|card|card-.+|custom-card|alert|alert-.+|form-.+|input-group.*|nav|nav-.+|breadcrumb.*|progress.*|dropdown-.+|table-.+|spinner-border.*|row|col|col-.+|g-[0-5]|gx-.+|gy-.+|container-fluid|bg-light|bg-secondary-transparent|border-(bottom|top)|text-body.*|text-dark|text-warning-emphasis|avatar.*|header-.+|page-header-breadcrumb|side-menu.*|main-.+|app-.+|slide.*|btn-icon|active)$/;

function convert(tok) {
  if (tok.startsWith('!')) return null;
  const rep = MAP[tok] || spacing(tok);
  if (!rep) return null;
  return rep.split(' ').map((c) => {
    // The variant separator is the last ':' OUTSIDE brackets. `[display:grid]`
    // has a colon inside its brackets; putting `!` after it produced
    // `[display:!grid]`, which is not a class Tailwind generates.
    let depth = 0; let i = -1;
    for (let k = 0; k < c.length; k++) {
      if (c[k] === '[') depth++;
      else if (c[k] === ']') depth--;
      else if (c[k] === ':' && depth === 0) i = k;
    }
    return i === -1 ? `!${c}` : `${c.slice(0, i + 1)}!${c.slice(i + 1)}`;
  }).join(' ');
}

// ---- string-aware scanning ----
function skipString(src, i) { // src[i] is a quote; returns index after closing quote
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') { j = skipBraces(src, j + 1) - 1; continue; }
    if (src[j] === q) return j + 1;
    if (q !== '`' && src[j] === '\n') return j + 1;
  }
  return src.length;
}
function skipBraces(src, i) { // src[i] === '{'; returns index after matching '}'
  let d = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(src, j) - 1; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return j + 1; }
  }
  return src.length;
}
// Static text segments [start,end) of every string literal in src[a,b)
function literalSegments(src, a, b) {
  const segs = [];
  for (let i = a; i < b; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < b && src[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") { const e = skipString(src, i); segs.push([i + 1, e - 1]); i = e - 1; continue; }
    if (c === '`') {
      let s = i + 1; let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          segs.push([s, j]);
          const e = skipBraces(src, j + 1);
          // nested literals inside ${ } are class strings too (ternaries)
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
    if (!/cls|class|btn|base|input|style|tone|badge|chip|variant|pill|ring|field|card/i.test(m[1])) continue;
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
  // de-duplicate overlapping segments
  const seen = new Set();
  return segs.filter(([s, e]) => e > s && !seen.has(`${s}:${e}`) && seen.add(`${s}:${e}`))
    .sort((x, y) => y[0] - x[0]);
}

let total = 0;
for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  const segs = classSegments(src);
  let out = src;
  const changes = {};
  const residue = {};
  const done = new Set();
  for (const [s, e] of segs) {
    if ([...done].some(([ds, de]) => s >= ds && e <= de && !(s === ds && e === de))) { /* nested handled */ }
    const text = out.slice(s, e);
    const parts = text.split(/(\s+)/);
    let changed = false;
    const next = parts.map((p) => {
      if (!p || /^\s+$/.test(p)) return p;
      const r = convert(p);
      if (r) { changes[p] = (changes[p] || 0) + 1; changed = true; return r; }
      if (RESIDUE.test(p)) residue[p] = (residue[p] || 0) + 1;
      return p;
    }).join('');
    if (changed) out = out.slice(0, s) + next + out.slice(e);
    done.add([s, e]);
  }
  const n = Object.values(changes).reduce((a, b) => a + b, 0);
  total += n;
  console.log(`\n${path.relative(process.cwd(), f).replace(/\\/g, '/')}: ${n} rewritten`);
  console.log('  changed: ' + Object.entries(changes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' '));
  console.log('  residue: ' + (Object.entries(residue).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ') || 'none'));
  if (MODE === '--write' && n) fs.writeFileSync(f, out);
}
console.log(`\ntotal rewritten: ${total} (${MODE})`);
