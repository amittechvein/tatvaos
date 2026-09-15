// Every class token ADDED by the working-tree diff must make Tailwind emit a
// rule. A class Tailwind does not recognise is silently dropped: the markup
// looks migrated and the element loses its style. Run from apps/web.
const { execSync } = require('child_process');
const path = require('path');

const WEB = process.cwd();
const diff = execSync('git diff -U0 -- .', { cwd: WEB, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const added = new Set();
for (const line of diff.split('\n')) {
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  for (const t of line.split(/[\s'"`{}()]+/)) {
    // only tokens this migration introduces: `!`-prefixed utilities, anywhere after a variant
    // `!flex`, `md:!block`, `min-[992px]:!hidden`, `![display:grid]`, `!gap-[1rem]`
    if (/^(?:(?:[a-z]+|min-\[[0-9]+px\]):)?![a-z[]/.test(t)) {
      added.add(t.replace(/[,;>]+$/, ''));
    }
  }
}

(async () => {
  const req = (m) => require(require.resolve(m, { paths: [WEB] }));
  const tailwind = req('tailwindcss');
  const loadConfig = req('tailwindcss/loadConfig');
  const twDir = path.dirname(require.resolve('tailwindcss', { paths: [WEB] }));
  const postcss = require(require.resolve('postcss', { paths: [twDir] }));
  const cfg = loadConfig(path.join(WEB, 'tailwind.config.ts'));

  const missing = [];
  for (const tok of added) {
    cfg.content = [{ raw: ` ${tok} `, extension: 'html' }];
    const out = await postcss([tailwind(cfg)]).process('@tailwind utilities;', { from: undefined });
    const css = out.css.trim();
    if (!css || !css.includes('!important')) missing.push(tok);
  }
  console.log(`added important tokens: ${added.size}; generating no !important rule: ${missing.length}`);
  if (missing.length) console.log(missing.join('\n'));
  process.exit(missing.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
