// Class inventory for apps/web: which class tokens are Tailwind, which are
// Bootstrap/YZEN, which collide. Run from apps/web:  node <this> [outDir]
const fs = require('fs');
const path = require('path');

const WEB = process.cwd();
const OUT = process.argv[2] || path.join(__dirname, 'inventory');
fs.mkdirSync(OUT, { recursive: true });

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// ---- 1. tokens per file, from className contexts and class-ish constants ----
function stringsIn(expr) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(expr))) {
    let s = m[1] ?? m[2] ?? m[3] ?? '';
    if (m[3] !== undefined) s = s.replace(/\$\{[^}]*\}/g, ' ');
    out.push(s);
  }
  return out;
}
function balanced(src, i) { // src[i] === '{'
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i + 1, j); }
  }
  return '';
}
const TOKEN = /^!?-?[a-z][a-z0-9]*(?:[-:/.][a-z0-9[\]().%#_,'"=&>+~*@-]*)*$|^!?-?[a-z0-9:-]*\[[^\s]+\][a-z0-9/-]*$/i;

function tokensOf(src) {
  const found = [];
  const push = (s) => s.split(/\s+/).forEach((t) => { if (t && TOKEN.test(t)) found.push(t); });
  let m;
  const attr = /className\s*=\s*/g;
  while ((m = attr.exec(src))) {
    const i = m.index + m[0].length;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i]; const j = src.indexOf(q, i + 1);
      push(src.slice(i + 1, j));
    } else if (src[i] === '{') {
      stringsIn(balanced(src, i)).forEach(push);
    }
  }
  const consts = /(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*/g;
  while ((m = consts.exec(src))) {
    if (!/cls|class|btn|base|input|style|tone|badge|chip|variant|pill|ring|field|card/i.test(m[1])) continue;
    const i = m.index + m[0].length;
    const end = src.indexOf(';', i);
    stringsIn(src.slice(i, end === -1 ? i + 2000 : end)).forEach(push);
  }
  return found;
}

const files = [...walk(path.join(WEB, 'app')), ...walk(path.join(WEB, 'components'))];
const perFile = {};
const all = new Set();
for (const f of files) {
  const toks = tokensOf(fs.readFileSync(f, 'utf8'));
  if (!toks.length) continue;
  const rel = path.relative(WEB, f).replace(/\\/g, '/');
  perFile[rel] = toks;
  toks.forEach((t) => all.add(t));
}

// ---- 2. what the YZEN stylesheets define ----
function cssClasses(file) {
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const set = new Set();
  // selectors are the text before each '{'
  const sel = /([^{}]+)\{/g;
  let m;
  while ((m = sel.exec(css))) {
    if (m[1].trim().startsWith('@')) continue;
    const re = /\.((?:\\.|[_a-zA-Z0-9-])+)/g;
    let c;
    while ((c = re.exec(m[1]))) set.add(c[1].replace(/\\(.)/g, '$1'));
  }
  return set;
}
const bs = cssClasses(path.join(WEB, 'styles/yzen/bootstrap.min.css'));
const yz = cssClasses(path.join(WEB, 'styles/yzen/styles.css'));

// ---- 3. what Tailwind generates for exactly these tokens ----
async function tailwindSet(tokens) {
  const req = (m) => require(require.resolve(m, { paths: [WEB] }));
  const tailwind = req('tailwindcss');
  const loadConfig = req('tailwindcss/loadConfig');
  const postcss = require(require.resolve('postcss', { paths: [path.dirname(require.resolve('tailwindcss', { paths: [WEB] }))] }));
  const cfg = loadConfig(path.join(WEB, 'tailwind.config.ts'));
  cfg.content = [{ raw: [...tokens].join(' '), extension: 'html' }];
  const res = await postcss([tailwind(cfg)]).process('@tailwind components;@tailwind utilities;', { from: undefined });
  const gen = new Set();
  const re = /\.((?:\\.|[_a-zA-Z0-9-])+)/g;
  let c;
  const sels = res.css.replace(/\{[^{}]*\}/g, '{}');
  while ((c = re.exec(sels))) gen.add(c[1].replace(/\\(.)/g, '$1'));
  return gen;
}

(async () => {
  const tw = await tailwindSet(all);
  const icon = (t) => /^(ti|ri|bi|fa|fe|bx|las|la|mdi)(-|$)/.test(t);
  const base = (t) => t.replace(/^!/, '').split(':').pop(); // variants apply to the last segment for BS lookup
  const kind = (t) => {
    if (icon(t)) return 'icon';
    const inTw = tw.has(t) || tw.has(t.replace(/^!/, ''));
    const b = base(t);
    const inBs = !t.includes(':') && (bs.has(b) || yz.has(b));
    if (inTw && inBs) return 'both';
    if (inTw) return 'tw';
    if (inBs) return bs.has(b) ? 'bootstrap' : 'yzen';
    return 'unknown';
  };
  const freq = {};
  const fileSummary = [];
  for (const [f, toks] of Object.entries(perFile)) {
    const c = { bootstrap: 0, yzen: 0, both: 0, tw: 0, icon: 0, unknown: 0 };
    const legacy = {};
    for (const t of toks) {
      const k = kind(t); c[k]++;
      freq[t] = freq[t] || { kind: k, n: 0, files: new Set() };
      freq[t].n++; freq[t].files.add(f);
      if (k === 'bootstrap' || k === 'yzen') legacy[t] = (legacy[t] || 0) + 1;
    }
    fileSummary.push({ file: f, ...c, legacy });
  }
  fileSummary.sort((a, b) => (b.bootstrap + b.yzen) - (a.bootstrap + a.yzen));
  const byKind = (k) => Object.entries(freq).filter(([, v]) => v.kind === k)
    .sort((a, b) => b[1].n - a[1].n).map(([t, v]) => `${v.n}\t${v.files.size}f\t${t}`);

  const lines = [];
  lines.push(`files scanned: ${files.length}; files with classes: ${Object.keys(perFile).length}; distinct tokens: ${all.size}`);
  const legacyFiles = fileSummary.filter((s) => s.bootstrap + s.yzen > 0);
  lines.push(`files still using Bootstrap/YZEN-only classes: ${legacyFiles.length}`);
  lines.push('', '== per file: bootstrap-only + yzen-only (both = name collisions) ==');
  for (const s of legacyFiles) lines.push(`${s.bootstrap + s.yzen}\tbs=${s.bootstrap} yz=${s.yzen} both=${s.both}\t${s.file}`);
  lines.push('', '== bootstrap-only tokens ==', ...byKind('bootstrap'));
  lines.push('', '== yzen-only tokens ==', ...byKind('yzen'));
  lines.push('', '== collisions (Tailwind name, Bootstrap/YZEN also defines it) ==', ...byKind('both'));
  lines.push('', '== unknown (neither generates it) ==', ...byKind('unknown').slice(0, 120));
  fs.writeFileSync(path.join(OUT, 'summary.txt'), lines.join('\n'));
  fs.writeFileSync(path.join(OUT, 'files.json'), JSON.stringify(fileSummary, null, 1));
  console.log(lines.slice(0, 3).join('\n'));
  console.log(`written to ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
