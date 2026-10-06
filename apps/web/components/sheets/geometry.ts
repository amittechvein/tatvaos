// ============================================================================
//  Grid geometry: where every row and column is, in pixels.
//
//  Positions are prefix sums, so "which column is at x = 7,350?" is a
//  binary search and a 100,000-row sheet costs one array of numbers, not
//  100,000 DOM nodes. Only what is on screen is ever drawn (paint.ts).
//
//  Three coordinate spaces, kept apart deliberately:
//    sheet   x/y from the top-left of cell A1, ignoring scrolling
//    view    x/y inside the canvas, headers included
//    cell    row/column indexes
//  Frozen rows and columns never scroll: they occupy the first
//  frozenW × frozenH of sheet space and are always drawn at the top-left.
// ============================================================================

import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from '@/lib/sheets/workbook';

export const ROW_HEADER_W = 46;
export const COL_HEADER_H = 24;

export class Geometry {
  readonly rows: number;
  readonly cols: number;
  readonly frozenRows: number;
  readonly frozenCols: number;
  /** colX[c] = sheet x of column c's left edge; colX[cols] = total width. */
  readonly colX: Float64Array;
  readonly rowY: Float64Array;
  readonly zoom: number;

  constructor(opts: {
    rows: number; cols: number; frozenRows: number; frozenCols: number; zoom: number;
    colWidth: (c: number) => number | undefined; rowHeight: (r: number) => number | undefined;
  }) {
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.zoom = opts.zoom;
    this.frozenRows = Math.min(opts.frozenRows, opts.rows);
    this.frozenCols = Math.min(opts.frozenCols, opts.cols);
    this.colX = new Float64Array(opts.cols + 1);
    for (let c = 0; c < opts.cols; c += 1) {
      this.colX[c + 1] = this.colX[c]! + (opts.colWidth(c) ?? DEFAULT_COL_WIDTH) * opts.zoom;
    }
    this.rowY = new Float64Array(opts.rows + 1);
    for (let r = 0; r < opts.rows; r += 1) {
      this.rowY[r + 1] = this.rowY[r]! + (opts.rowHeight(r) ?? DEFAULT_ROW_HEIGHT) * opts.zoom;
    }
  }

  get headerW() { return ROW_HEADER_W * Math.min(1, Math.max(0.8, this.zoom)); }
  get headerH() { return COL_HEADER_H * Math.min(1, Math.max(0.8, this.zoom)); }
  get totalW() { return this.colX[this.cols]!; }
  get totalH() { return this.rowY[this.rows]!; }
  get frozenW() { return this.colX[this.frozenCols]!; }
  get frozenH() { return this.rowY[this.frozenRows]!; }

  colWidth(c: number) { return this.colX[c + 1]! - this.colX[c]!; }
  rowHeight(r: number) { return this.rowY[r + 1]! - this.rowY[r]!; }

  /** The column containing sheet x (clamped to the grid). */
  colAt(x: number): number { return search(this.colX, x, this.cols); }
  rowAt(y: number): number { return search(this.rowY, y, this.rows); }

  /** Sheet x → view x, given the scroll offset. */
  viewX(sheetX: number, scrollLeft: number): number {
    return this.headerW + (sheetX < this.frozenW ? sheetX : sheetX - scrollLeft);
  }
  viewY(sheetY: number, scrollTop: number): number {
    return this.headerH + (sheetY < this.frozenH ? sheetY : sheetY - scrollTop);
  }

  /** View x → sheet x. A point over the frozen band stays in the frozen band. */
  sheetX(viewX: number, scrollLeft: number): number {
    const x = viewX - this.headerW;
    return x < this.frozenW ? x : x + scrollLeft;
  }
  sheetY(viewY: number, scrollTop: number): number {
    const y = viewY - this.headerH;
    return y < this.frozenH ? y : y + scrollTop;
  }

  /** The scrolling columns visible in a view of this width (frozen ones excluded). */
  visibleCols(scrollLeft: number, viewW: number): [number, number] {
    const from = this.colAt(this.frozenW + scrollLeft);
    const to = this.colAt(this.frozenW + scrollLeft + Math.max(0, viewW - this.headerW - this.frozenW));
    return [Math.max(from, this.frozenCols), to];
  }
  visibleRows(scrollTop: number, viewH: number): [number, number] {
    const from = this.rowAt(this.frozenH + scrollTop);
    const to = this.rowAt(this.frozenH + scrollTop + Math.max(0, viewH - this.headerH - this.frozenH));
    return [Math.max(from, this.frozenRows), to];
  }

  /**
   * The scroll offset that brings a cell fully into view, or null when it
   * already is. Frozen cells are always in view.
   */
  scrollToShow(r: number, c: number, scrollLeft: number, scrollTop: number, viewW: number, viewH: number):
    { left: number; top: number } | null {
    let left = scrollLeft;
    let top = scrollTop;
    const bodyW = viewW - this.headerW - this.frozenW;
    const bodyH = viewH - this.headerH - this.frozenH;
    if (c >= this.frozenCols) {
      const x1 = this.colX[c]! - this.frozenW;
      const x2 = this.colX[c + 1]! - this.frozenW;
      if (x1 < left) left = x1;
      else if (x2 > left + bodyW) left = Math.max(x1 - Math.max(0, bodyW - (x2 - x1)), x2 - bodyW);
    }
    if (r >= this.frozenRows) {
      const y1 = this.rowY[r]! - this.frozenH;
      const y2 = this.rowY[r + 1]! - this.frozenH;
      if (y1 < top) top = y1;
      else if (y2 > top + bodyH) top = y2 - bodyH;
    }
    left = Math.max(0, left);
    top = Math.max(0, top);
    return left === scrollLeft && top === scrollTop ? null : { left, top };
  }
}

/** Largest i with arr[i] <= x, clamped to [0, n-1]. */
function search(arr: Float64Array, x: number, n: number): number {
  if (n <= 0) return 0;
  if (x <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid]! <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}
