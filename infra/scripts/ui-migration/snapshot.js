// Paste into the browser console (or run through a browser tool) on any page.
//
//   await tvSnap('save')     before a change: records every element's computed style
//   await tvSnap('compare')  after it: lists elements whose computed style moved
//
// Keyed by viewport width and path, in localStorage of THAT origin, so a
// snapshot taken on production compares against production and one taken on
// localhost against localhost. Take one per width you care about (375, 640,
// 1280 cover Bootstrap's sm and lg breakpoints).
//
// WHY THIS EXISTS. Stage 3 promises "looks the same", and reading class names
// cannot prove that here: Bootstrap and Tailwind share names with different
// values, and YZEN's !important rules decide which wins. The first run of the
// utility codemod read correctly and still broke every page (an invalid class
// became invalid CSS); the second run was off by one value (`rounded-pill` is
// 50rem, not 9999px). Both were found by this comparison and by nothing else.
//
// Element ORDER must not change between save and compare, which holds for a
// class-only change. A structural change shows as every row differing.
window.tvSnap = async function tvSnap(mode) {
  const PROPS = [
    'display', 'position', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap',
    'font-size', 'font-weight', 'line-height', 'color', 'background-color',
    'border-top-width', 'border-top-color', 'border-radius', 'flex-direction',
    'align-items', 'justify-content', 'text-transform', 'text-decoration-line',
    'white-space', 'overflow-x', 'font-family',
  ];
  const els = [...document.querySelectorAll('body *')]
    .filter((e) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'TEMPLATE'].includes(e.tagName));
  const rows = els.map((e) => {
    const c = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return `${e.tagName}#${PROPS.map((p) => `${p}=${c.getPropertyValue(p)}`).join(';')}`
      + `;rect=${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
  });
  const key = `snap-before:${innerWidth}:${location.pathname}`;
  if (mode === 'save') {
    localStorage.setItem(key, JSON.stringify(rows));
    return { key, saved: rows.length };
  }
  const before = JSON.parse(localStorage.getItem(key) || '[]');
  const diffs = [];
  for (let i = 0; i < Math.max(rows.length, before.length); i++) {
    if (rows[i] === before[i]) continue;
    const a = (before[i] || '').split(/[#;]/);
    const b = (rows[i] || '').split(/[#;]/);
    diffs.push({
      i,
      cls: typeof els[i]?.className === 'string' ? els[i].className.slice(0, 80) : '',
      changed: b.map((x, k) => (x !== a[k] ? `${x} (was ${a[k]})` : null)).filter(Boolean).slice(0, 5),
    });
  }
  return { key, before: before.length, after: rows.length, differing: diffs.length, sample: diffs.slice(0, 10) };
};
