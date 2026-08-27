#!/usr/bin/env node
// ============================================================================
//  A two-second answer to "will the server build reject this?"
//
//  WHY THIS EXISTS.
//
//  Every deploy failure this module has had was a SYNTAX or LINT failure, not
//  a logic one, and every one of them was found by the production build after
//  the push — which means eight minutes of waiting and a red deploy to learn
//  something the file could have said immediately:
//
//    • 22 Aug — two backticks inside a CSS template literal. Blocked every
//      deploy on the platform, not just Connect's. The compiler said
//      "Expected a semicolon" and pointed at a word in prose.
//    • 23 Aug — three hooks called after an early return. Three identical
//      react-hooks/rules-of-hooks errors, all in one file.
//    • 22 Aug — a commit that shipped a stale index while the build compiled
//      the working tree, so the thing that was tested was not the thing that
//      shipped. push.cmd now guards that one.
//
//  This does NOT replace the build. It cannot type-check: node_modules may not
//  be present and half the imports are aliases. What it does is parse every
//  file and run the four rules that have actually broken us, in about a second,
//  before anything leaves the machine.
//
//  A clean run here does not promise a green deploy. A dirty run promises a
//  red one, which is the half worth having early.
//
//  USAGE
//      node infra/scripts/web-syntax-check.js [path ...]
//  With no arguments it checks apps/web. Exit code 1 if anything failed.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// The compiler is a devDependency of apps/web. Look for it there first, then
// fall back to a global install so this runs on a machine that has not yet
// installed the workspace.
function loadTypeScript() {
  const tries = [
    path.join(process.cwd(), 'apps', 'web', 'node_modules', 'typescript'),
    path.join(process.cwd(), 'node_modules', 'typescript'),
    'typescript',
  ];
  for (const t of tries) {
    try { return require(t); } catch { /* next */ }
  }

  // pnpm puts the real package under node_modules/.pnpm/<name>@<version>/ and
  // leaves a SYMLINK at node_modules/typescript. Every path above goes through
  // that symlink, and there are environments where it cannot be followed —
  // a Windows checkout read through a Linux mount answers EIO on it, which
  // surfaces as MODULE_NOT_FOUND and looks exactly like "not installed".
  //
  // So: look for the real directory. Version is not pinned here on purpose —
  // this only has to find A compiler, and whichever one the workspace already
  // installed is the right one.
  try {
    const store = path.join(process.cwd(), 'node_modules', '.pnpm');
    const hit = fs.readdirSync(store)
      .filter((d) => /^typescript@/.test(d))
      .sort()
      .pop();
    if (hit) {
      return require(path.join(store, hit, 'node_modules', 'typescript'));
    }
  } catch { /* no pnpm store either */ }

  return null;
}

const ts = loadTypeScript();
if (!ts) {
  console.error('web-syntax-check: cannot find the typescript package.');
  console.error('  Run  npm install  in apps/web, or  npm i -g typescript.');
  process.exit(2);
}

// ── Collecting files ────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function collect(targets) {
  const out = [];
  for (const t of targets) {
    let st;
    try { st = fs.statSync(t); } catch {
      console.error(`web-syntax-check: no such path — ${t}`);
      process.exit(2);
    }
    if (st.isDirectory()) walk(t, out);
    else out.push(t);
  }
  return out.sort();
}

// ── Reporting ───────────────────────────────────────────────────────────────

const problems = [];

function report(file, line, col, rule, message, hint) {
  problems.push({ file, line, col, rule, message, hint });
}

function lineOf(source, pos) {
  const upTo = source.slice(0, pos);
  const line = upTo.split('\n').length;
  const col = pos - (upTo.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

// ── Rule 1: it must parse ───────────────────────────────────────────────────
//
//  Syntactic diagnostics only. A missing import or an unknown type is not a
//  syntax error and this check has no way to resolve either, so asking about
//  them would only produce noise nobody reads.

function checkParses(file, source, sourceFile) {
  // parseDiagnostics is internal but stable, and it is the only way to get
  // syntax errors without a full Program (which needs every dependency).
  const diags = sourceFile.parseDiagnostics || [];
  for (const d of diags) {
    const { line, col } = lineOf(source, d.start || 0);
    report(
      file, line, col, 'parse',
      ts.flattenDiagnosticMessageText(d.messageText, ' '),
      'The production build will fail here with the same message.',
    );
  }
  return diags.length === 0;
}

// ── Rule 2: a stylesheet must not be truncated ──────────────────────────────
//
//  A stray backtick inside a CSS template literal ENDS it, and the CSS after
//  it becomes JavaScript. Usually that is a parse error and rule 1 has already
//  said so — that is exactly what happened on 22 August, where the compiler
//  reported "Expected a semicolon" and pointed at a word in prose.
//
//  The case rule 1 cannot see is the one worth a second rule: an EVEN number
//  of stray backticks, where the text between them happens to parse. Then the
//  file compiles, the deploy is green, and the stylesheet is silently missing
//  everything after the first stray tick. A broken build is a nuisance; a
//  green deploy with half a stylesheet is a bug hunt.
//
//  What is checkable without understanding CSS: a stylesheet that has been cut
//  in half has unbalanced braces. Every rule in it opens and closes, so the
//  counts match in any complete stylesheet and diverge in a truncated one.
//  Verified against all three of Connect's stylesheets — 270, 190 and 40 pairs
//  respectively, every one balanced.
//
//  Counting the file's backticks instead does NOT work: these files also hold
//  ordinary short literals, so the total is legitimately more than two.

const CSS_MIN = 400;

function looksLikeStylesheet(text) {
  return text.length > CSS_MIN && /:\s*[^;{]+;/.test(text) && /[{;]\s*\n/.test(text);
}

function checkCssTruncation(file, source, sourceFile) {
  const visit = (node) => {
    if (ts.isNoSubstitutionTemplateLiteral(node) && looksLikeStylesheet(node.text)) {
      const open = (node.text.match(/{/g) || []).length;
      const close = (node.text.match(/}/g) || []).length;
      if (open !== close) {
        const { line, col } = lineOf(source, node.getStart(sourceFile));
        report(
          file, line, col, 'css-truncated',
          `Stylesheet has ${open} '{' and ${close} '}'. A complete stylesheet balances.`,
          'The usual cause is a backtick inside the CSS — even in a '
          + '/* comment */ — which ends the string early. Use "double quotes" '
          + 'for emphasis in there.',
        );
      }
    }
    // ── A RULE THAT WAS HERE AND IS NOT. ──────────────────────────────
    //
    //  There was a second check: flag any stylesheet-looking literal that
    //  uses ${...} interpolation, on the theory that Connect's stylesheets
    //  are static so a ${ in one is an accident.
    //
    //  Run across the whole web app it found ONE thing, and that thing was
    //  fine: components/mail/SafeHtml.tsx builds an iframe srcDoc — a whole
    //  HTML document with a <style> block in it and a CSP interpolated into
    //  the head. Correct code, flagged as a problem, on the first real run.
    //
    //  So it is gone rather than excepted. One false positive and no true
    //  ones is not a rule, and the note at the top of rule 3 applies just as
    //  hard here: a check that cries wolf is a check people stop running,
    //  which costs more than the rule could ever have saved.
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

// ── Rule 3: no hook after an early return ───────────────────────────────────
//
//  react-hooks/rules-of-hooks is an ERROR in this repo, and on 23 August it
//  produced three of them in one file: a useRef, a useState and a useEffect
//  that had drifted below a `if (!room) return ...`.
//
//  This is deliberately the narrow version of that rule — a return statement
//  directly in a component's own body, followed later in the same body by a
//  hook call. It does not chase hooks into nested blocks or callbacks, because
//  a false positive here costs more than a miss: nobody keeps running a check
//  that cries wolf.

const HOOK = /^use[A-Z]/;

function isComponentish(name) {
  return typeof name === 'string' && (/^[A-Z]/.test(name) || HOOK.test(name));
}

function checkHookOrder(file, source, sourceFile) {
  const bodies = [];

  const collectBody = (node) => {
    let name = null;
    if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
    else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)
             && node.initializer
             && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      name = node.name.text;
    }
    if (name && isComponentish(name)) {
      const fn = ts.isFunctionDeclaration(node) ? node : node.initializer;
      if (fn && fn.body && ts.isBlock(fn.body)) bodies.push({ name, body: fn.body });
    }
    ts.forEachChild(node, collectBody);
  };
  ts.forEachChild(sourceFile, collectBody);

  for (const { name, body } of bodies) {
    let returnAt = -1;
    for (const stmt of body.statements) {
      if (returnAt === -1 && (ts.isReturnStatement(stmt)
          || (ts.isIfStatement(stmt) && containsReturn(stmt) && !stmt.elseStatement))) {
        // An `if (x) return null;` is the shape that bites. A plain `return`
        // at the end of the body is not an early return at all, so only count
        // it when statements follow.
        if (stmt !== body.statements[body.statements.length - 1]) {
          returnAt = stmt.getStart(sourceFile);
        }
        continue;
      }
      if (returnAt !== -1) {
        const hook = firstHookCall(stmt, sourceFile);
        if (hook) {
          const { line, col } = lineOf(source, hook.pos);
          const early = lineOf(source, returnAt);
          report(
            file, line, col, 'hook-order',
            `${hook.name} is called in ${name} after the early return on line ${early.line}.`,
            'Move every hook above every return. The build fails this as an '
            + 'error, not a warning.',
          );
          break;
        }
      }
    }
  }
}

function containsReturn(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isReturnStatement(n)) { found = true; return; }
    // Do not follow into a nested function — its return is its own.
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function firstHookCall(node, sourceFile) {
  let hit = null;
  const visit = (n) => {
    if (hit) return;
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && HOOK.test(n.expression.text)) {
      hit = { name: n.expression.text, pos: n.expression.getStart(sourceFile) };
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

// ── Rule 4: an import nothing uses ──────────────────────────────────────────
//
//  no-unused-vars is an error in this repo, and an unused IMPORT is the way it
//  is usually earned: a component is pulled in while a screen is being built,
//  the design changes, the import stays. It is invisible to reading and fatal
//  to the build.
//
//  Imports only, not every variable. A whole unused-variable rule needs scope
//  analysis and would produce false positives on destructuring, which is the
//  fastest way to make a check nobody runs. An import has exactly one name and
//  one question: does that name appear anywhere else in the file?
//
//  Counted over identifiers from the AST rather than by searching the text, so
//  a name that appears only inside a string or a comment does not count as a
//  use — that being the exact case a text search gets wrong.

function checkUnusedImports(file, source, sourceFile) {
  const imported = new Map();   // local name -> position

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    // `import './styles.css'` and `import type ... ` both matter differently:
    // a side-effect import has no clause at all and is skipped above.
    if (clause.name) imported.set(clause.name.text, clause.name.getStart(sourceFile));
    const b = clause.namedBindings;
    if (b && ts.isNamespaceImport(b)) imported.set(b.name.text, b.name.getStart(sourceFile));
    if (b && ts.isNamedImports(b)) {
      for (const el of b.elements) {
        imported.set(el.name.text, el.name.getStart(sourceFile));
      }
    }
  }
  if (imported.size === 0) return;

  const used = new Set();
  const visit = (node) => {
    // Skip the import statements themselves — an import is not a use of
    // itself, which is the entire question being asked.
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) used.add(node.text);
    // A JSX tag name is an identifier in the AST, so <Button /> counts. A
    // property NAME is too, and should not: `{ Button: 1 }` does not use the
    // import. Property assignment names are the one place to skip.
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      ts.forEachChild(node.initializer, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  for (const [name, pos] of imported) {
    if (used.has(name)) continue;
    const { line, col } = lineOf(source, pos);
    report(
      file, line, col, 'unused-import',
      `'${name}' is imported and never used.`,
      'no-unused-vars is an error in this repo — the build will reject it.',
    );
  }
}

// ── Rule 5: dangerouslySetInnerHTML ─────────────────────────────────────────
//
//  react/no-danger is an error everywhere in this repo except one file, which
//  exists precisely to be the one place that sanitises and renders mail HTML.

const DANGER_ALLOWED = new Set([
  path.normalize('apps/web/components/mail/SafeHtml.tsx'),
]);

function checkNoDanger(file, source, sourceFile) {
  const rel = path.normalize(path.relative(process.cwd(), file));
  if (DANGER_ALLOWED.has(rel)) return;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'dangerouslySetInnerHTML') {
      const { line, col } = lineOf(source, node.getStart(sourceFile));
      report(
        file, line, col, 'no-danger',
        'dangerouslySetInnerHTML is an eslint ERROR outside components/mail/SafeHtml.tsx.',
        'For a stylesheet, pass the CSS as a plain child: <style>{CSS}</style>.',
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

// ── Run ─────────────────────────────────────────────────────────────────────

const targets = process.argv.slice(2);
const files = collect(targets.length ? targets : ['apps/web']);

if (files.length === 0) {
  console.error('web-syntax-check: nothing to check.');
  process.exit(2);
}

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file, source, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : undefined,
  );

  // If it does not parse, every other rule is reading rubble. Say the one
  // useful thing and move on.
  if (!checkParses(file, source, sourceFile)) continue;

  checkCssTruncation(file, source, sourceFile);
  checkHookOrder(file, source, sourceFile);
  checkUnusedImports(file, source, sourceFile);
  checkNoDanger(file, source, sourceFile);
}

const width = String(files.length).length;
if (problems.length === 0) {
  console.log(`web-syntax-check: ${String(files.length).padStart(width)} files, clean.`);
  console.log('  (Parse and four house rules only — this is not the build.)');
  process.exit(0);
}

console.log('');
for (const p of problems) {
  const where = `${path.relative(process.cwd(), p.file)}:${p.line}:${p.col}`;
  console.log(`  ${where}`);
  console.log(`    [${p.rule}] ${p.message}`);
  if (p.hint) console.log(`    ${p.hint}`);
  console.log('');
}
console.log(`web-syntax-check: ${problems.length} problem(s) in ${files.length} files.`);
// Three of the four rules are build failures. css-truncated is not — it
// COMPILES, and ships a stylesheet cut in half, which is why it is worth
// saying separately rather than lumping it in with "the build will fail".
if (problems.some((p) => p.rule === 'css-truncated')) {
  console.log('A css-truncated stylesheet still compiles. It deploys green and');
  console.log('half the styles are missing — fix it before anything else here.');
}
console.log('Fix these before pushing.');
process.exit(1);
