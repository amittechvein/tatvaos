// TatvaOS Bugs — "Possible duplicates" (Amit, 26 Sept 2026).
//
// Plain text matching, NO AI: nothing leaves the server. While a tester types
// a title, the form asks which existing issues share its words, so the same
// bug is not reported five times.
//
// Score: a word shared with the other issue's TITLE counts 3, with its details
// 1; same sub-module +2, same module +1. Words are lower-cased, split on
// anything that is not a letter or digit, and common words are dropped. A
// title needs two meaningful words before anything is suggested, and a match
// needs at least two shared title words (or one plus the same sub-module) —
// "button" alone matches half the tracker and helps nobody.

const STOP = new Set(`a an and are as at be but by can cannot could did do does doing done for from has have
how i if in into is it its me my no not of on or our please should so some than that the their them then
there these they this to too very was we were what when where which while who why will with would you your
also after before again still does dont doesnt isnt wont cant any all get got getting shows showing show
issue bug problem error working work works properly page screen click clicking option new add added`.split(/\s+/));

export function words(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

export function findSimilar(db, { title, details = '', moduleId = null, submoduleId = null, excludeId = null, limit = 5 }) {
  const t = words(title);
  if (t.size < 2) return [];
  const d = words(details);
  // The newest 3000 issues are plenty for a team tracker and keep this instant.
  const rows = db.prepare(`
    SELECT i.id, i.title, i.details, i.status, i.type, i.module_id, i.submodule_id, i.created_at,
           m.name module_name, sm.name submodule_name
      FROM issues i JOIN modules m ON m.id = i.module_id JOIN submodules sm ON sm.id = i.submodule_id
     ORDER BY i.id DESC LIMIT 3000`).all();
  const scored = [];
  for (const r of rows) {
    if (excludeId && r.id === excludeId) continue;
    const rt = words(r.title);
    let titleHits = 0;
    for (const w of t) if (rt.has(w)) titleHits++;
    if (!titleHits) continue;
    const rd = words(r.details);
    let detailHits = 0;
    for (const w of t) if (!rt.has(w) && rd.has(w)) detailHits++;
    for (const w of d) if (rt.has(w)) detailHits++;
    const sameSub = submoduleId && r.submodule_id === submoduleId;
    const sameMod = moduleId && r.module_id === moduleId;
    if (titleHits < 2 && !(titleHits === 1 && sameSub)) continue;
    const score = titleHits * 3 + Math.min(detailHits, 5) + (sameSub ? 2 : sameMod ? 1 : 0);
    scored.push({ ...r, score, titleHits });
  }
  scored.sort((a, b) => b.score - a.score || b.id - a.id);
  return scored.slice(0, limit).map(({ details: _, ...r }) => r);
}
