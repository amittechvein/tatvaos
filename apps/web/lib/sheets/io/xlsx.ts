// ============================================================================
//  .xlsx import and export (Office Open XML SpreadsheetML).
//
//  Converts between an .xlsx file and the WorkbookData snapshot
//  (lib/sheets/workbook.ts). No spreadsheet library: the npm build of SheetJS
//  has unfixed CVEs and the fixed builds live only on its own CDN, so this
//  file reads and writes the XML itself, on top of io/zip.ts.
//
//  Three parts, top to bottom:
//    1. A small XML parser. DOMParser does not exist in Node, and we want the
//       same code in both. It reads elements, attributes, text, CDATA and the
//       five named entities plus numeric ones; it skips comments and
//       processing instructions; it REFUSES a DOCTYPE, so no external or
//       expanding entity can ever be processed. Prefixes are dropped: every
//       element and attribute is matched on its local name.
//    2. Reading: sheets, values, formulas (shared formulas expanded), cached
//       values, styles, sizes, merges, frozen panes, tab colours.
//    3. Writing: the smallest set of parts Excel and Google Sheets open
//       without a repair prompt.
//
//  Conditional formats are kept as colour rules (rules.ts) where TatvaOS has
//  the kind — cell value, text contains/begins/ends, blanks — and written
//  back the same way (readColourRules, colourRuleXml).
//
//  What an .xlsx can hold that the snapshot cannot, and so is dropped on
//  List validations are kept as dropdowns (dropdowns.ts): a typed list, or
//  a range on the same sheet read as values (readDropdowns, dropdownsXml).
//
//  What an .xlsx can hold that the snapshot cannot, and so is dropped on
//  import: hidden rows and columns, row/column default styles, the other
//  conditional formats (colour scales, data bars, icon sets, formula rules),
//  other data validation (numbers, dates, lists from another sheet or a
//  name), comments, images and charts, defined names,
//  hyperlinks, rich text formatting inside a cell (the text is kept), and
//  array-formula ranges (the formula is kept in its first cell).
//
//  Erasable TypeScript only: the tests run this file under Node's type
//  stripping.
// ============================================================================

import { colIndex, colName, cellName, parseRect, MAX_ROWS, MAX_COLS, type Rect } from '../engine/address';
import { CellError, INDIA, type ErrorCode, type Scalar } from '../engine/types';
import { parseInput, parseNumberText } from '../engine/input';
import {
  cleanRule, cleanStyle, operandCount, type ColourRule, type RuleKind, type RuleStyle,
} from '../rules';
import { cleanDropdown, MAX_ITEMS, type Dropdown } from '../dropdowns';
import {
  DEFAULT_COLS, DEFAULT_COL_WIDTH, DEFAULT_ROWS, DEFAULT_ROW_HEIGHT, cellKey, parseCellKey,
  type BorderSide, type BorderStyle, type CellData, type CellFormat, type SheetData, type WorkbookData,
} from '../workbook';
import { readZip, writeZip } from './zip';
import { formulaIsSafe } from './safety';

// ============================================================================
//  1. XML
// ============================================================================

export interface XmlNode {
  /** Local name: "c" for both <c> and <x:c>. */
  name: string;
  /** Attributes by local name: r:id → "id". */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The element's own text (not its children's), CDATA included. */
  text: string;
}

export class XmlError extends Error {}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&([^;&\s]{1,10});/g, (whole, ent: string) => {
    if (ent.startsWith('#')) {
      const n = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
        throw new XmlError(`Bad character reference ${whole}.`);
      }
      return String.fromCodePoint(n);
    }
    const v = NAMED_ENTITIES[ent];
    if (v === undefined) throw new XmlError(`Unknown entity ${whole}.`);
    return v;
  });
}

const localName = (qname: string) => {
  const i = qname.indexOf(':');
  return i < 0 ? qname : qname.slice(i + 1);
};

const NAME_CHARS = /[^\s/>=]/;

/** Parse an XML document into a tree. Throws XmlError on anything malformed, and on any DOCTYPE. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  if (src.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      if (src.slice(i).trim() !== '' && stack.length > 1) throw new XmlError('Unexpected end of document.');
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      if (e < 0) throw new XmlError('Unclosed processing instruction.');
      i = e + 2;
    } else if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e < 0) throw new XmlError('Unclosed comment.');
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      if (e < 0) throw new XmlError('Unclosed CDATA section.');
      top.text += src.slice(lt + 9, e);
      i = e + 3;
    } else if (src.startsWith('<!', lt)) {
      // <!DOCTYPE …> and anything else declarative. Never processed: a DOCTYPE
      // is how entity-expansion and external-entity attacks get in.
      throw new XmlError('Documents with a DOCTYPE or other declarations are refused.');
    } else if (src.startsWith('</', lt)) {
      const e = src.indexOf('>', lt + 2);
      if (e < 0) throw new XmlError('Unclosed end tag.');
      const name = localName(src.slice(lt + 2, e).trim());
      if (stack.length <= 1 || top.name !== name) throw new XmlError(`Mismatched end tag </${name}>.`);
      stack.pop();
      i = e + 1;
    } else {
      // A start tag: name, attributes, then > or />.
      let j = lt + 1;
      while (j < n && NAME_CHARS.test(src[j]!)) j += 1;
      const qname = src.slice(lt + 1, j);
      if (qname === '') throw new XmlError('Empty tag name.');
      const node: XmlNode = { name: localName(qname), attrs: {}, children: [], text: '' };
      let selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(src[j]!)) j += 1;
        if (j >= n) throw new XmlError('Unclosed start tag.');
        const ch = src[j]!;
        if (ch === '>') { j += 1; break; }
        if (ch === '/') {
          if (src[j + 1] !== '>') throw new XmlError('Malformed start tag.');
          selfClose = true; j += 2; break;
        }
        const as = j;
        while (j < n && NAME_CHARS.test(src[j]!)) j += 1;
        const aname = src.slice(as, j);
        if (aname === '') throw new XmlError('Malformed attribute.');
        while (j < n && /\s/.test(src[j]!)) j += 1;
        if (src[j] !== '=') throw new XmlError(`Attribute ${aname} has no value.`);
        j += 1;
        while (j < n && /\s/.test(src[j]!)) j += 1;
        const q = src[j];
        if (q !== '"' && q !== "'") throw new XmlError(`Attribute ${aname} is not quoted.`);
        const e = src.indexOf(q, j + 1);
        if (e < 0) throw new XmlError('Unclosed attribute value.');
        const raw = src.slice(j + 1, e);
        if (raw.includes('<')) throw new XmlError('"<" inside an attribute value.');
        // Attribute-value normalisation: literal tabs/newlines become spaces.
        if (!aname.startsWith('xmlns')) node.attrs[localName(aname)] = decodeEntities(raw.replace(/[\t\n\r]/g, ' '));
        j = e + 1;
      }
      top.children.push(node);
      if (!selfClose) stack.push(node);
      i = j;
    }
  }
  if (stack.length !== 1) throw new XmlError('Unexpected end of document: unclosed elements.');
  if (root.children.length !== 1) throw new XmlError('A document must have exactly one root element.');
  return root.children[0]!;
}

const kid = (node: XmlNode | undefined, name: string) => node?.children.find((c) => c.name === name);
const kids = (node: XmlNode | undefined, name: string) => (node ? node.children.filter((c) => c.name === name) : []);

/** Excel's escape for characters XML cannot carry: _x000D_ is a carriage return. */
function unescapeOoxml(s: string): string {
  if (!s.includes('_x')) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function escapeXml(s: string): string {
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // A literal "_x0041_" must survive Excel's own unescaping.
  out = out.replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_');
  // Control characters XML 1.0 cannot hold at all → Excel's _xHHHH_ form.
  // A carriage return is legal but a parser folds it into \n, so keep it as a reference.
   
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g,
    (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
  return out.replace(/\r/g, '&#13;');
}

// ============================================================================
//  Formula text: shifting relative references, and function-name prefixes.
// ============================================================================

/** Excel's own limits, for telling "TAX2026" (a name) from "B12" (a cell). */
const XL_MAX_COLS = 16_384;
const XL_MAX_ROWS = 1_048_576;

/**
 * Walk formula text, handing each stretch that is outside "strings",
 * 'quoted sheet names' and [structured references] to `plain`, and copying
 * the rest untouched.
 */
function mapFormulaCode(src: string, plain: (s: string) => string): string {
  let out = '';
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out += plain(buf); buf = ''; } };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      flush();
      let j = i + 1;
      for (;;) {
        const e = src.indexOf(ch, j);
        if (e < 0) { j = src.length; break; }
        if (src[e + 1] === ch) { j = e + 2; continue; } // "" or '' is an escaped quote
        j = e + 1; break;
      }
      out += src.slice(i, j);
      i = j;
    } else if (ch === '[') {
      flush();
      let depth = 0;
      let j = i;
      for (; j < src.length; j += 1) {
        if (src[j] === '[') depth += 1;
        else if (src[j] === ']') { depth -= 1; if (depth === 0) { j += 1; break; } }
      }
      out += src.slice(i, j);
      i = j;
    } else {
      buf += ch;
      i += 1;
    }
  }
  flush();
  return out;
}

const REF_PATTERN = new RegExp(
  '(?<![A-Za-z0-9_.$])(?:' +
  '(\\$?)([A-Za-z]{1,3})(\\$?)([0-9]{1,7})' +          // A1, $A$1
  '|(\\$?)([A-Za-z]{1,3}):(\\$?)([A-Za-z]{1,3})' +     // A:C
  '|(\\$?)([0-9]{1,7}):(\\$?)([0-9]{1,7})' +           // 1:3
  ')(?![A-Za-z0-9_(])', 'g');

/**
 * Move every relative reference in a formula by (dr, dc), as Excel does when
 * a formula is filled or a shared formula is applied to another cell.
 * $-anchored parts stay; text in quotes stays; a reference pushed off the
 * sheet becomes #REF!. The formula has no leading '='.
 */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  if (dr === 0 && dc === 0) return formula;
  const col = (abs: string, letters: string): string | null => {
    const c = colIndex(letters);
    if (c < 0 || c >= XL_MAX_COLS) return null;
    const nc = abs ? c : c + dc;
    return nc < 0 || nc >= XL_MAX_COLS ? '#REF!' : abs + colName(nc);
  };
  const row = (abs: string, digits: string): string | null => {
    const r = Number(digits) - 1;
    if (r < 0 || r >= XL_MAX_ROWS) return null;
    const nr = abs ? r : r + dr;
    return nr < 0 || nr >= XL_MAX_ROWS ? '#REF!' : abs + String(nr + 1);
  };
  return mapFormulaCode(formula, (seg) => seg.replace(REF_PATTERN, (whole, ...g: (string | undefined)[]) => {
    if (g[1] !== undefined) {
      const c = col(g[0]!, g[1]); const r = row(g[2]!, g[3]!);
      if (c === null || r === null) return whole;
      return c === '#REF!' || r === '#REF!' ? '#REF!' : c + r;
    }
    if (g[5] !== undefined) {
      const a = col(g[4]!, g[5]); const b = col(g[6]!, g[7]!);
      if (a === null || b === null) return whole;
      return a === '#REF!' || b === '#REF!' ? '#REF!' : `${a}:${b}`;
    }
    const a = row(g[8]!, g[9]!); const b = row(g[10]!, g[11]!);
    if (a === null || b === null) return whole;
    return a === '#REF!' || b === '#REF!' ? '#REF!' : `${a}:${b}`;
  }));
}

/** Excel writes newer functions as _xlfn.XLOOKUP, _xlfn._xlws.FILTER; the app wants XLOOKUP. */
export function stripFunctionPrefixes(formula: string): string {
  return mapFormulaCode(formula, (seg) => seg.replace(/_xl(?:fn|ws|pm)\./gi, ''));
}

/**
 * Functions newer than Excel 2007. Excel's file format wants them prefixed;
 * without the prefix Excel shows #NAME? until someone re-enters the formula.
 */
const XLWS = new Set(['FILTER', 'SORT']);
const XLFN = new Set([
  'XLOOKUP', 'XMATCH', 'SORTBY', 'UNIQUE', 'SEQUENCE', 'RANDARRAY', 'LET', 'LAMBDA', 'IFS', 'SWITCH',
  'MAXIFS', 'MINIFS', 'CONCAT', 'TEXTJOIN', 'IFNA', 'DAYS', 'ISOWEEKNUM', 'XOR', 'TEXTBEFORE',
  'TEXTAFTER', 'TEXTSPLIT', 'VSTACK', 'HSTACK', 'TOCOL', 'TOROW', 'CHOOSECOLS', 'CHOOSEROWS', 'TAKE',
  'DROP', 'WRAPROWS', 'WRAPCOLS', 'EXPAND', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'PERCENTILE.INC',
  'PERCENTILE.EXC', 'QUARTILE.INC', 'QUARTILE.EXC', 'RANK.EQ', 'RANK.AVG', 'MODE.SNGL', 'MODE.MULT',
  'NORM.DIST', 'NORM.S.DIST', 'NORM.INV', 'NORM.S.INV', 'CEILING.MATH', 'FLOOR.MATH', 'CEILING.PRECISE',
  'FLOOR.PRECISE', 'AGGREGATE', 'NETWORKDAYS.INTL', 'WORKDAY.INTL', 'NUMBERVALUE', 'UNICHAR', 'UNICODE',
  'ARABIC', 'BASE', 'DECIMAL', 'SHEET', 'SHEETS', 'FORMULATEXT', 'ISFORMULA', 'COT', 'COTH', 'CSC',
  'CSCH', 'SEC', 'SECH', 'ACOT', 'ACOTH', 'BITAND', 'BITOR', 'BITXOR', 'BITLSHIFT', 'BITRSHIFT',
  'COVARIANCE.P', 'COVARIANCE.S', 'CONFIDENCE.NORM', 'CONFIDENCE.T', 'T.DIST', 'T.DIST.2T', 'T.DIST.RT',
  'T.INV', 'T.INV.2T', 'T.TEST', 'BINOM.DIST', 'EXPON.DIST', 'POISSON.DIST', 'WEIBULL.DIST',
  'LOGNORM.DIST', 'LOGNORM.INV', 'GAMMA', 'GAMMA.DIST', 'GAMMA.INV', 'GAMMALN.PRECISE', 'CHISQ.DIST',
  'CHISQ.DIST.RT', 'CHISQ.INV', 'CHISQ.INV.RT', 'CHISQ.TEST', 'F.DIST', 'F.DIST.RT', 'F.INV',
  'F.INV.RT', 'F.TEST', 'Z.TEST', 'ERF.PRECISE', 'ERFC.PRECISE', 'PDURATION', 'RRI', 'IMAGE',
  'ARRAYTOTEXT', 'VALUETOTEXT', 'ENCODEURL', 'CONCAT', 'STOCKHISTORY', 'ISOMITTED', 'BYROW', 'BYCOL',
  'MAP', 'REDUCE', 'SCAN', 'MAKEARRAY', 'GROUPBY', 'PIVOTBY', 'PERCENTOF', 'TRIMRANGE', 'REGEXTEST',
  'REGEXEXTRACT', 'REGEXREPLACE',
]);

function addFunctionPrefixes(formula: string): string {
  return mapFormulaCode(formula, (seg) =>
    seg.replace(/(?<![A-Za-z0-9_.])([A-Za-z][A-Za-z0-9.]*)(?=\()/g, (name: string) => {
      const up = name.toUpperCase();
      if (XLWS.has(up)) return `_xlfn._xlws.${name}`;
      if (XLFN.has(up)) return `_xlfn.${name}`;
      return name;
    }));
}

/** True when the file format wants this function prefixed (_xlfn. or _xlfn._xlws.). */
export function excelPrefixes(name: string): boolean {
  const up = name.toUpperCase();
  return XLWS.has(up) || XLFN.has(up);
}

/**
 * Functions the editor supports that Excel 2019 and older do not know. The
 * file stores them correctly (_xlfn.XLOOKUP), and older Excel still shows
 * #NAME? in those cells: measured 3 Oct 2026 on this laptop's 2019-class
 * Excel, where the one miss in the real-Excel check was XLOOKUP. So the
 * download names them (Amit, 3 Oct; design §4a). The value is the oldest
 * Excel that has the function. tests/sheets/older-excel.test.ts fails when the
 * engine gains a prefixed function that is in neither this map nor its list
 * of functions Excel 2019 already has.
 */
export const NEWER_THAN_EXCEL_2019: ReadonlyMap<string, 'Excel 2021' | 'Microsoft 365'> = new Map([
  ['XLOOKUP', 'Excel 2021'], ['XMATCH', 'Excel 2021'],
  ['CHOOSECOLS', 'Microsoft 365'], ['CHOOSEROWS', 'Microsoft 365'],
  ['REGEXEXTRACT', 'Microsoft 365'], ['REGEXREPLACE', 'Microsoft 365'],
]);

/** The functions in a workbook that Excel 2019 and older show as #NAME?, sorted. */
export function functionsNeedingNewerExcel(wb: WorkbookData): string[] {
  const found = new Set<string>();
  for (const sheet of wb.sheets) {
    for (const cell of sheet.cells.values()) {
      const input = cell.input;
      // Only what goes into the file as a formula: cellXml writes an unsafe one as text.
      if (input === null || !input.startsWith('=') || input.length < 2 || !formulaIsSafe(input)) continue;
      mapFormulaCode(input.slice(1), (seg) => {
        for (const m of seg.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z][A-Za-z0-9.]*)(?=\()/g)) {
          const up = m[1]!.toUpperCase();
          if (NEWER_THAN_EXCEL_2019.has(up)) found.add(up);
        }
        return seg;
      });
    }
  }
  return [...found].sort();
}

/**
 * The line the .xlsx download shows, or null when nothing in the workbook is
 * newer than Excel 2019. Wording ruled by Mr. Singh on 7 Oct 2026, approved
 * as it stands (design §4a).
 */
export function olderExcelNote(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const where = names.some((n) => NEWER_THAN_EXCEL_2019.get(n) === 'Microsoft 365')
    ? 'Microsoft 365' : 'Excel 2021 and Microsoft 365';
  return `This workbook uses ${list}. ${names.length === 1 ? 'It works' : 'They work'} in ${where}; older Excel shows #NAME? in those cells.`;
}

// ============================================================================
//  Colours
// ============================================================================

/** Office's default theme (2013+), in theme-index order: lt1, dk1, lt2, dk2, accents, links. */
const DEFAULT_THEME = ['ffffff', '000000', 'e7e6e6', '44546a', '4472c4', 'ed7d31', 'a5a5a5', 'ffc000',
  '5b9bd5', '70ad47', '0563c1', '954f72'];

/** The legacy 64-colour palette behind indexed="n". 64/65 are the system text/background colours. */
const INDEXED = [
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
  '800000', '008000', '000080', '808000', '800080', '008080', 'c0c0c0', '808080',
  '9999ff', '993366', 'ffffcc', 'ccffff', '660066', 'ff8080', '0066cc', 'ccccff',
  '000080', 'ff00ff', 'ffff00', '00ffff', '800080', '800000', '008080', '0000ff',
  '00ccff', 'ccffff', 'ccffcc', 'ffff99', '99ccff', 'ff99cc', 'cc99ff', 'ffcc99',
  '3366ff', '33cccc', '99cc00', 'ffcc00', 'ff9900', 'ff6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
  '000000', 'ffffff',
];

/** Lighten (tint > 0) or darken (tint < 0) a colour the way Excel does: on HSL lightness. */
function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  let h = 0; let s = 0; let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let rr = l; let gg = l; let bb = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rr = hue(p, q, h + 1 / 3); gg = hue(p, q, h); bb = hue(p, q, h - 1 / 3);
  }
  const to = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return to(rr) + to(gg) + to(bb);
}

/** A <color>-type element → '#rrggbb', or undefined for automatic / unreadable. */
function readColor(node: XmlNode | undefined, theme: string[]): string | undefined {
  if (!node) return undefined;
  const a = node.attrs;
  let hex: string | undefined;
  if (a.rgb && /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(a.rgb)) hex = a.rgb.slice(-6).toLowerCase();
  else if (a.theme !== undefined) hex = theme[Number(a.theme)];
  else if (a.indexed !== undefined) hex = INDEXED[Number(a.indexed)];
  if (!hex) return undefined;
  const tint = Number(a.tint ?? 0);
  return `#${Number.isFinite(tint) ? applyTint(hex, tint) : hex}`;
}

function readTheme(xml: string | undefined): string[] {
  if (!xml) return DEFAULT_THEME;
  try {
    const root = parseXml(xml);
    const scheme = kid(kid(root, 'themeElements'), 'clrScheme');
    if (!scheme) return DEFAULT_THEME;
    const pick = (name: string, fallback: string) => {
      const el = kid(scheme, name);
      const srgb = kid(el, 'srgbClr')?.attrs.val;
      const sys = kid(el, 'sysClr')?.attrs.lastClr;
      const v = srgb ?? sys;
      return v && /^[0-9A-Fa-f]{6}$/.test(v) ? v.toLowerCase() : fallback;
    };
    // Theme indices swap the first two pairs: 0 = lt1, 1 = dk1, 2 = lt2, 3 = dk2.
    const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5',
      'accent6', 'hlink', 'folHlink'];
    return order.map((name, i) => pick(name, DEFAULT_THEME[i]!));
  } catch {
    return DEFAULT_THEME;
  }
}

// ============================================================================
//  Number formats
// ============================================================================

/**
 * The built-in formats an .xlsx refers to by number alone. 14 and 22 are
 * "the system short date"; Excel shows them in the reader's locale, so we
 * use the Indian day-first order rather than the US one the standard lists.
 * 5–8 and 23–36 depend on the locale's currency and script; 5–8 get ₹.
 */
const BUILTIN_FORMATS: Record<number, string> = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  5: '"₹"#,##0_);("₹"#,##0)', 6: '"₹"#,##0_);[Red]("₹"#,##0)',
  7: '"₹"#,##0.00_);("₹"#,##0.00)', 8: '"₹"#,##0.00_);[Red]("₹"#,##0.00)',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'dd/mm/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm',
  37: '#,##0_);(#,##0)', 38: '#,##0_);[Red](#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_("₹"* #,##0_);_("₹"* (#,##0);_("₹"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_("₹"* #,##0.00_);_("₹"* (#,##0.00);_("₹"* "-"??_);_(@_)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};

/** Built-ins safe to write by id: they mean the same thing in every locale. */
const WRITE_BUILTIN: Record<string, number> = {
  '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.00E+00': 11,
  '# ?/?': 12, '# ??/??': 13, 'h:mm': 20, 'h:mm:ss': 21, 'mm:ss': 45, '[h]:mm:ss': 46, '@': 49,
};

// ============================================================================
//  2. Reading
// ============================================================================

interface Styles {
  /** cellXfs index → format (undefined for "no formatting"). */
  xfs: (CellFormat | undefined)[];
  /** dxfs index → what a conditional format lays on a cell (undefined if nothing TatvaOS can show). */
  dxfs: (RuleStyle | undefined)[];
}

const truthy = (v: string | undefined) => v !== undefined && v !== '0' && v !== 'false';
/** <b/> means on; <b val="0"/> means off. */
const flag = (node: XmlNode | undefined) => !!node && (node.attrs.val === undefined || truthy(node.attrs.val));

const BORDER_STYLES: Record<string, BorderStyle> = {
  thin: 'thin', hair: 'thin', medium: 'medium', thick: 'thick', dashed: 'dashed', mediumDashed: 'dashed',
  dashDot: 'dashed', mediumDashDot: 'dashed', dashDotDot: 'dashed', mediumDashDotDot: 'dashed',
  slantDashDot: 'dashed', dotted: 'dotted', double: 'double',
};

function readStyles(xml: string | undefined, theme: string[]): Styles {
  if (!xml) return { xfs: [], dxfs: [] };
  const root = parseXml(xml);

  // Differential formats (colour rules). In a dxf a solid fill's colour is
  // bgColor — the opposite of a cell's fill — so bgColor is read first.
  const dxfs = kids(kid(root, 'dxfs'), 'dxf').map((d): RuleStyle | undefined => {
    const f = kid(d, 'font');
    const p = kid(kid(d, 'fill'), 'patternFill');
    return cleanStyle({
      b: flag(kid(f, 'b')), i: flag(kid(f, 'i')), s: flag(kid(f, 'strike')),
      color: readColor(kid(f, 'color'), theme),
      bg: p && p.attrs.patternType !== 'none' ? readColor(kid(p, 'bgColor'), theme) ?? readColor(kid(p, 'fgColor'), theme) : undefined,
    });
  });

  const numFmts = new Map<number, string>();
  for (const nf of kids(kid(root, 'numFmts'), 'numFmt')) {
    numFmts.set(Number(nf.attrs.numFmtId), nf.attrs.formatCode ?? 'General');
  }

  interface Font { b: boolean; i: boolean; u: boolean; s: boolean; name?: string; size?: number; color?: string }
  const fonts: Font[] = kids(kid(root, 'fonts'), 'font').map((f) => {
    const u = kid(f, 'u');
    const size = Number(kid(f, 'sz')?.attrs.val);
    return {
      b: flag(kid(f, 'b')), i: flag(kid(f, 'i')), s: flag(kid(f, 'strike')),
      u: !!u && u.attrs.val !== 'none' && (u.attrs.val === undefined || u.attrs.val !== '0'),
      name: kid(f, 'name')?.attrs.val, size: Number.isFinite(size) && size > 0 ? size : undefined,
      color: readColor(kid(f, 'color'), theme),
    };
  });
  const base = fonts[0];

  const fills: (string | undefined)[] = kids(kid(root, 'fills'), 'fill').map((f) => {
    const p = kid(f, 'patternFill');
    if (!p || p.attrs.patternType !== 'solid') return undefined;
    return readColor(kid(p, 'fgColor'), theme) ?? readColor(kid(p, 'bgColor'), theme);
  });

  type Sides = Pick<CellFormat, 'bt' | 'bb' | 'bl' | 'br'>;
  const borders: Sides[] = kids(kid(root, 'borders'), 'border').map((b) => {
    const side = (name: string): BorderSide | undefined => {
      const el = kid(b, name);
      const style = el?.attrs.style ? BORDER_STYLES[el.attrs.style] : undefined;
      return style ? { style, color: readColor(kid(el, 'color'), theme) ?? '#000000' } : undefined;
    };
    const out: Sides = {};
    const t = side('top'); const bo = side('bottom');
    const l = side('left') ?? side('start'); const r = side('right') ?? side('end');
    if (t) out.bt = t;
    if (bo) out.bb = bo;
    if (l) out.bl = l;
    if (r) out.br = r;
    return out;
  });

  const xfs = kids(kid(root, 'cellXfs'), 'xf').map((xf): CellFormat | undefined => {
    const f: CellFormat = {};
    const a = xf.attrs;

    const nfId = Number(a.numFmtId ?? 0);
    const code = numFmts.get(nfId) ?? BUILTIN_FORMATS[nfId];
    if (code && code !== 'General') f.nf = code;

    const font = fonts[Number(a.fontId ?? 0)];
    if (font && font !== base) {
      if (font.b) f.b = true;
      if (font.i) f.i = true;
      if (font.u) f.u = true;
      if (font.s) f.s = true;
      if (font.name && font.name !== base?.name) f.font = font.name;
      if (font.size && font.size !== base?.size) f.size = font.size;
      if (font.color && font.color !== base?.color) f.color = font.color;
    } else if (font) {
      // The default font can still be bold, in a hand-made file.
      if (font.b) f.b = true;
      if (font.i) f.i = true;
    }

    const bg = fills[Number(a.fillId ?? 0)];
    if (bg) f.bg = bg;
    Object.assign(f, borders[Number(a.borderId ?? 0)] ?? {});

    const al = kid(xf, 'alignment');
    if (al) {
      const h = al.attrs.horizontal;
      if (h === 'left' || h === 'right') f.ha = h;
      else if (h === 'center' || h === 'centerContinuous') f.ha = 'center';
      else if (h === 'justify' || h === 'distributed' || h === 'fill') f.ha = 'left';
      const v = al.attrs.vertical;
      if (v === 'top' || v === 'bottom') f.va = v;
      else if (v === 'center' || v === 'justify' || v === 'distributed') f.va = 'middle';
      if (truthy(al.attrs.wrapText)) f.wrap = 'wrap';
    }
    return Object.keys(f).length ? f : undefined;
  });
  return { xfs, dxfs };
}

/** Text of a shared-string item or inline string: <t>, or the <t> of every run. Phonetic hints skipped. */
function stringItem(si: XmlNode): string {
  const direct = kid(si, 't');
  if (direct) return unescapeOoxml(direct.text);
  let s = '';
  for (const r of kids(si, 'r')) {
    const t = kid(r, 't');
    if (t) s += t.text;
  }
  return unescapeOoxml(s);
}

const ERROR_CODES = new Set<string>(['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#NULL!', '#ERROR!']);
function toError(code: string): CellError {
  return ERROR_CODES.has(code) ? new CellError(code as ErrorCode) : new CellError('#ERROR!', `${code} in the original file.`);
}

/** Numeric text from a file → the number, or null. */
function fileNumber(v: string): number | null {
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A text cell's input. If the app would read the text as anything but that
 * text — a number, a date, TRUE, a formula — an apostrophe keeps it text.
 */
function textInput(s: string): string {
  if (s.startsWith("'")) return `'${s}`;
  const p = parseInput(s, INDIA);
  return p.kind === 'value' && typeof p.value === 'string' ? s : `'${s}`;
}

/** An ISO date-time (t="d") → a spreadsheet serial number. */
function isoToSerial(s: string): number | null {
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}${s.includes('T') ? '' : 'T00:00:00'}Z`);
  if (!Number.isFinite(ms)) return null;
  return ms / 86_400_000 + 25_569; // days since 1899-12-30
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

interface Rel { type: string; target: string }
function readRels(files: Map<string, Uint8Array>, partPath: string): Map<string, Rel> {
  const slash = partPath.lastIndexOf('/');
  const relsPath = `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
  const out = new Map<string, Rel>();
  const xml = text(files, relsPath);
  if (!xml) return out;
  for (const r of kids(parseXml(xml), 'Relationship')) {
    if (r.attrs.TargetMode === 'External' || !r.attrs.Id || !r.attrs.Target) continue;
    out.set(r.attrs.Id, { type: r.attrs.Type ?? '', target: resolvePath(partPath, r.attrs.Target) });
  }
  return out;
}

const decoder = new TextDecoder('utf-8');
function text(files: Map<string, Uint8Array>, path: string): string | undefined {
  // Paths inside a ZIP are case-sensitive by spec but not always in practice.
  let data = files.get(path);
  if (!data) {
    const lower = path.toLowerCase();
    for (const [k, v] of files) if (k.toLowerCase() === lower) { data = v; break; }
  }
  return data ? decoder.decode(data) : undefined;
}

const relOfType = (rels: Map<string, Rel>, suffix: string) =>
  [...rels.values()].find((r) => r.type.endsWith(suffix))?.target;

/** Read an .xlsx file into a workbook snapshot. Throws on a damaged or unsupported file. */
export async function readXlsx(bytes: Uint8Array): Promise<WorkbookData> {
  const files = await readZip(bytes);

  const rootRels = readRels(files, '');
  const wbPath = relOfType(rootRels, '/officeDocument') ?? 'xl/workbook.xml';
  const wbXml = text(files, wbPath);
  if (!wbXml) throw new Error('This file has no workbook inside; it may not be an .xlsx spreadsheet.');
  const wb = parseXml(wbXml);
  const wbRels = readRels(files, wbPath);

  const theme = readTheme(text(files, relOfType(wbRels, '/theme') ?? 'xl/theme/theme1.xml'));
  const styles = readStyles(text(files, relOfType(wbRels, '/styles') ?? 'xl/styles.xml'), theme);

  const sstXml = text(files, relOfType(wbRels, '/sharedStrings') ?? 'xl/sharedStrings.xml');
  const strings = sstXml ? kids(parseXml(sstXml), 'si').map(stringItem) : [];

  const date1904 = truthy(kid(wb, 'workbookPr')?.attrs.date1904);

  const sheets: SheetData[] = [];
  for (const s of kids(kid(wb, 'sheets'), 'sheet')) {
    const rel = s.attrs.id ? wbRels.get(s.attrs.id) : undefined;
    if (!rel || !rel.type.endsWith('/worksheet')) continue; // chartsheets, dialog sheets: not grids
    const xml = text(files, rel.target);
    if (!xml) continue;
    const sheet = readSheet(parseXml(xml), s.attrs.name ?? `Sheet${sheets.length + 1}`, strings, styles, theme, date1904);
    if (s.attrs.state === 'hidden' || s.attrs.state === 'veryHidden') sheet.hidden = true;
    sheets.push(sheet);
  }
  if (sheets.length === 0) throw new Error('This file has no worksheets.');
  return { sheets };
}

const CELL_IS_KIND: Record<string, RuleKind> = {
  greaterThan: 'gt', greaterThanOrEqual: 'gte', lessThan: 'lt', lessThanOrEqual: 'lte',
  equal: 'eq', notEqual: 'ne', between: 'between', notBetween: 'notBetween',
};
const TEXT_KIND: Record<string, RuleKind> = {
  containsText: 'contains', notContainsText: 'notContains', beginsWith: 'startsWith', endsWith: 'endsWith',
  containsBlanks: 'empty', notContainsBlanks: 'notEmpty',
};
/** A file can hold any number of rules; a sheet keeps this many. */
const MAX_RULES_PER_SHEET = 200;

/**
 * A cellIs operand as TatvaOS keeps it: a number or a quoted string. Anything
 * else — a cell reference, an expression — is a formula rule TatvaOS cannot
 * keep, so the rule is dropped (undefined), never evaluated.
 */
function cfOperand(f: string | undefined): string | undefined {
  const t = (f ?? '').trim();
  const q = /^"((?:[^"]|"")*)"$/.exec(t);
  if (q) return q[1]!.replace(/""/g, '"');
  return PLAIN_NUMBER.test(t) && Number.isFinite(Number(t)) ? t : undefined;
}

/**
 * The file's conditional formats that TatvaOS can keep, as colour rules in
 * the order they apply (Excel's priority, lowest first). Kept: "cell value
 * is …", "text contains / begins / ends", "blanks / no blanks". Dropped:
 * colour scales, data bars, icon sets, top/bottom, above average,
 * duplicates, date periods, formula rules, and any rule whose look TatvaOS
 * cannot show. A rule over several ranges becomes one rule per range.
 */
function readColourRules(root: XmlNode, styles: Styles): (Rect & ColourRule)[] {
  const found: { priority: number; seq: number; rule: Rect & ColourRule }[] = [];
  for (const cf of kids(root, 'conditionalFormatting')) {
    const rects = (cf.attrs.sqref ?? '').trim().split(/\s+/)
      .map((ref) => (ref ? parseRect(ref.replace(/\$/g, '')) : null))
      .filter((r): r is Rect => r !== null);
    for (const el of kids(cf, 'cfRule')) {
      const style = styles.dxfs[Number(el.attrs.dxfId)];
      if (!style) continue;
      const type = el.attrs.type ?? '';
      let rule: ColourRule | undefined;
      if (type === 'cellIs') {
        const kind = CELL_IS_KIND[el.attrs.operator ?? ''];
        const [fa, fb] = kids(el, 'formula').map((f) => cfOperand(f.text));
        if (kind) rule = cleanRule({ kind, a: fa, b: fb, style });
      } else if (TEXT_KIND[type]) {
        rule = cleanRule({ kind: TEXT_KIND[type], a: el.attrs.text, style });
      }
      if (!rule) continue;
      const priority = Number(el.attrs.priority);
      for (const rect of rects) {
        found.push({ priority: Number.isFinite(priority) ? priority : Infinity, seq: found.length, rule: { ...rule, ...rect } });
      }
    }
  }
  return found
    .sort((x, y) => x.priority - y.priority || x.seq - y.seq)
    .slice(0, MAX_RULES_PER_SHEET)
    .map((x) => x.rule);
}

/** A file can hold any number of validations; a sheet keeps this many dropdowns. */
const MAX_DROPDOWNS_PER_SHEET = 200;

/**
 * The file's list validations as dropdowns. Two sources are read: a list
 * typed into the rule ("Paid,Due,Waived"), and a range on the SAME sheet
 * ($H$2:$H$6), whose cells are read now, as values — the dropdown keeps the
 * choices, not a link to those cells. A range on another sheet, a named
 * range or any other formula is dropped, never evaluated; so are the other
 * validation types (whole number, date, text length, custom).
 */
function readDropdowns(root: XmlNode, cells: Map<string, CellData>): (Rect & Dropdown)[] {
  const out: (Rect & Dropdown)[] = [];
  for (const v of kids(kid(root, 'dataValidations'), 'dataValidation')) {
    if (v.attrs.type !== 'list' || out.length >= MAX_DROPDOWNS_PER_SHEET) continue;
    const f = (kid(v, 'formula1')?.text ?? '').trim();
    let items: string[] | null = null;
    const literal = /^"((?:[^"]|"")*)"$/.exec(f);
    if (literal) {
      items = literal[1]!.replace(/""/g, '"').split(',');
    } else {
      const src = /^\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?$/.test(f) ? parseRect(f.replace(/\$/g, '')) : null;
      if (src && (src.r2 - src.r1 + 1) * (src.c2 - src.c1 + 1) <= MAX_ITEMS) {
        items = [];
        for (let r = Math.min(src.r1, src.r2); r <= Math.max(src.r1, src.r2); r += 1) {
          for (let c = Math.min(src.c1, src.c2); c <= Math.max(src.c1, src.c2); c += 1) {
            const cell = cells.get(cellKey(r, c));
            const shown = cell?.input?.startsWith('=') ? cell.value : cell?.input;
            if (typeof shown === 'string' || typeof shown === 'number') items.push(String(shown).replace(/^'/, ''));
          }
        }
      }
    }
    const dd = items ? cleanDropdown({ items, strict: truthy(v.attrs.showErrorMessage) && v.attrs.errorStyle !== 'warning' && v.attrs.errorStyle !== 'information' }) : undefined;
    if (!dd) continue;
    for (const ref of (v.attrs.sqref ?? '').trim().split(/\s+/)) {
      const rect = ref ? parseRect(ref.replace(/\$/g, '')) : null;
      if (rect && out.length < MAX_DROPDOWNS_PER_SHEET) out.push({ ...dd, ...rect });
    }
  }
  return out;
}

function readSheet(
  root: XmlNode, name: string, strings: string[], styles: Styles, theme: string[], date1904: boolean,
): SheetData {
  const sheet: SheetData = {
    name, rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: new Map(),
    colWidths: {}, rowHeights: {}, merges: [], frozenRows: 0, frozenCols: 0,
  };
  let maxRow = -1;
  let maxCol = -1;
  const grow = (r: number, c: number) => { if (r > maxRow) maxRow = r; if (c > maxCol) maxCol = c; };

  const tab = readColor(kid(kid(root, 'sheetPr'), 'tabColor'), theme);
  if (tab) sheet.tabColor = tab;

  const dim = root.children.find((c) => c.name === 'dimension')?.attrs.ref;
  const dimRect = dim ? parseRect(dim.replace(/\$/g, '')) : null;
  if (dimRect) grow(dimRect.r2, dimRect.c2);

  const pane = kid(kid(kid(root, 'sheetViews'), 'sheetView'), 'pane');
  if (pane && (pane.attrs.state === 'frozen' || pane.attrs.state === 'frozenSplit')) {
    const ys = Math.floor(Number(pane.attrs.ySplit ?? 0));
    const xs = Math.floor(Number(pane.attrs.xSplit ?? 0));
    if (ys > 0 && ys < MAX_ROWS) sheet.frozenRows = ys;
    if (xs > 0 && xs < MAX_COLS) sheet.frozenCols = xs;
  }

  // Shared formulas: si → the master cell's formula and position.
  const shared = new Map<string, { f: string; r: number; c: number }>();
  const isDate = (fmt: CellFormat | undefined) => !!fmt?.nf && /[dmyhs]/i.test(fmt.nf.replace(/"[^"]*"|\[[^\]]*\]/g, ''));

  let nextRow = 0;
  for (const rowEl of kids(kid(root, 'sheetData'), 'row')) {
    const r = rowEl.attrs.r ? Number(rowEl.attrs.r) - 1 : nextRow;
    if (!Number.isInteger(r) || r < 0 || r >= MAX_ROWS) throw new Error(`Row ${rowEl.attrs.r} is outside the sheet.`);
    nextRow = r + 1;
    const ht = Number(rowEl.attrs.ht);
    if (truthy(rowEl.attrs.customHeight) && Number.isFinite(ht) && ht >= 0) {
      const px = Math.round((ht * 4) / 3);
      if (px !== DEFAULT_ROW_HEIGHT) sheet.rowHeights[r] = px;
      grow(r, 0);
    }

    let nextCol = 0;
    for (const c of kids(rowEl, 'c')) {
      let col = nextCol;
      if (c.attrs.r) {
        const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(c.attrs.r);
        if (!m) throw new Error(`Bad cell reference "${c.attrs.r}".`);
        col = colIndex(m[1]!);
      }
      if (col < 0 || col >= MAX_COLS) throw new Error(`Column of "${c.attrs.r}" is outside the sheet.`);
      nextCol = col + 1;

      const fmt = styles.xfs[Number(c.attrs.s ?? 0)];
      const t = c.attrs.t ?? 'n';
      const vEl = kid(c, 'v');
      const v = vEl ? vEl.text : undefined;
      const fEl = kid(c, 'f');

      // The cached / literal value.
      let value: Scalar | undefined;
      if (t === 's') {
        const idx = Number(v);
        value = v !== undefined && Number.isInteger(idx) ? strings[idx] ?? '' : undefined;
      } else if (t === 'inlineStr') {
        const is = kid(c, 'is');
        value = is ? stringItem(is) : v !== undefined ? unescapeOoxml(v) : undefined;
      } else if (t === 'str') {
        value = v !== undefined ? unescapeOoxml(v) : undefined;
      } else if (t === 'b') {
        value = v !== undefined ? truthy(v.trim()) : undefined;
      } else if (t === 'e') {
        value = v !== undefined ? toError(v.trim()) : undefined;
      } else if (t === 'd') {
        const n = v !== undefined ? isoToSerial(v.trim()) : null;
        value = n === null ? undefined : n;
      } else {
        const n = v !== undefined ? fileNumber(v) : null;
        value = n === null ? undefined : n;
      }
      if (typeof value === 'number' && date1904 && isDate(fmt)) value += 1462;

      // The formula, if any.
      let formula: string | undefined;
      if (fEl && fEl.attrs.t !== 'dataTable') {
        const own = fEl.text.trim();
        if (fEl.attrs.t === 'shared' && fEl.attrs.si !== undefined) {
          if (own) {
            shared.set(fEl.attrs.si, { f: own, r, c: col });
            formula = own;
          } else {
            const master = shared.get(fEl.attrs.si);
            if (master) formula = shiftFormula(master.f, r - master.r, col - master.c);
          }
        } else if (own) {
          formula = own;
        }
      }

      let cell: CellData | undefined;
      if (formula !== undefined) {
        cell = { input: `=${stripFunctionPrefixes(formula)}` };
        if (value !== undefined) cell.value = value;
      } else if (typeof value === 'number') {
        cell = { input: String(value) };
      } else if (typeof value === 'boolean') {
        cell = { input: value ? 'TRUE' : 'FALSE' };
      } else if (value instanceof CellError) {
        cell = { input: v!.trim(), value };
      } else if (typeof value === 'string' && value !== '') {
        cell = { input: textInput(value) };
      }
      if (fmt) {
        if (!cell) cell = { input: null };
        cell.format = { ...fmt };
      }
      if (cell) {
        sheet.cells.set(cellKey(r, col), cell);
        grow(r, col);
      }
    }
  }

  for (const m of kids(kid(root, 'mergeCells'), 'mergeCell')) {
    const rect = m.attrs.ref ? parseRect(m.attrs.ref.replace(/\$/g, '')) : null;
    if (rect && (rect.r1 !== rect.r2 || rect.c1 !== rect.c2)) {
      sheet.merges.push(rect);
      grow(rect.r2, rect.c2);
    }
  }

  const rules = readColourRules(root, styles);
  if (rules.length > 0) {
    sheet.rules = rules;
    for (const rule of rules) grow(rule.r2, rule.c2);
  }
  const dropdowns = readDropdowns(root, sheet.cells);
  if (dropdowns.length > 0) {
    sheet.dropdowns = dropdowns;
    for (const d of dropdowns) grow(d.r2, d.c2);
  }

  sheet.rows = Math.min(MAX_ROWS, Math.max(DEFAULT_ROWS, maxRow + 1, sheet.frozenRows + 1));
  sheet.cols = Math.min(MAX_COLS, Math.max(DEFAULT_COLS, maxCol + 1, sheet.frozenCols + 1));

  // Column widths last: a <col> often spans to column 16384; stop at the sheet's edge.
  for (const col of kids(kid(root, 'cols'), 'col')) {
    const w = Number(col.attrs.width);
    if (!Number.isFinite(w) || col.attrs.width === undefined) continue;
    const px = Math.round(w * 7 + 5);
    if (px === DEFAULT_COL_WIDTH) continue;
    const min = Math.max(1, Number(col.attrs.min)) - 1;
    const max = Math.min(sheet.cols, Number(col.attrs.max)) - 1;
    for (let c = min; c <= max; c += 1) sheet.colWidths[c] = px;
  }
  return sheet;
}

// ============================================================================
//  3. Writing
// ============================================================================

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** '#rrggbb' → 'FFRRGGBB'. Anything else → null. */
function argb(color: string | undefined): string | null {
  if (!color) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
  return m ? `FF${m[1]!.toUpperCase()}` : null;
}

/** Excel's sheet-name rules: 1–31 characters, none of []:*?/\, no apostrophe at either end, unique. */
function sanitizeSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let base = raw.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').trim();
    if (base === '' || base.toLowerCase() === 'history') base = base ? `${base}_` : `Sheet${i + 1}`;
    base = base.slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

const PLAIN_NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Collects fonts, fills, borders, number formats and cell formats, each once. */
class StyleTable {
  fonts: string[] = ['<font><sz val="10"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font>'];
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  numFmts: { id: number; code: string }[] = [];
  xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  /** Differential formats: what a colour rule lays over a cell (rules.ts). */
  dxfs: string[] = [];
  private dxfIx = new Map<string, number>();
  private index = new Map<string, number>();
  private fontIx = new Map<string, number>();
  private fillIx = new Map<string, number>();
  private borderIx = new Map<string, number>();
  private nfIx = new Map<string, number>();

  private intern(list: string[], ix: Map<string, number>, xml: string): number {
    const hit = ix.get(xml);
    if (hit !== undefined) return hit;
    list.push(xml);
    ix.set(xml, list.length - 1);
    return list.length - 1;
  }

  /** The cellXfs index for this format; 0 for none. */
  xf(f: CellFormat | undefined): number {
    if (!f) return 0;
    const key = JSON.stringify((Object.keys(f) as (keyof CellFormat)[]).sort().map((k) => [k, f[k]]));
    const hit = this.index.get(key);
    if (hit !== undefined) return hit;

    let fontId = 0;
    if (f.b || f.i || f.u || f.s || f.font || f.size || f.color) {
      const color = argb(f.color) ?? 'FF000000';
      const xml = `<font>${f.b ? '<b/>' : ''}${f.i ? '<i/>' : ''}${f.s ? '<strike/>' : ''}${f.u ? '<u/>' : ''}` +
        `<sz val="${f.size && f.size > 0 ? f.size : 10}"/><color rgb="${color}"/>` +
        `<name val="${escapeXml(f.font || 'Arial')}"/><family val="2"/></font>`;
      fontId = xml === this.fonts[0] ? 0 : this.intern(this.fonts, this.fontIx, xml);
    }
    let fillId = 0;
    const bg = argb(f.bg);
    if (bg) {
      fillId = this.intern(this.fills, this.fillIx,
        `<fill><patternFill patternType="solid"><fgColor rgb="${bg}"/><bgColor indexed="64"/></patternFill></fill>`);
    }
    let borderId = 0;
    if (f.bt || f.bb || f.bl || f.br) {
      const side = (tag: string, s: BorderSide | undefined) => s
        ? `<${tag} style="${s.style}"><color rgb="${argb(s.color) ?? 'FF000000'}"/></${tag}>`
        : `<${tag}/>`;
      borderId = this.intern(this.borders, this.borderIx,
        `<border>${side('left', f.bl)}${side('right', f.br)}${side('top', f.bt)}${side('bottom', f.bb)}<diagonal/></border>`);
    }
    let numFmtId = 0;
    if (f.nf && f.nf !== 'General') {
      const builtin = WRITE_BUILTIN[f.nf];
      if (builtin !== undefined) numFmtId = builtin;
      else {
        const hitNf = this.nfIx.get(f.nf);
        if (hitNf !== undefined) numFmtId = hitNf;
        else {
          numFmtId = 164 + this.numFmts.length;
          this.numFmts.push({ id: numFmtId, code: f.nf });
          this.nfIx.set(f.nf, numFmtId);
        }
      }
    }
    const al: string[] = [];
    if (f.ha) al.push(`horizontal="${f.ha}"`);
    if (f.va) al.push(`vertical="${f.va === 'middle' ? 'center' : f.va}"`);
    if (f.wrap === 'wrap') al.push('wrapText="1"');

    const attrs = [`numFmtId="${numFmtId}"`, `fontId="${fontId}"`, `fillId="${fillId}"`, `borderId="${borderId}"`, 'xfId="0"'];
    if (numFmtId) attrs.push('applyNumberFormat="1"');
    if (fontId) attrs.push('applyFont="1"');
    if (fillId) attrs.push('applyFill="1"');
    if (borderId) attrs.push('applyBorder="1"');
    if (al.length) attrs.push('applyAlignment="1"');
    const xml = al.length
      ? `<xf ${attrs.join(' ')}><alignment ${al.join(' ')}/></xf>`
      : `<xf ${attrs.join(' ')}/>`;
    const id = xml === this.xfs[0] ? 0 : this.xfs.push(xml) - 1;
    this.index.set(key, id);
    return id;
  }

  /** The dxfs index for a colour rule's style. In a dxf, a solid fill's colour is bgColor. */
  dxf(s: RuleStyle): number {
    const color = argb(s.color);
    const bg = argb(s.bg);
    const font = s.b || s.i || s.s || color
      ? `<font>${s.b ? '<b/>' : ''}${s.i ? '<i/>' : ''}${s.s ? '<strike/>' : ''}${color ? `<color rgb="${color}"/>` : ''}</font>`
      : '';
    const fill = bg ? `<fill><patternFill patternType="solid"><fgColor rgb="${bg}"/><bgColor rgb="${bg}"/></patternFill></fill>` : '';
    return this.intern(this.dxfs, this.dxfIx, `<dxf>${font}${fill}</dxf>`);
  }

  toXml(): string {
    const nf = this.numFmts.length
      ? `<numFmts count="${this.numFmts.length}">${this.numFmts
        .map((n) => `<numFmt numFmtId="${n.id}" formatCode="${escapeXml(n.code)}"/>`).join('')}</numFmts>`
      : '';
    return `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">${nf}` +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      `<dxfs count="${this.dxfs.length}">${this.dxfs.join('')}</dxfs>` + '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>';
  }
}

class StringTable {
  list: string[] = [];
  count = 0;
  private ix = new Map<string, number>();
  add(s: string): number {
    this.count += 1;
    const hit = this.ix.get(s);
    if (hit !== undefined) return hit;
    this.list.push(s);
    this.ix.set(s, this.list.length - 1);
    return this.list.length - 1;
  }
  toXml(): string {
    const items = this.list.map((s) => {
      const keep = /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '';
      return `<si><t${keep}>${escapeXml(s)}</t></si>`;
    });
    return `${XML_HEAD}<sst xmlns="${NS_MAIN}" count="${this.count}" uniqueCount="${this.list.length}">${items.join('')}</sst>`;
  }
}

const XL_ERRORS = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A']);
const xlError = (e: CellError) => (XL_ERRORS.has(e.code) ? e.code : '#VALUE!');

function numberText(n: number): string {
  return String(n); // shortest text that reads back as exactly this double
}

/** One cell → its <c> element, or '' when there is nothing to write. */
function cellXml(ref: string, cell: CellData, styles: StyleTable, strings: StringTable): string {
  let fmt = cell.format;
  const input = cell.input;
  let body = '';
  let type = '';

  if (input !== null && input.startsWith('=') && input.length > 1 && !formulaIsSafe(input)) {
    // A formula that would call out when the file is opened (DDE, another
    // workbook, a web fetch — safety.ts) goes into the file as the TEXT the
    // person typed, never as a formula. The server refuses a file carrying
    // one (XlsxGuard.cs); writing it as text keeps the spreadsheet saving.
    type = 's'; body = `<v>${strings.add(input)}</v>`;
  } else if (input !== null && input.startsWith('=') && input.length > 1) {
    body = `<f>${escapeXml(addFunctionPrefixes(input.slice(1)))}</f>`;
    const v = cell.value;
    if (typeof v === 'number' && Number.isFinite(v)) body += `<v>${numberText(v)}</v>`;
    else if (typeof v === 'string') { type = 'str'; body += `<v>${escapeXml(v)}</v>`; }
    else if (typeof v === 'boolean') { type = 'b'; body += `<v>${v ? 1 : 0}</v>`; }
    else if (v instanceof CellError) { type = 'e'; body += `<v>${escapeXml(xlError(v))}</v>`; }
  } else if (input !== null && input !== '') {
    const t = input.trim();
    if (input.startsWith("'")) {
      type = 's'; body = `<v>${strings.add(input.slice(1))}</v>`;
    } else if (PLAIN_NUMBER.test(t) && Number.isFinite(Number(t))) {
      body = `<v>${numberText(Number(t))}</v>`;
    } else if (/^(true|false)$/i.test(t)) {
      type = 'b'; body = `<v>${t.toLowerCase() === 'true' ? 1 : 0}</v>`;
    } else {
      // Typed text the app reads as a number or date ("₹1,500", "85%", "24/09/2026"):
      // write the number, and the format the typing implied if none was set.
      const p = parseInput(input, INDIA);
      const v = cell.value !== undefined ? cell.value : p.value;
      if (typeof v === 'number' && Number.isFinite(v)) {
        body = `<v>${numberText(v)}</v>`;
        if (!fmt?.nf && p.format) fmt = { ...fmt, nf: p.format };
      } else if (typeof v === 'boolean') {
        type = 'b'; body = `<v>${v ? 1 : 0}</v>`;
      } else if (v instanceof CellError && v.code === t) {
        type = 'e'; body = `<v>${escapeXml(xlError(v))}</v>`;
      } else {
        type = 's'; body = `<v>${strings.add(input)}</v>`;
      }
    }
  }
  const s = styles.xf(fmt);
  if (!body && !s) return '';
  return `<c r="${ref}"${s ? ` s="${s}"` : ''}${type ? ` t="${type}"` : ''}>${body}</c>`;
}

const CELL_IS_OPERATOR: Partial<Record<RuleKind, string>> = {
  gt: 'greaterThan', gte: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual',
  eq: 'equal', ne: 'notEqual', between: 'between', notBetween: 'notBetween',
};

/** Text as an Excel string constant. */
const xlString = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * One colour rule → its <conditionalFormatting> element ('' if it cannot be
 * written). What a person typed into the rule goes in ONLY as a quoted
 * string or a plain number — never as formula text — and every formula
 * built here is also put through formulaIsSafe, the check the server runs
 * on the file (XlsxGuard.cs); a rule that failed it would be left out of
 * the file rather than cost the save. stopIfTrue: in TatvaOS the first
 * matching rule wins whole (rules.ts); without it Excel would combine them.
 */
function colourRuleXml(rule: Rect & ColourRule, priority: number, styles: StyleTable): string {
  const clean = cleanRule(rule);
  const r1 = Math.min(rule.r1, rule.r2); const r2 = Math.max(rule.r1, rule.r2);
  const c1 = Math.min(rule.c1, rule.c2); const c2 = Math.max(rule.c1, rule.c2);
  if (!clean || r1 < 0 || c1 < 0 || r2 >= XL_MAX_ROWS || c2 >= XL_MAX_COLS) return '';
  const sqref = r1 === r2 && c1 === c2 ? cellName(r1, c1) : `${cellName(r1, c1)}:${cellName(r2, c2)}`;
  const tl = cellName(r1, c1); // formulas are written for the top-left cell, relative
  const number = (s: string) => { const n = parseNumberText(s, INDIA); return n !== null && Number.isFinite(n) ? numberText(n) : xlString(s); };
  const a = clean.a ?? ''; const qa = xlString(a);
  let attrs: string; let formulas: string[];
  switch (clean.kind) {
    case 'contains': attrs = `type="containsText" operator="containsText" text="${escapeXml(a)}"`; formulas = [`NOT(ISERROR(SEARCH(${qa},${tl})))`]; break;
    case 'notContains': attrs = `type="notContainsText" operator="notContains" text="${escapeXml(a)}"`; formulas = [`ISERROR(SEARCH(${qa},${tl}))`]; break;
    case 'startsWith': attrs = `type="beginsWith" operator="beginsWith" text="${escapeXml(a)}"`; formulas = [`LEFT(${tl},LEN(${qa}))=${qa}`]; break;
    case 'endsWith': attrs = `type="endsWith" operator="endsWith" text="${escapeXml(a)}"`; formulas = [`RIGHT(${tl},LEN(${qa}))=${qa}`]; break;
    case 'empty': attrs = 'type="containsBlanks"'; formulas = [`LEN(TRIM(${tl}))=0`]; break;
    case 'notEmpty': attrs = 'type="notContainsBlanks"'; formulas = [`LEN(TRIM(${tl}))>0`]; break;
    default:
      attrs = `type="cellIs" operator="${CELL_IS_OPERATOR[clean.kind]}"`;
      formulas = operandCount(clean.kind) === 2 ? [number(a), number(clean.b ?? '')] : [number(a)];
  }
  if (!formulas.every((f) => formulaIsSafe(f))) return '';
  const dxfId = styles.dxf(clean.style);
  return `<conditionalFormatting sqref="${sqref}"><cfRule ${attrs} dxfId="${dxfId}" priority="${priority}" stopIfTrue="1">` +
    `${formulas.map((f) => `<formula>${escapeXml(f)}</formula>`).join('')}</cfRule></conditionalFormatting>`;
}

/** Excel's limit on a list typed into the rule itself ("a,b,c"). */
const XL_LIST_MAX = 255;

/**
 * A sheet's dropdowns → one <dataValidations> ('' if none can be written).
 * Written as a list typed into the rule, so the file needs no helper sheet.
 * That form holds at most 255 characters and cannot hold a comma inside an
 * item: a dropdown that does not fit is left out of the FILE only — the
 * values in its cells are written as ever, and it stays in TatvaOS. Strict
 * → Excel's "stop" message; loose → no message, the nearest Excel has to
 * TatvaOS's red corner. The list goes in as a quoted string, and through
 * formulaIsSafe, like a colour rule's operands (colourRuleXml).
 */
function dropdownsXml(list: (Rect & Dropdown)[]): string {
  const out: string[] = [];
  for (const d of list) {
    const clean = cleanDropdown(d);
    const r1 = Math.min(d.r1, d.r2); const r2 = Math.max(d.r1, d.r2);
    const c1 = Math.min(d.c1, d.c2); const c2 = Math.max(d.c1, d.c2);
    if (!clean || r1 < 0 || c1 < 0 || r2 >= XL_MAX_ROWS || c2 >= XL_MAX_COLS) continue;
    if (clean.items.some((it) => it.includes(','))) continue;
    const literal = clean.items.join(',');
    if (literal.length > XL_LIST_MAX) continue;
    const formula = xlString(literal);
    if (!formulaIsSafe(formula)) continue;
    const sqref = r1 === r2 && c1 === c2 ? cellName(r1, c1) : `${cellName(r1, c1)}:${cellName(r2, c2)}`;
    out.push(`<dataValidation type="list" allowBlank="1" showErrorMessage="${clean.strict ? 1 : 0}" sqref="${sqref}">` +
      `<formula1>${escapeXml(formula)}</formula1></dataValidation>`);
  }
  return out.length ? `<dataValidations count="${out.length}">${out.join('')}</dataValidations>` : '';
}

function sheetXml(sheet: SheetData, selected: boolean, styles: StyleTable, strings: StringTable): string {
  // Rows, then cells within each row, in order: Excel insists.
  const byRow = new Map<number, [number, CellData][]>();
  let maxR = -1; let maxC = -1;
  for (const [k, cell] of sheet.cells) {
    const [r, c] = parseCellKey(k);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= XL_MAX_ROWS || c >= XL_MAX_COLS) continue;
    let list = byRow.get(r);
    if (!list) { list = []; byRow.set(r, list); }
    list.push([c, cell]);
  }
  for (const k of Object.keys(sheet.rowHeights)) {
    const r = Number(k);
    if (Number.isInteger(r) && r >= 0 && r < XL_MAX_ROWS && !byRow.has(r)) byRow.set(r, []);
  }

  const rowsXml: string[] = [];
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    const cells = byRow.get(r)!.sort((a, b) => a[0] - b[0]);
    const cx: string[] = [];
    for (const [c, cell] of cells) {
      const x = cellXml(cellName(r, c), cell, styles, strings);
      if (x) { cx.push(x); if (c > maxC) maxC = c; }
    }
    const h = sheet.rowHeights[r];
    const ht = h !== undefined && Number.isFinite(h) && h >= 0 ? ` ht="${Math.round(h * 0.75 * 100) / 100}" customHeight="1"` : '';
    if (!cx.length && !ht) continue;
    if (cx.length) maxR = Math.max(maxR, r);
    rowsXml.push(`<row r="${r + 1}"${ht}>${cx.join('')}</row>`);
  }

  const parts: string[] = [`${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`];
  const tab = argb(sheet.tabColor);
  if (tab) parts.push(`<sheetPr><tabColor rgb="${tab}"/></sheetPr>`);
  parts.push(`<dimension ref="${maxR < 0 ? 'A1' : `A1:${cellName(maxR, Math.max(0, maxC))}`}"/>`);

  const fr = Math.max(0, Math.floor(sheet.frozenRows || 0));
  const fc = Math.max(0, Math.floor(sheet.frozenCols || 0));
  let view = `<sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}`;
  if (fr || fc) {
    const pane = fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight';
    view += `><pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${cellName(fr, fc)}"` +
      ` activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${cellName(fr, fc)}"` +
      ` sqref="${cellName(fr, fc)}"/></sheetView>`;
  } else {
    view += '/>';
  }
  parts.push(`<sheetViews>${view}</sheetViews>`);

  const toChars = (px: number) => Math.round((Math.max(0, px - 5) / 7) * 256) / 256;
  parts.push(`<sheetFormatPr defaultColWidth="${toChars(DEFAULT_COL_WIDTH)}" defaultRowHeight="${DEFAULT_ROW_HEIGHT * 0.75}"/>`);

  // Consecutive columns with the same width share one <col>.
  const widths = Object.entries(sheet.colWidths)
    .map(([k, v]) => [Number(k), v] as [number, number])
    .filter(([c, v]) => Number.isInteger(c) && c >= 0 && c < XL_MAX_COLS && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a[0] - b[0]);
  if (widths.length) {
    const cols: string[] = [];
    let i = 0;
    while (i < widths.length) {
      const [start, w] = widths[i]!;
      let end = start;
      while (i + 1 < widths.length && widths[i + 1]![0] === end + 1 && widths[i + 1]![1] === w) { i += 1; end += 1; }
      cols.push(`<col min="${start + 1}" max="${end + 1}" width="${toChars(w)}" customWidth="1"/>`);
      i += 1;
    }
    parts.push(`<cols>${cols.join('')}</cols>`);
  }

  parts.push(rowsXml.length ? `<sheetData>${rowsXml.join('')}</sheetData>` : '<sheetData/>');

  const merges = sheet.merges
    .map((m: Rect) => ({ r1: Math.min(m.r1, m.r2), c1: Math.min(m.c1, m.c2), r2: Math.max(m.r1, m.r2), c2: Math.max(m.c1, m.c2) }))
    .filter((m) => (m.r1 !== m.r2 || m.c1 !== m.c2) && m.r1 >= 0 && m.c1 >= 0 && m.r2 < XL_MAX_ROWS && m.c2 < XL_MAX_COLS);
  if (merges.length) {
    parts.push(`<mergeCells count="${merges.length}">${merges
      .map((m) => `<mergeCell ref="${cellName(m.r1, m.c1)}:${cellName(m.r2, m.c2)}"/>`).join('')}</mergeCells>`);
  }
  // After mergeCells and before pageMargins: the order the schema requires
  // (conditionalFormatting, then dataValidations).
  parts.push(...(sheet.rules ?? []).map((rule, i) => colourRuleXml(rule, i + 1, styles)).filter((x) => x !== ''));
  const lists = dropdownsXml(sheet.dropdowns ?? []);
  if (lists) parts.push(lists);
  parts.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>');
  return parts.join('');
}

/** Write a workbook snapshot as an .xlsx file. */
export async function writeXlsx(wb: WorkbookData): Promise<Uint8Array> {
  const sheets: SheetData[] = wb.sheets.length ? wb.sheets : [{
    name: 'Sheet1', rows: DEFAULT_ROWS, cols: DEFAULT_COLS, cells: new Map(),
    colWidths: {}, rowHeights: {}, merges: [], frozenRows: 0, frozenCols: 0,
  }];
  const names = sanitizeSheetNames(sheets.map((s) => s.name));
  // A workbook must show at least one sheet.
  let active = sheets.findIndex((s) => !s.hidden);
  const forceVisible = active < 0;
  if (forceVisible) active = 0;

  const styles = new StyleTable();
  const strings = new StringTable();
  const enc = new TextEncoder();
  const files: { name: string; data: Uint8Array }[] = [];
  const sheetFiles = sheets.map((s, i) => sheetXml(s, i === active, styles, strings));

  const overrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  files.push({
    name: '[Content_Types].xml',
    data: enc.encode(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      `${overrides.join('')}` +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>'),
  });
  files.push({
    name: '_rels/.rels',
    data: enc.encode(`${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/>` +
      '</Relationships>'),
  });
  files.push({
    name: 'docProps/app.xml',
    data: enc.encode(`${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
      '<Application>TatvaOS Sheets</Application></Properties>'),
  });

  const sheetEls = sheets.map((s, i) => {
    const state = s.hidden && !(forceVisible && i === 0) ? ' state="hidden"' : '';
    return `<sheet name="${escapeXml(names[i]!)}" sheetId="${i + 1}"${state} r:id="rId${i + 1}"/>`;
  });
  files.push({
    name: 'xl/workbook.xml',
    data: enc.encode(`${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      `<workbookPr/><bookViews><workbookView activeTab="${active}"/></bookViews>` +
      `<sheets>${sheetEls.join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`),
  });
  const n = sheets.length;
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: enc.encode(`${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
      sheets.map((_, i) =>
        `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${n + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${n + 2}" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>` +
      '</Relationships>'),
  });
  files.push({ name: 'xl/styles.xml', data: enc.encode(styles.toXml()) });
  files.push({ name: 'xl/sharedStrings.xml', data: enc.encode(strings.toXml()) });
  sheetFiles.forEach((x, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(x) }));

  return writeZip(files);
}
