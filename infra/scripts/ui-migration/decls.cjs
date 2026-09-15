// Dump the real declarations behind every legacy and colliding class token.
// Run from apps/web:  node decls.cjs <inventoryDir>
const fs = require('fs');
const path = require('path');

const WEB = process.cwd();
const INV = process.argv[2];

const summary = fs.readFileSync(path.join(INV, 'summary.txt'), 'utf8').split('\n');
const sections = {};
let cur = null;
for (const l of summary) {
  const h = l.match(/^== (.*) ==$/);
  if (h) { cur = h[1]; sections[cur] = []; continue; }
  if (cur && l.includes('\t')) {
    const p = l.split('\t');
    sections[cur].push({ n: Number(p[0]), files: p[1], tok: p[2] });
  }
}

function parse(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const stack = [];
  let buf = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const pre = buf.trim();
      buf = '';
      if (pre.startsWith('@')) { stack.push(pre); continue; }
      const end = css.indexOf('}', i);
      rules.push({
        media: stack.filter((s) => s.startsWith('@media')).join(' '),
        sel: pre,
        decl: css.slice(i + 1, end).trim(),
      });
      i = end;
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else {
      buf += ch;
    }
  }
  return rules;
}

const BACKSLASH = String.fromCharCode(92);
function unesc(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === BACKSLASH && i + 1 < s.length) { out += s[i + 1]; i++; } else out += s[i];
  }
  return out;
}

// A selector that is exactly one class: ".name", where name may contain escapes.
function singleClass(sel) {
  if (!sel.startsWith('.')) return null;
  const body = sel.slice(1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === BACKSLASH) { i++; continue; }
    if (!/[_a-zA-Z0-9-]/.test(c)) return null;
  }
  return unesc(body);
}

function index(rules) {
  const m = new Map();
  for (const r of rules) {
    for (const s of r.sel.split(',')) {
      const k = singleClass(s.trim());
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push((r.media ? r.media + ' ' : '') + r.decl.replace(/\s+/g, ' '));
    }
  }
  return m;
}

const bs = index(parse(fs.readFileSync(path.join(WEB, 'styles/yzen/bootstrap.min.css'), 'utf8')));
const yz = index(parse(fs.readFileSync(path.join(WEB, 'styles/yzen/styles.css'), 'utf8')));

(async () => {
  const req = (m) => require(require.resolve(m, { paths: [WEB] }));
  const tw = req('tailwindcss');
  const loadConfig = req('tailwindcss/loadConfig');
  const twDir = path.dirname(require.resolve('tailwindcss', { paths: [WEB] }));
  const postcss = require(require.resolve('postcss', { paths: [twDir] }));

  const coll = sections['collisions (Tailwind name, Bootstrap/YZEN also defines it)'] || [];
  const cfg = loadConfig(path.join(WEB, 'tailwind.config.ts'));
  cfg.content = [{ raw: coll.map((c) => c.tok).join(' '), extension: 'html' }];
  const out = await postcss([tw(cfg)]).process('@tailwind utilities;', { from: undefined });
  const twi = index(parse(out.css));

  const lines = [];
  const show = (title, list, withTw) => {
    lines.push('', `==== ${title} ====`);
    for (const { n, files, tok } of list) {
      lines.push(`-- ${tok}  (${n}x, ${files})`);
      (bs.get(tok) || []).forEach((d) => lines.push(`   BS: ${d}`));
      (yz.get(tok) || []).slice(0, 4).forEach((d) => lines.push(`   YZ: ${d}`));
      if (withTw) (twi.get(tok) || []).forEach((d) => lines.push(`   TW: ${d}`));
    }
  };
  show('bootstrap-only', sections['bootstrap-only tokens'] || [], false);
  show('yzen-only', sections['yzen-only tokens'] || [], false);
  show('collisions', coll, true);
  fs.writeFileSync(path.join(INV, 'decls.txt'), lines.join('\n'));
  console.log('collisions:', coll.length, '; decls.txt lines:', lines.length);
})().catch((e) => { console.error(e); process.exit(1); });
