// ============================================================================
//  The pair rule, as a check that refuses
// ============================================================================
//
//  `allow-scripts` and `allow-same-origin` on one iframe sandbox are each
//  survivable alone and catastrophic together: hostile markup that survives
//  sanitising then runs as code WITH OUR ORIGIN — our cookies, our tokens,
//  our storage. In a mail client that is a stored cross-site-scripting
//  machine in every inbox, fed by anyone who knows a customer's address.
//
//  This is written down in SafeHtml.tsx. A rule in prose is worth less than a
//  check that refuses, so this runs as `prebuild` — before every `next build`,
//  which push.cmd runs before every commit. The check fires at the moment
//  somebody would introduce the bug, not at review, and not never.
//
//  It scans EVERY sandbox attribute in the app rather than one file, because
//  the second iframe someone adds is the one nobody remembers to check.
// ============================================================================

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, NOT url.pathname. On Windows `pathname` yields
// "/C:/Users/..." with a leading slash, which join() then turns into
// "C:\C:\Users\..." and the scan dies with ENOENT. It looks correct on
// Linux, where the two happen to agree — which is exactly why this broke on
// the machine that runs the build and not on the one that wrote the check.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.next', 'dist', 'build', '.turbo']);

/** Every sandbox="..." in the file, with the line it sits on. */
const SANDBOX = /sandbox\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

async function* sources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name) && !full.endsWith('check-sandbox.mjs')) {
      yield full;
    }
  }
}

const offences = [];

for await (const file of sources(ROOT)) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(SANDBOX)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const tokens = value.split(/\s+/).filter(Boolean);
    if (tokens.includes('allow-scripts') && tokens.includes('allow-same-origin')) {
      // Line number, so the message points at the code and not at a file.
      const line = text.slice(0, match.index).split('\n').length;
      offences.push({ file: relative(ROOT, file), line, value });
    }
  }
}

if (offences.length > 0) {
  console.error('\n  BUILD REFUSED — iframe sandbox grants allow-scripts AND allow-same-origin.\n');
  for (const o of offences) {
    console.error(`    ${o.file}:${o.line}`);
    console.error(`      sandbox="${o.value}"\n`);
  }
  console.error('  Together these let markup that survives sanitising run as code with our');
  console.error('  origin — our cookies, our tokens, our storage. In a mail client that is');
  console.error('  stored XSS in every inbox.\n');
  console.error('  Drop allow-scripts. Email HTML never needs to execute anything.');
  console.error('  The reasoning is in the header of components/mail/SafeHtml.tsx.\n');
  process.exit(1);
}

console.log(`  sandbox check: ok`);
