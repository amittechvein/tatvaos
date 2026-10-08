#!/usr/bin/env node
// Fails (exit 1) if the TatvaOS School app and the Connect app (apps/mobile) are connected in
// any way this can see:
//   - an import or require in one app that reaches into the other (including relative paths
//     such as ../../mobile/...), or names the other app's package;
//   - one app's package.json depending on the other;
//   - both apps sharing an app ID, Expo slug or URL scheme.
// Runs in CI (.github/workflows/school-app-separation.yml) and by hand:
//   node apps/school/scripts/check-app-separation.js
// No dependencies; reads files only.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../..");
const APPS = {
  school: { dir: path.join(ROOT, "apps/school"), pkg: "tatvaos-school" },
  mobile: { dir: path.join(ROOT, "apps/mobile"), pkg: "tatvaos-mobile" },
};
const SKIP = new Set(["node_modules", "android", "ios", ".expo", "build", "dist", "coverage"]);
const CODE = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const problems = [];

function* files(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (CODE.test(e.name)) yield p;
  }
}

const SPEC = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*|import\s+)['"]([^'"]+)['"]/g;
const inside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

for (const [name, app] of Object.entries(APPS)) {
  const [otherName, other] = Object.entries(APPS).find(([n]) => n !== name);
  for (const file of files(app.dir)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1];
      const where = `${path.relative(ROOT, file)}: '${spec}'`;
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        if (inside(target, other.dir)) problems.push(`${name} imports from ${otherName}: ${where}`);
      } else if (spec === other.pkg || spec.startsWith(other.pkg + "/") || /(^|\/)apps\/(mobile|school)(\/|$)/.test(spec)) {
        if (spec.includes(`apps/${name}`)) continue;
        problems.push(`${name} names ${otherName}: ${where}`);
      }
    }
  }
  const pj = path.join(app.dir, "package.json");
  if (fs.existsSync(pj)) {
    const p = JSON.parse(fs.readFileSync(pj, "utf8"));
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, ver] of Object.entries(p[k] || {})) {
        if (dep === other.pkg || /apps[\\/](mobile|school)/.test(String(ver))) problems.push(`${name}/package.json ${k} depends on ${otherName}: ${dep} ${ver}`);
      }
    }
  }
}

// identities: read the literal values from each app's config
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
const schoolCfg = read(path.join(APPS.school.dir, "app.config.ts"));
const mobileCfg = read(path.join(APPS.mobile.dir, "app.json")) + read(path.join(APPS.mobile.dir, "app.config.ts")) + read(path.join(APPS.mobile.dir, "app.config.js"));
const pick = (text, key) => new Set([...text.matchAll(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`, "g"))].map((m) => m[1]));
for (const key of ["package", "bundleIdentifier", "slug", "scheme"]) {
  const shared = [...pick(schoolCfg, key)].filter((v) => pick(mobileCfg, key).has(v));
  if (shared.length) problems.push(`both apps use the same ${key}: ${shared.join(", ")}`);
}
if (!pick(schoolCfg, "package").has("com.techvein.tatvaos.school")) problems.push("apps/school/app.config.ts no longer has package com.techvein.tatvaos.school");

if (problems.length) {
  console.error("TatvaOS School and Connect (apps/mobile) must have no connection:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("ok: apps/school and apps/mobile share no imports, packages, app IDs, slugs or schemes");
