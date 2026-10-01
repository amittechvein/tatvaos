// ============================================================================
//  "The same document", strictly — the render gate's comparison
// ============================================================================
//
//  Mr. Singh's definition (29 Sept 2026; DOCS_SERVER_RENDER_DESIGN.md §13,
//  decision 0011 "How condition 1 is proved"):
//
//    - the same sequence of elements, the same text nodes byte for byte,
//      and the same SET of attribute names on each element;
//    - attribute values equal byte for byte, EXCEPT `style`, compared as a
//      parsed set of declarations with colour values normalised to one
//      notation;
//    - no other normalisation.
//
//  Both sides are parsed by the same HTML parser (happy-dom), so the one
//  thing a parser does — decoding "&amp;" into "&" — happens identically to
//  both and cannot hide a difference.
//
//  What "parsed set of declarations" means here, and nothing more: split on
//  ";", split each at its first ":", trim the whitespace around name and
//  value, drop empty declarations. Colours inside a value — #rgb, #rgba,
//  #rrggbb, #rrggbbaa, rgb(), rgba() — are rewritten as rgba(r, g, b, a).
//  Names are NOT lower-cased, other values are NOT touched, named colours
//  ("red") are NOT converted: any of those would be a second normalisation.
// ============================================================================

import { Window } from 'happy-dom';

const window = new Window();

/** Every node in document order: elements with their attributes, and text. */
function nodes(html) {
  const doc = new window.DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const out = [];
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        const attrs = new Map();
        for (const a of child.attributes) attrs.set(a.name, a.value);
        out.push({ kind: 'element', name: child.localName, attrs });
        walk(child);
        out.push({ kind: 'end', name: child.localName });
      } else if (child.nodeType === 3) {
        out.push({ kind: 'text', text: child.data });
      } else if (child.nodeType === 8) {
        out.push({ kind: 'comment', text: child.data });
      }
    }
  })(doc.body);
  return out;
}

const HEX = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const RGB = /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)/g;

function colour(r, g, b, a) { return `rgba(${r}, ${g}, ${b}, ${a})`; }

/** Colour values in one notation — the only change made to a style value. */
export function normaliseColours(value) {
  return value
    .replace(HEX, (_, h) => {
      const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
      const n = (i) => parseInt(full.slice(i, i + 2), 16);
      const a = full.length === 8 ? +(n(6) / 255).toFixed(3) : 1;
      return colour(n(0), n(2), n(4), a);
    })
    .replace(RGB, (_, r, g, b, a) => {
      let alpha = 1;
      if (a !== undefined) alpha = a.endsWith('%') ? +(parseFloat(a) / 100).toFixed(3) : +(+a).toFixed(3);
      return colour(+r, +g, +b, alpha);
    });
}

/** A style attribute as a sorted list of "name: value" declarations. */
export function declarations(style) {
  return style.split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .map((d) => {
      const at = d.indexOf(':');
      if (at < 0) return `${d}:`; // not a declaration; kept, verbatim, so it still has to match
      return `${d.slice(0, at).trim()}: ${normaliseColours(d.slice(at + 1).trim())}`;
    })
    .sort();
}

function show(n) {
  if (!n) return '(nothing)';
  if (n.kind === 'text') return `text ${JSON.stringify(n.text.slice(0, 60))}`;
  if (n.kind === 'end') return `</${n.name}>`;
  if (n.kind === 'comment') return `<!--${n.text.slice(0, 40)}-->`;
  return `<${n.name}${[...n.attrs].map(([k, v]) => ` ${k}="${v.slice(0, 50)}"`).join('')}>`;
}

/**
 * Compare two HTML strings as documents. Returns every difference found (the
 * first 20), each naming the position and both sides; empty = the same.
 */
export function sameDocument(expectedHtml, actualHtml) {
  const a = nodes(expectedHtml);
  const b = nodes(actualHtml);
  const diffs = [];
  const note = (i, why) => { if (diffs.length < 20) diffs.push(`#${i} ${why}\n          expected ${show(a[i])}\n          got      ${show(b[i])}`); };
  if (a.length !== b.length) diffs.push(`node count: expected ${a.length}, got ${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i], y = b[i];
    if (x.kind !== y.kind) { note(i, 'a different kind of node'); continue; }
    if (x.kind === 'text' || x.kind === 'comment') { if (x.text !== y.text) note(i, 'text differs'); continue; }
    if (x.name !== y.name) { note(i, 'a different element'); continue; }
    if (x.kind === 'end') continue;
    const names = (m) => [...m.keys()].sort().join(' ');
    if (names(x.attrs) !== names(y.attrs)) { note(i, `attribute names differ: [${names(x.attrs)}] vs [${names(y.attrs)}]`); continue; }
    for (const [k, v] of x.attrs) {
      const w = y.attrs.get(k);
      if (k === 'style') {
        if (declarations(v).join('; ') !== declarations(w).join('; ')) note(i, `style differs: [${declarations(v).join('; ')}] vs [${declarations(w).join('; ')}]`);
      } else if (v !== w) {
        note(i, `attribute ${k} differs`);
      }
    }
  }
  return diffs;
}
