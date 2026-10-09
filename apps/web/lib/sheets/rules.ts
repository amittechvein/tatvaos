// ============================================================================
//  Colour rules — conditional formatting, Sheets' "Format > Colour rules".
//
//  A rule says: in this range, when a cell's value meets this condition,
//  paint it this way. "Fees due greater than 0 → red fill"; "Status is
//  Absent → orange"; "blank → yellow". Amit's Phase 2, 9 Oct 2026.
//
//  WHAT A RULE IS NOT. It never changes a cell's stored format: the style is
//  laid over the cell's own format when it is painted, printed or exported,
//  and goes away as soon as the value stops matching. Deleting the rule
//  leaves every cell exactly as it was.
//
//  ORDER. Several rules may cover one cell; the FIRST in the list that
//  matches wins, whole (Google Sheets' behaviour; Excel's "stop if true").
//  The list order is the order rules were added, and the dialog shows it.
//
//  NOTHING HERE EVALUATES A FORMULA. Conditions compare the cell's
//  calculated value with plain text or a number the person typed. In the
//  .xlsx a rule is written with a quoted string or a number only (xlsx.ts),
//  so nothing a person types into a rule can become a formula in the file.
// ============================================================================

import { isError, type Locale, type Scalar } from './engine/types';
import { parseNumberText } from './engine/input';
import type { Rect } from './engine/address';
import type { CellFormat } from './workbook';

export type RuleKind =
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | 'between' | 'notBetween'
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith'
  | 'empty' | 'notEmpty';

export const RULE_KINDS: readonly RuleKind[] = [
  'gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between', 'notBetween',
  'contains', 'notContains', 'startsWith', 'endsWith', 'empty', 'notEmpty',
];

/** How the dialog names each condition. */
export const RULE_LABELS: Record<RuleKind, string> = {
  gt: 'Greater than', gte: 'Greater than or equal to', lt: 'Less than', lte: 'Less than or equal to',
  eq: 'Is equal to', ne: 'Is not equal to', between: 'Is between', notBetween: 'Is not between',
  contains: 'Text contains', notContains: 'Text does not contain',
  startsWith: 'Text starts with', endsWith: 'Text ends with',
  empty: 'Is empty', notEmpty: 'Is not empty',
};

/** How many values a condition needs: none ("is empty"), one, or two ("between"). */
export function operandCount(kind: RuleKind): 0 | 1 | 2 {
  if (kind === 'empty' || kind === 'notEmpty') return 0;
  if (kind === 'between' || kind === 'notBetween') return 2;
  return 1;
}

/** What a matching cell looks like. Only these — a rule cannot resize or re-format numbers. */
export interface RuleStyle {
  bg?: string;      // fill, #rrggbb
  color?: string;   // text colour, #rrggbb
  b?: boolean;
  i?: boolean;
  s?: boolean;      // strikethrough
}

export interface ColourRule {
  kind: RuleKind;
  /** The value(s) to compare with, as the person typed them. */
  a?: string;
  b?: string;
  style: RuleStyle;
}

/** A rule placed on a sheet: its range as positions (the model stores ids). */
export interface PlacedRule extends ColourRule, Rect { id: string }

/** The style a new rule starts with: light red fill, dark red text. */
export const DEFAULT_RULE_STYLE: RuleStyle = { bg: '#f4c7c3', color: '#a50e0e' };

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_OPERAND = 500;

/**
 * A rule rebuilt from known fields with the right types, or undefined. The
 * Y.Doc is whatever collaborators' browsers wrote (Mr. Singh, 25 Sept 2026):
 * a rule with an unknown kind, a missing operand or no visible style is
 * dropped rather than half-applied.
 */
export function cleanRule(raw: unknown): ColourRule | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!RULE_KINDS.includes(r.kind as RuleKind)) return undefined;
  const kind = r.kind as RuleKind;
  const operand = (v: unknown) => (typeof v === 'string' && v.length <= MAX_OPERAND ? v : undefined);
  const a = operand(r.a);
  const b = operand(r.b);
  const need = operandCount(kind);
  if (need >= 1 && (a === undefined || a.trim() === '')) return undefined;
  if (need === 2 && (b === undefined || b.trim() === '')) return undefined;
  const style = cleanStyle(r.style);
  if (!style) return undefined;
  const out: ColourRule = { kind, style };
  if (need >= 1) out.a = a;
  if (need === 2) out.b = b;
  return out;
}

export function cleanStyle(raw: unknown): RuleStyle | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const out: RuleStyle = {};
  if (typeof s.bg === 'string' && HEX.test(s.bg)) out.bg = s.bg;
  if (typeof s.color === 'string' && HEX.test(s.color)) out.color = s.color;
  for (const k of ['b', 'i', 's'] as const) if (s[k] === true) out[k] = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A typed operand as a number ("1,25,000", "₹500", "15/08/2026"), or null if it is text. */
function operandNumber(s: string | undefined, locale: Locale): number | null {
  return s === undefined ? null : parseNumberText(s, locale);
}

const isBlank = (v: Scalar) => v === null || v === '';

/**
 * Does a cell's calculated value meet the rule? Numbers compare as numbers
 * when the operand reads as one (dates included, as serials); otherwise the
 * comparison is on text, ignoring case — "absent" matches "Absent". An error
 * value (#DIV/0!) matches nothing but "is not empty".
 */
export function ruleMatches(rule: ColourRule, value: Scalar, locale: Locale): boolean {
  if (rule.kind === 'empty') return isBlank(value);
  if (rule.kind === 'notEmpty') return !isBlank(value);
  if (isError(value)) return false;

  const text = (value === null ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value)).toLowerCase();
  const a = (rule.a ?? '').trim();
  const na = operandNumber(a, locale);
  const nb = operandNumber(rule.b?.trim(), locale);
  const num = typeof value === 'number' ? value : null;

  switch (rule.kind) {
    case 'contains': return a !== '' && text.includes(a.toLowerCase());
    case 'notContains': return a === '' || !text.includes(a.toLowerCase());
    case 'startsWith': return a !== '' && text.startsWith(a.toLowerCase());
    case 'endsWith': return a !== '' && text.endsWith(a.toLowerCase());
    case 'eq': return num !== null && na !== null ? num === na : !isBlank(value) && text === a.toLowerCase();
    case 'ne': return num !== null && na !== null ? num !== na : text !== a.toLowerCase();
    default: break;
  }
  // The rest compare sizes: only a number against a number.
  if (num === null || na === null) return false;
  switch (rule.kind) {
    case 'gt': return num > na;
    case 'gte': return num >= na;
    case 'lt': return num < na;
    case 'lte': return num <= na;
    case 'between':
    case 'notBetween': {
      if (nb === null) return false;
      const inside = num >= Math.min(na, nb) && num <= Math.max(na, nb);
      return rule.kind === 'between' ? inside : !inside;
    }
    default: return false;
  }
}

/** The style the first matching rule over (r, c) lays on the cell, if any. */
export function ruleStyleAt(rules: readonly PlacedRule[], r: number, c: number, value: () => Scalar, locale: Locale): RuleStyle | undefined {
  let v: Scalar | undefined;
  for (const rule of rules) {
    if (r < rule.r1 || r > rule.r2 || c < rule.c1 || c > rule.c2) continue;
    v ??= value();
    if (ruleMatches(rule, v, locale)) return rule.style;
  }
  return undefined;
}

/**
 * A cell's own format with a matching rule's style laid over it — the one
 * place the grid and print apply rules, so they cannot disagree. The cell's
 * stored format is never changed (see the top of this file).
 */
export function withRuleStyle(f: CellFormat | undefined, s: RuleStyle | undefined): CellFormat | undefined {
  return s ? { ...f, ...s } : f;
}

/** A short sentence for the rules list: "Greater than 0", "Is between 10 and 20". */
export function describeRule(rule: ColourRule): string {
  const label = RULE_LABELS[rule.kind];
  const n = operandCount(rule.kind);
  if (n === 0) return label;
  if (n === 2) return `${label} ${rule.a} and ${rule.b}`;
  return `${label} ${rule.a}`;
}
