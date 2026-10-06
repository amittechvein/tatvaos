// ============================================================================
//  The function registry.
//
//  One file per family; this file only joins them. Adding a function means
//  adding an entry to a family's table — the parser, the evaluator and the
//  formula bar's suggestions all read FUNCTIONS, so nothing else changes.
// ============================================================================

import type { Engine } from '../engine';
import type { EvalResult, Locale, RefValue, Scalar } from '../types';
import type { Args } from './args';

import { MATH } from './math';
import { LOGICAL } from './logical';
import { CONDITIONAL } from './conditional';
import { LOOKUP } from './lookup';
import { TEXT } from './text';
import { DATE } from './date';
import { STATS } from './stats';
import { INFO } from './info';

export type Category = 'Math' | 'Logical' | 'Lookup' | 'Text' | 'Date' | 'Statistical' | 'Info';

export interface FnContext {
  engine: Engine;
  locale: Locale;
  /** The cell being calculated. */
  sheet: string;
  row: number;
  col: number;
  now: () => Date;
  /** One value from an argument (a single cell, or #VALUE! for a range). */
  scalar: (r: EvalResult) => Scalar;
  /** All values of a range or array argument, rows of columns. A scalar is 1×1. */
  grid: (r: EvalResult) => Scalar[][];
  size: (sheet: string) => { rows: number; cols: number };
  cell: (sheet: string, row: number, col: number) => Scalar;
  /** Record that the formula read a reference it built itself (INDEX returning a cell). */
  record: (ref: RefValue) => void;
}

export interface FnDef {
  min: number;
  max: number;
  /** Recalculated on every recalculation: TODAY, NOW, RAND. */
  volatile?: boolean;
  category: Category;
  /** Shown while typing: "SUMIF(range, criterion, [sum_range])". */
  sig: string;
  /** One sentence, plain words. */
  desc: string;
  fn: (args: Args, ctx: FnContext) => EvalResult;
}

export const FUNCTIONS: Record<string, FnDef> = {
  ...MATH, ...LOGICAL, ...CONDITIONAL, ...LOOKUP, ...TEXT, ...DATE, ...STATS, ...INFO,
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
