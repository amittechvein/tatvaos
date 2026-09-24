// ============================================================================
//  Painting the grid onto a canvas.
//
//  Only what is visible is drawn: the frozen corner, the frozen top rows,
//  the frozen left columns, and the scrolling body — four regions, each
//  clipped to its rectangle, each drawn by the same drawRegion(). A full
//  repaint touches a few hundred cells whether the sheet has a thousand
//  rows or a hundred thousand.
//
//  Order within a region matters and mirrors Google Sheets:
//    1. fills        2. grid lines      3. text (which may overflow into
//    empty neighbours)                  4. borders     5. merges on top
//  then, over everything: selection, colleagues' cursors, the copy outline.
// ============================================================================

import { formatValue } from '@/lib/sheets/engine/format';
import { colName } from '@/lib/sheets/engine/address';
import { isError, type Locale, type Scalar } from '@/lib/sheets/engine/types';
import type { CellFormat, BorderSide } from '@/lib/sheets/workbook';
import type { Rect } from '@/lib/sheets/engine/address';
import type { Geometry } from './geometry';

export interface PaintSource {
  value(r: number, c: number): Scalar;
  format(r: number, c: number): CellFormat | undefined;
  merges: (Rect & { id: string })[];
  locale: Locale;
  /** Cells with an open comment thread get the orange corner Sheets draws. */
  hasComment?: (r: number, c: number) => boolean;
}

export interface Remote { name: string; color: string; rect: Rect; active: { r: number; c: number } }

export interface PaintState {
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
  selection: Rect;
  active: { r: number; c: number };
  /** Whole rows/columns selected (drives header highlighting). */
  rowSel: boolean;
  colSel: boolean;
  copyRect: Rect | null;
  fillPreview: Rect | null;
  remotes: Remote[];
  /** References of the formula being edited, drawn as coloured boxes. */
  refBoxes: { rect: Rect; color: string }[];
  dark: boolean;
}

const LIGHT = {
  bg: '#ffffff', grid: '#e2e3e3', header: '#f8f9fa', headerText: '#5f6368', headerLine: '#c0c0c0',
  headerSel: '#d3e3fd', headerSelText: '#0b57d0', text: '#000000', sel: 'rgba(14,101,235,0.10)', selLine: '#1a73e8',
  frozenLine: '#bdc1c6',
};
const DARK = {
  bg: '#1f1f1f', grid: '#3c4043', header: '#2a2a2a', headerText: '#9aa0a6', headerLine: '#5f6368',
  headerSel: '#394457', headerSelText: '#a8c7fa', text: '#e8eaed', sel: 'rgba(138,180,248,0.16)', selLine: '#8ab4f8',
  frozenLine: '#5f6368',
};

export const DEFAULT_FONT = 'Arial';
export const DEFAULT_SIZE = 10;

export function fontFor(f: CellFormat | undefined, zoom: number): string {
  const px = ((f?.size ?? DEFAULT_SIZE) * 4) / 3 * zoom;
  return `${f?.i ? 'italic ' : ''}${f?.b ? 'bold ' : ''}${px.toFixed(2)}px ${quoteFont(f?.font ?? DEFAULT_FONT)}, Arial, sans-serif`;
}

function quoteFont(name: string) {
  return /[\s,]/.test(name) ? `"${name.replace(/"/g, '')}"` : name;
}

export function paint(ctx: CanvasRenderingContext2D, g: Geometry, src: PaintSource, st: PaintState) {
  const T = st.dark ? DARK : LIGHT;
  const { width: W, height: H } = st;
  ctx.save();
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, W, H);

  const [bc1, bc2] = g.visibleCols(st.scrollLeft, W);
  const [br1, br2] = g.visibleRows(st.scrollTop, H);
  const fc = g.frozenCols;
  const fr = g.frozenRows;

  const bodyX = g.headerW + g.frozenW;
  const bodyY = g.headerH + g.frozenH;

  // The four regions: [rows, cols, clip rectangle]
  const regions: [number, number, number, number, number, number, number, number][] = [];
  regions.push([br1, br2, bc1, bc2, bodyX, bodyY, W - bodyX, H - bodyY]);
  if (fr > 0) regions.push([0, fr - 1, bc1, bc2, bodyX, g.headerH, W - bodyX, g.frozenH]);
  if (fc > 0) regions.push([br1, br2, 0, fc - 1, g.headerW, bodyY, g.frozenW, H - bodyY]);
  if (fr > 0 && fc > 0) regions.push([0, fr - 1, 0, fc - 1, g.headerW, g.headerH, g.frozenW, g.frozenH]);

  for (const [r1, r2, c1, c2, x, y, w, h] of regions) {
    if (w <= 0 || h <= 0 || r2 < r1 || c2 < c1) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    drawRegion(ctx, g, src, st, T, r1, r2, c1, c2);
    drawOverlays(ctx, g, st, T);
    ctx.restore();
  }

  drawHeaders(ctx, g, st, T, bc1, bc2, br1, br2);

  // Frozen dividers.
  ctx.strokeStyle = T.frozenLine;
  ctx.lineWidth = 2;
  if (fr > 0) { ctx.beginPath(); ctx.moveTo(0, bodyY); ctx.lineTo(W, bodyY); ctx.stroke(); }
  if (fc > 0) { ctx.beginPath(); ctx.moveTo(bodyX, 0); ctx.lineTo(bodyX, H); ctx.stroke(); }
  ctx.restore();
}

type Theme = typeof LIGHT;

function cellRect(g: Geometry, st: PaintState, r1: number, c1: number, r2: number, c2: number) {
  const x = g.viewX(g.colX[c1]!, st.scrollLeft);
  const y = g.viewY(g.rowY[r1]!, st.scrollTop);
  // Width via the sheet span, so a merge that crosses the frozen edge stays one piece.
  const w = g.colX[c2 + 1]! - g.colX[c1]!;
  const h = g.rowY[r2 + 1]! - g.rowY[r1]!;
  return { x, y, w, h };
}

function drawRegion(
  ctx: CanvasRenderingContext2D, g: Geometry, src: PaintSource, st: PaintState, T: Theme,
  r1: number, r2: number, c1: number, c2: number,
) {
  // Merges: map every covered cell to its merge, so covered cells are skipped
  // and the anchor draws across the whole area.
  const covered = new Map<string, Rect>();
  const visibleMerges = src.merges.filter((m) => m.r2 >= r1 && m.r1 <= r2 && m.c2 >= c1 && m.c1 <= c2);
  for (const m of visibleMerges) {
    for (let r = Math.max(m.r1, r1); r <= Math.min(m.r2, r2); r += 1) {
      for (let c = Math.max(m.c1, c1); c <= Math.min(m.c2, c2); c += 1) covered.set(`${r},${c}`, m);
    }
  }

  // 1. Fills
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) {
      if (covered.has(`${r},${c}`)) continue;
      const bg = src.format(r, c)?.bg;
      if (!bg) continue;
      const { x, y, w, h } = cellRect(g, st, r, c, r, c);
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, w, h);
    }
  }

  // 2. Grid lines
  ctx.strokeStyle = T.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const top = g.viewY(g.rowY[r1]!, st.scrollTop);
  const bottom = g.viewY(g.rowY[r2 + 1]!, st.scrollTop);
  const left = g.viewX(g.colX[c1]!, st.scrollLeft);
  const right = g.viewX(g.colX[c2 + 1]!, st.scrollLeft);
  for (let c = c1; c <= c2 + 1; c += 1) {
    const x = Math.round(g.viewX(g.colX[c]!, st.scrollLeft)) - 0.5;
    ctx.moveTo(x, top); ctx.lineTo(x, bottom);
  }
  for (let r = r1; r <= r2 + 1; r += 1) {
    const y = Math.round(g.viewY(g.rowY[r]!, st.scrollTop)) - 0.5;
    ctx.moveTo(left, y); ctx.lineTo(right, y);
  }
  ctx.stroke();

  // 3. Text. Left-aligned text overflows into empty cells to its right (and
  //    right-aligned to its left), as in every spreadsheet, unless wrapped
  //    or clipped.
  ctx.textBaseline = 'middle';
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) {
      if (covered.has(`${r},${c}`)) continue;
      drawCellText(ctx, g, src, st, T, r, c, r, c, c1, c2);
    }
  }

  // 4. Borders
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) {
      const f = src.format(r, c);
      if (!f || !(f.bt || f.bb || f.bl || f.br)) continue;
      const m = covered.get(`${r},${c}`);
      const box = m ? cellRect(g, st, m.r1, m.c1, m.r2, m.c2) : cellRect(g, st, r, c, r, c);
      drawBorders(ctx, box, f, !m || r === m.r1, !m || r === m.r2, !m || c === m.c1, !m || c === m.c2);
    }
  }

  // Comment corners.
  if (src.hasComment) {
    ctx.fillStyle = '#f9ab00';
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        if (!src.hasComment(r, c)) continue;
        const m = covered.get(`${r},${c}`);
        const box = m ? cellRect(g, st, m.r1, m.c1, m.r2, m.c2) : cellRect(g, st, r, c, r, c);
        ctx.beginPath();
        ctx.moveTo(box.x + box.w - 8, box.y);
        ctx.lineTo(box.x + box.w - 1, box.y);
        ctx.lineTo(box.x + box.w - 1, box.y + 7);
        ctx.fill();
      }
    }
  }

  // 5. Merged areas: one cell, one fill, one text.
  for (const m of visibleMerges) {
    const box = cellRect(g, st, m.r1, m.c1, m.r2, m.c2);
    ctx.fillStyle = src.format(m.r1, m.c1)?.bg ?? T.bg;
    ctx.fillRect(box.x, box.y, box.w - 1, box.h - 1);
    drawCellText(ctx, g, src, st, T, m.r1, m.c1, m.r2, m.c2, m.c1, m.c2);
    const f = src.format(m.r1, m.c1);
    if (f) drawBorders(ctx, box, f, true, true, true, true);
  }
}

function drawCellText(
  ctx: CanvasRenderingContext2D, g: Geometry, src: PaintSource, st: PaintState, T: Theme,
  r1: number, c1: number, r2: number, c2: number, visC1: number, visC2: number,
) {
  const v = src.value(r1, c1);
  if (v === null || v === '') return;
  const f = src.format(r1, c1);
  const shown = formatValue(v, f?.nf, src.locale);
  if (shown.text === '') return;
  const box = cellRect(g, st, r1, c1, r2, c2);

  const isErr = isError(v);
  const isBool = typeof v === 'boolean';
  const ha = f?.ha ?? (isBool || isErr ? 'center' : shown.numeric ? 'right' : 'left');
  const va = f?.va ?? 'bottom';
  const wrap = f?.wrap ?? 'overflow';
  const pad = 3 * g.zoom;

  ctx.font = fontFor(f, g.zoom);
  ctx.fillStyle = shown.color ?? f?.color ?? T.text;

  // How far the text may run: its own box, extended across empty
  // neighbours when overflowing (never for numbers — a cut-off number
  // would be read as a different number).
  let clipX = box.x;
  let clipW = box.w;
  const textW = ctx.measureText(shown.text).width;
  if (wrap === 'overflow' && !shown.numeric && r1 === r2 && c1 === c2 && textW > box.w - 2 * pad) {
    if (ha !== 'right') {
      let c = c2 + 1;
      while (c <= visC2 + 20 && c < g.cols && isEmpty(src, r1, c) && clipW < textW + 2 * pad) {
        clipW += g.colWidth(c); c += 1;
      }
    }
    if (ha !== 'left') {
      let c = c1 - 1;
      while (c >= Math.max(0, visC1 - 20) && isEmpty(src, r1, c) && clipW < textW + 2 * pad) {
        clipX -= g.colWidth(c); clipW += g.colWidth(c); c -= 1;
      }
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(clipX, box.y, clipW - 1, box.h - 1);
  ctx.clip();

  const lineH = ((f?.size ?? DEFAULT_SIZE) * 4) / 3 * g.zoom * 1.25;
  const lines = wrap === 'wrap' ? wrapLines(ctx, shown.text, box.w - 2 * pad) : [shown.text];
  const blockH = lines.length * lineH;
  let y = va === 'top' ? box.y + pad + lineH / 2
    : va === 'middle' ? box.y + box.h / 2 - blockH / 2 + lineH / 2
    : box.y + box.h - pad - blockH + lineH / 2;

  for (const line of lines) {
    const w = ctx.measureText(line).width;
    let x: number;
    if (ha === 'left') x = box.x + pad;
    else if (ha === 'right') x = box.x + box.w - pad - w;
    else x = box.x + box.w / 2 - w / 2;
    ctx.fillText(line, x, y);
    if (f?.u || f?.s) {
      ctx.fillRect(x, f.u ? y + lineH * 0.35 : y, w, Math.max(1, g.zoom));
      if (f.u && f.s) ctx.fillRect(x, y, w, Math.max(1, g.zoom));
    }
    y += lineH;
  }
  ctx.restore();

  if (isErr) {
    // The red corner that says "hover for the reason", as in Sheets.
    ctx.fillStyle = '#d93025';
    ctx.beginPath();
    ctx.moveTo(box.x + box.w - 7, box.y);
    ctx.lineTo(box.x + box.w - 1, box.y);
    ctx.lineTo(box.x + box.w - 1, box.y + 6);
    ctx.fill();
  }
}

function isEmpty(src: PaintSource, r: number, c: number) {
  const v = src.value(r, c);
  return v === null || v === '';
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (ctx.measureText(next).width <= maxW || line === '') { line = next; continue; }
      out.push(line.trimEnd());
      line = word.trimStart();
    }
    out.push(line);
  }
  return out;
}

const BORDER_WIDTH: Record<BorderSide['style'], number> = { thin: 1, dashed: 1, dotted: 1, medium: 2, thick: 3, double: 3 };

function drawBorders(
  ctx: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number }, f: CellFormat,
  top: boolean, bottom: boolean, left: boolean, right: boolean,
) {
  const side = (s: BorderSide | undefined, x1: number, y1: number, x2: number, y2: number) => {
    if (!s) return;
    ctx.save();
    ctx.strokeStyle = s.color || '#000000';
    ctx.lineWidth = BORDER_WIDTH[s.style] ?? 1;
    ctx.setLineDash(s.style === 'dashed' ? [4, 2] : s.style === 'dotted' ? [1, 2] : []);
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  };
  const x1 = Math.round(box.x) - 0.5; const x2 = Math.round(box.x + box.w) - 0.5;
  const y1 = Math.round(box.y) - 0.5; const y2 = Math.round(box.y + box.h) - 0.5;
  if (top) side(f.bt, x1, y1, x2, y1);
  if (bottom) side(f.bb, x1, y2, x2, y2);
  if (left) side(f.bl, x1, y1, x1, y2);
  if (right) side(f.br, x2, y1, x2, y2);
}

function rectBox(g: Geometry, st: PaintState, r: Rect) {
  return cellRect(g, st, r.r1, r.c1, Math.min(r.r2, g.rows - 1), Math.min(r.c2, g.cols - 1));
}

function drawOverlays(ctx: CanvasRenderingContext2D, g: Geometry, st: PaintState, T: Theme) {
  // Colleagues first, so our own selection draws on top of theirs.
  for (const rm of st.remotes) {
    const b = rectBox(g, st, rm.rect);
    ctx.strokeStyle = rm.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    const a = rectBox(g, st, { r1: rm.active.r, c1: rm.active.c, r2: rm.active.r, c2: rm.active.c });
    ctx.font = `600 ${11}px Arial, sans-serif`;
    const label = rm.name;
    const lw = ctx.measureText(label).width + 8;
    ctx.fillStyle = rm.color;
    ctx.fillRect(a.x + a.w - lw, a.y - 15, lw, 15);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, a.x + a.w - lw + 4, a.y - 7);
  }

  for (const rb of st.refBoxes) {
    const b = rectBox(g, st, rb.rect);
    ctx.fillStyle = `${rb.color}1f`;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = rb.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  }

  const sel = rectBox(g, st, st.selection);
  const multi = st.selection.r1 !== st.selection.r2 || st.selection.c1 !== st.selection.c2;
  if (multi) {
    ctx.fillStyle = T.sel;
    ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
  }
  ctx.strokeStyle = T.selLine;
  ctx.lineWidth = multi ? 1 : 2;
  ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
  const act = rectBox(g, st, { r1: st.active.r, c1: st.active.c, r2: st.active.r, c2: st.active.c });
  ctx.lineWidth = 2;
  ctx.strokeRect(act.x + 1, act.y + 1, act.w - 2, act.h - 2);

  // The fill handle.
  ctx.fillStyle = T.selLine;
  ctx.fillRect(sel.x + sel.w - 4, sel.y + sel.h - 4, 7, 7);
  ctx.strokeStyle = T.bg;
  ctx.lineWidth = 1;
  ctx.strokeRect(sel.x + sel.w - 4.5, sel.y + sel.h - 4.5, 8, 8);

  if (st.fillPreview) {
    const b = rectBox(g, st, st.fillPreview);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = T.selLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    ctx.setLineDash([]);
  }
  if (st.copyRect) {
    const b = rectBox(g, st, st.copyRect);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = T.selLine;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
    ctx.setLineDash([]);
  }
}

function drawHeaders(
  ctx: CanvasRenderingContext2D, g: Geometry, st: PaintState, T: Theme,
  bc1: number, bc2: number, br1: number, br2: number,
) {
  const sel = st.selection;
  ctx.font = `${Math.round(11 * Math.max(0.85, Math.min(1.2, g.zoom)))}px Arial, sans-serif`;
  ctx.textBaseline = 'middle';

  // Column headers
  ctx.save();
  ctx.fillStyle = T.header;
  ctx.fillRect(0, 0, st.width, g.headerH);
  const colRanges: [number, number][] = [[0, g.frozenCols - 1], [bc1, bc2]];
  for (const [a, b] of colRanges) {
    for (let c = a; c <= b; c += 1) {
      const x = g.viewX(g.colX[c]!, st.scrollLeft);
      const w = g.colWidth(c);
      if (c >= g.frozenCols && x < g.headerW + g.frozenW - 1) continue;
      const inSel = c >= sel.c1 && c <= sel.c2;
      if (inSel) {
        ctx.fillStyle = st.colSel ? T.selLine : T.headerSel;
        ctx.fillRect(x, 0, w, g.headerH);
      }
      ctx.fillStyle = inSel ? (st.colSel ? '#ffffff' : T.headerSelText) : T.headerText;
      const label = colName(c);
      ctx.fillText(label, x + w / 2 - ctx.measureText(label).width / 2, g.headerH / 2 + 1);
      ctx.fillStyle = T.headerLine;
      ctx.fillRect(Math.round(x + w) - 1, 0, 1, g.headerH);
    }
  }
  ctx.fillStyle = T.headerLine;
  ctx.fillRect(0, g.headerH - 1, st.width, 1);
  ctx.restore();

  // Row headers
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, g.headerH, g.headerW, st.height - g.headerH);
  ctx.clip();
  ctx.fillStyle = T.header;
  ctx.fillRect(0, g.headerH, g.headerW, st.height);
  const rowRanges: [number, number][] = [[0, g.frozenRows - 1], [br1, br2]];
  for (const [a, b] of rowRanges) {
    for (let r = a; r <= b; r += 1) {
      const y = g.viewY(g.rowY[r]!, st.scrollTop);
      const h = g.rowHeight(r);
      if (r >= g.frozenRows && y < g.headerH + g.frozenH - 1) continue;
      const inSel = r >= sel.r1 && r <= sel.r2;
      if (inSel) {
        ctx.fillStyle = st.rowSel ? T.selLine : T.headerSel;
        ctx.fillRect(0, y, g.headerW, h);
      }
      ctx.fillStyle = inSel ? (st.rowSel ? '#ffffff' : T.headerSelText) : T.headerText;
      const label = String(r + 1);
      ctx.fillText(label, g.headerW / 2 - ctx.measureText(label).width / 2, y + h / 2 + 1);
      ctx.fillStyle = T.headerLine;
      ctx.fillRect(0, Math.round(y + h) - 1, g.headerW, 1);
    }
  }
  ctx.fillStyle = T.headerLine;
  ctx.fillRect(g.headerW - 1, g.headerH, 1, st.height);
  ctx.restore();

  // The corner (select all).
  ctx.fillStyle = T.header;
  ctx.fillRect(0, 0, g.headerW - 1, g.headerH - 1);
}
