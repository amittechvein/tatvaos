// ============================================================================
//  Info: questions about a value — is it blank, a number, an error, a formula?
//
//  The IS… checks never pass an error on: ISERROR(1/0) is TRUE, not
//  #DIV/0!. That is their whole job, so each one reads its argument's value
//  and inspects it rather than converting it. (ISEVEN and ISODD are the
//  exception: they need a number, as in Sheets, so an error goes through.)
//
//  BLANK MEANS NOTHING IN THE CELL. A formula that returns "" is not blank
//  in Sheets — ISBLANK is FALSE for it — and people rely on the difference
//  to tell "not filled in" from "filled in by a formula that found nothing".
// ============================================================================

import { CellError, isError, isMatrix, isRef, type EvalResult, type Scalar } from '../types';
import { toNumber } from '../values';
import { NA } from './helpers';
import type { FnDef, FnContext } from './index';

/** A predicate over one value. A range of several cells is judged by its #VALUE!, as Sheets does outside an array formula. */
function is(test: (v: Scalar) => boolean, sig: string, desc: string): FnDef {
  return {
    min: 1, max: 1, category: 'Info', sig, desc,
    fn: (a, ctx) => test(ctx.scalar(a.get(0))),
  };
}

/** ISEVEN / ISODD: the argument must be a number (or read as one); the fraction is dropped. */
function parity(odd: boolean, name: string): FnDef {
  return {
    min: 1, max: 1, category: 'Info', sig: `${name}(value)`,
    desc: odd ? 'TRUE when the number is odd.' : 'TRUE when the number is even.',
    fn: (a, ctx) => {
      const v = ctx.scalar(a.get(0));
      if (isError(v)) return v;
      if (typeof v === 'boolean') return new CellError('#VALUE!', `${name} expects a number, but got ${v ? 'TRUE' : 'FALSE'}.`);
      const n = toNumber(v, ctx.locale);
      if (isError(n)) return new CellError('#VALUE!', `${name} expects a number, but got "${v}".`);
      const whole = Math.trunc(n);
      return (Math.abs(whole) % 2 === 1) === odd;
    },
  };
}

/** The numbers ERROR.TYPE gives, as Sheets numbers them. */
const ERROR_NUMBERS: Record<string, number> = {
  '#NULL!': 1, '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4, '#NAME?': 5, '#NUM!': 6, '#N/A': 7, '#ERROR!': 8,
};

export const INFO: Record<string, FnDef> = {
  ISBLANK: is((v) => v === null, 'ISBLANK(value)',
    'TRUE when the cell is empty. A formula that shows nothing ("") is not empty.'),
  ISNUMBER: is((v) => typeof v === 'number', 'ISNUMBER(value)', 'TRUE when the value is a number (dates and times are numbers).'),
  ISTEXT: is((v) => typeof v === 'string', 'ISTEXT(value)', 'TRUE when the value is text.'),
  ISNONTEXT: is((v) => typeof v !== 'string', 'ISNONTEXT(value)', 'TRUE when the value is not text — empty cells included.'),
  ISLOGICAL: is((v) => typeof v === 'boolean', 'ISLOGICAL(value)', 'TRUE when the value is TRUE or FALSE.'),
  ISERROR: is((v) => isError(v), 'ISERROR(value)', 'TRUE when the value is any error.'),
  ISERR: is((v) => isError(v) && v.code !== '#N/A', 'ISERR(value)', 'TRUE when the value is an error other than #N/A.'),
  ISNA: is((v) => isError(v) && v.code === '#N/A', 'ISNA(value)', 'TRUE when the value is #N/A — a lookup that found nothing.'),
  ISEVEN: parity(false, 'ISEVEN'),
  ISODD: parity(true, 'ISODD'),
  ISREF: {
    min: 1, max: 1, category: 'Info', sig: 'ISREF(value)', desc: 'TRUE when the value is a cell or range reference.',
    fn: (a) => isRef(a.get(0)),
  },
  ISFORMULA: {
    min: 1, max: 1, category: 'Info', sig: 'ISFORMULA(cell)', desc: 'TRUE when the cell holds a formula.',
    fn: (a, ctx) => {
      const v = a.get(0);
      if (isError(v)) return v;
      if (!isRef(v)) return NA('ISFORMULA needs a cell reference, such as A1.');
      // A range answers for its top-left cell. The reference is already
      // recorded, so editing that cell recalculates this formula.
      return ctx.engine.isFormula(v.sheet, v.r1, v.c1);
    },
  },
  'ERROR.TYPE': {
    min: 1, max: 1, category: 'Info', sig: 'ERROR.TYPE(value)',
    desc: 'A number for the kind of error: 2 for #DIV/0!, 7 for #N/A, and so on. #N/A if it is not an error.',
    fn: (a, ctx) => {
      const v = ctx.scalar(a.get(0));
      if (!isError(v)) return NA('ERROR.TYPE was given a value that is not an error.');
      return ERROR_NUMBERS[v.code] ?? NA();
    },
  },
  TYPE: {
    min: 1, max: 1, category: 'Info', sig: 'TYPE(value)',
    desc: 'What kind of value it is: 1 number (or empty), 2 text, 4 TRUE/FALSE, 16 error, 64 a range or array.',
    fn: (a, ctx) => typeOf(a.get(0), ctx),
  },
};

function typeOf(v: EvalResult, ctx: FnContext): number {
  if (isMatrix(v) && !(v.rows.length === 1 && v.rows[0]!.length === 1)) return 64;
  if (isRef(v) && !(v.r1 === v.r2 && v.c1 === v.c2)) return 64;
  const s = ctx.scalar(v);
  if (s === null || typeof s === 'number') return 1;
  if (typeof s === 'string') return 2;
  if (typeof s === 'boolean') return 4;
  return 16;
}
