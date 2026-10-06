// ============================================================================
//  A function's arguments, evaluated only when asked for.
//
//  Every function gets its arguments this way, so IF, IFERROR, AND, OR,
//  IFS, SWITCH and CHOOSE short-circuit for free: IF(A1=0, 0, 1/A1) never
//  evaluates 1/A1 when A1 is zero. Each argument is evaluated at most once.
// ============================================================================

import type { Node } from '../parser';
import type { EvalResult } from '../types';

export class Args {
  private readonly nodes: Node[];
  private readonly evalFn: (n: Node) => EvalResult;
  private readonly cache: (EvalResult | undefined)[];
  private readonly done: boolean[];

  constructor(nodes: Node[], evalFn: (n: Node) => EvalResult) {
    this.nodes = nodes;
    this.evalFn = evalFn;
    this.cache = new Array(nodes.length);
    this.done = new Array(nodes.length).fill(false);
  }

  get length(): number { return this.nodes.length; }

  /** Argument i, evaluated. Missing (IF(A1,,1)) and past-the-end are both null. */
  get(i: number): EvalResult {
    if (i >= this.nodes.length) return null;
    if (!this.done[i]) {
      this.cache[i] = this.evalFn(this.nodes[i]!);
      this.done[i] = true;
    }
    return this.cache[i] as EvalResult;
  }

  /** Was argument i left out — absent, or written as nothing between commas? */
  missing(i: number): boolean {
    const n = this.nodes[i];
    return n === undefined || n.t === 'missing';
  }

  /** All arguments, evaluated. For functions that need every one anyway (SUM). */
  all(): EvalResult[] {
    const out: EvalResult[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) out.push(this.get(i));
    return out;
  }
}
