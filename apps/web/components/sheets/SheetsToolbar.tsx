'use client';

import { Pop, FONTS } from '@/components/docs/Toolbar';
import { I } from '@/components/docs/icons';
import type { CellFormat, BorderSide } from '@/lib/sheets/workbook';
import type { BorderPreset } from '@/lib/sheets/model';
import { SI } from './icons';

// ============================================================================
//  The formatting toolbar. It only CALLS the editor's actions; the state it
//  shows (bold on, font, size) is the active cell's format, passed in.
// ============================================================================

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];

const COLOURS = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff',
  '#4a86e8', '#0000ff', '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc',
  '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3',
  '#1c4587', '#0b5394', '#134f5c', '#274e13', '#7f6000', '#783f04',
];

/** Number formats offered in the menu, by name. The codes are Excel's. */
export const NUMBER_FORMATS: { label: string; code: string | undefined; sample: string }[] = [
  { label: 'Automatic', code: undefined, sample: '1000.12' },
  { label: 'Plain text', code: '@', sample: 'abc' },
  { label: 'Number', code: '#,##0.00', sample: '1,000.12' },
  { label: 'Whole number', code: '#,##0', sample: '1,000' },
  { label: 'Percent', code: '0.00%', sample: '10.12%' },
  { label: 'Scientific', code: '0.00E+00', sample: '1.01E+03' },
  { label: 'Rupees', code: '₹#,##0.00', sample: '₹1,000.12' },
  { label: 'Rupees (rounded)', code: '₹#,##0', sample: '₹1,000' },
  { label: 'Accounting', code: '₹#,##0.00;(₹#,##0.00);"-"', sample: '(₹1,000.12)' },
  { label: 'Date', code: 'dd/mm/yyyy', sample: '24/09/2026' },
  { label: 'Long date', code: 'd mmmm yyyy', sample: '24 September 2026' },
  { label: 'Time', code: 'h:mm AM/PM', sample: '3:59 PM' },
  { label: 'Date time', code: 'dd/mm/yyyy h:mm AM/PM', sample: '24/09/2026 3:59 PM' },
  { label: 'Duration', code: '[h]:mm:ss', sample: '24:01:00' },
];

export interface ToolbarActions {
  undo(): void;
  redo(): void;
  print(): void;
  format(patch: Partial<CellFormat>): void;
  borders(which: BorderPreset, side: BorderSide | undefined): void;
  merge(how: 'all' | 'horizontal' | 'vertical' | 'none'): void;
  decimals(delta: 1 | -1): void;
  clearFormat(): void;
  insertFunction(name: string): void;
  comment(): void;
  customFormat(): void;
}

function Btn({ title, onClick, active, disabled, children }: {
  title: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={`docs-tb ${active ? 'docs-tb-on' : ''}`}>
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;

function Swatches({ onPick, onClose, allowNone }: { onPick: (c: string | undefined) => void; onClose: () => void; allowNone?: boolean }) {
  return (
    <div className="p-1">
      {allowNone && (
        <button type="button" className="docs-menuitem mb-1" onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onPick(undefined); onClose(); }}>Reset</button>
      )}
      <div className="grid grid-cols-6 gap-1">
        {COLOURS.map((c) => (
          <button key={c} type="button" title={c} aria-label={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onPick(c); onClose(); }}
            className="h-5 w-5 rounded-sm border border-line" style={{ background: c }} />
        ))}
      </div>
    </div>
  );
}

export function SheetsToolbar({ f, canEdit, canComment, zoom, onZoom, canUndo, canRedo, a }: {
  f: CellFormat;
  canEdit: boolean;
  canComment: boolean;
  zoom: number;
  onZoom: (z: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  a: ToolbarActions;
}) {
  const off = !canEdit;
  const font = f.font ?? 'Arial';
  const size = f.size ?? 10;
  const thin: BorderSide = { style: 'thin', color: '#000000' };
  const nfLabel = NUMBER_FORMATS.find((n) => n.code === f.nf)?.label ?? (f.nf ? 'Custom' : 'Automatic');

  return (
    <div role="toolbar" aria-label="Formatting"
      className="docs-toolbar scroll-thin flex items-center gap-0.5 overflow-x-auto rounded-full border border-line bg-surface px-3 py-1">
      <Btn title="Undo (Ctrl+Z)" disabled={off || !canUndo} onClick={a.undo}><I.undo /></Btn>
      <Btn title="Redo (Ctrl+Y)" disabled={off || !canRedo} onClick={a.redo}><I.redo /></Btn>
      <Btn title="Print (Ctrl+P)" onClick={a.print}><I.print /></Btn>
      <Sep />
      <select aria-label="Zoom" value={zoom} onChange={(e) => onZoom(Number(e.target.value))} className="docs-select w-[4.5rem]">
        {[50, 75, 90, 100, 125, 150, 200].map((z) => <option key={z} value={z}>{z}%</option>)}
      </select>
      <Sep />
      <Btn title="Format as rupees" disabled={off} onClick={() => a.format({ nf: '₹#,##0.00' })}>₹</Btn>
      <Btn title="Format as percent" disabled={off} onClick={() => a.format({ nf: '0.00%' })}>%</Btn>
      <Btn title="Fewer decimal places" disabled={off} onClick={() => a.decimals(-1)}><SI.decimalLess /></Btn>
      <Btn title="More decimal places" disabled={off} onClick={() => a.decimals(1)}><SI.decimalMore /></Btn>
      <Pop label={<span className="text-[13px]">{nfLabel === 'Automatic' ? '123' : nfLabel}</span>} title="More formats" disabled={off} wide>
        {(close) => (
          <div className="max-h-80 overflow-y-auto">
            {NUMBER_FORMATS.map((n) => (
              <button key={n.label} type="button" className="docs-menuitem flex justify-between gap-4"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { a.format({ nf: n.code }); close(); }}>
                <span>{n.label}</span><span className="text-ink-faint">{n.sample}</span>
              </button>
            ))}
            <div className="my-1 h-px bg-line" />
            <button type="button" className="docs-menuitem" onMouseDown={(e) => e.preventDefault()}
              onClick={() => { close(); a.customFormat(); }}>Custom number format…</button>
          </div>
        )}
      </Pop>
      <Sep />
      <select aria-label="Font" value={font} disabled={off}
        onChange={(e) => a.format({ font: e.target.value === 'Arial' ? undefined : e.target.value })}
        className="docs-select w-[7rem]">
        {FONTS.map((x) => {
          const name = x.label.replace(/ \(.*\)$/, '');
          return <option key={x.label} value={name}>{x.label}</option>;
        })}
      </select>
      <Sep />
      <Btn title="Decrease font size" disabled={off} onClick={() => a.format({ size: Math.max(6, size - 1) })}>−</Btn>
      <select aria-label="Font size" value={size} disabled={off}
        onChange={(e) => a.format({ size: Number(e.target.value) === 10 ? undefined : Number(e.target.value) })}
        className="docs-select w-[3.2rem] text-center">
        {(SIZES.includes(size) ? SIZES : [...SIZES, size].sort((x, y) => x - y)).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <Btn title="Increase font size" disabled={off} onClick={() => a.format({ size: Math.min(96, size + 1) })}>+</Btn>
      <Sep />
      <Btn title="Bold (Ctrl+B)" active={!!f.b} disabled={off} onClick={() => a.format({ b: f.b ? undefined : true })}><I.bold /></Btn>
      <Btn title="Italic (Ctrl+I)" active={!!f.i} disabled={off} onClick={() => a.format({ i: f.i ? undefined : true })}><I.italic /></Btn>
      <Btn title="Strikethrough (Ctrl+5)" active={!!f.s} disabled={off} onClick={() => a.format({ s: f.s ? undefined : true })}><I.strike /></Btn>
      <Btn title="Underline (Ctrl+U)" active={!!f.u} disabled={off} onClick={() => a.format({ u: f.u ? undefined : true })}><I.underline /></Btn>
      <Pop label={<span className="flex flex-col items-center leading-none"><span className="text-[14px] font-semibold">A</span><span className="mt-0.5 h-[3px] w-4" style={{ background: f.color ?? '#000' }} /></span>}
        title="Text colour" disabled={off}>
        {(close) => <Swatches allowNone onClose={close} onPick={(c) => a.format({ color: c })} />}
      </Pop>
      <Sep />
      <Pop label={<span className="flex flex-col items-center"><SI.fill className="h-4 w-4" /><span className="h-[3px] w-4" style={{ background: f.bg ?? 'transparent' }} /></span>}
        title="Fill colour" disabled={off}>
        {(close) => <Swatches allowNone onClose={close} onPick={(c) => a.format({ bg: c })} />}
      </Pop>
      <Pop label={<SI.borders />} title="Borders" disabled={off} wide>
        {(close) => (
          <div className="grid grid-cols-2 gap-0.5">
            {([['all', 'All borders'], ['outer', 'Outer border'], ['inner', 'Inner borders'], ['top', 'Top'],
               ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['none', 'Clear borders']] as [BorderPreset, string][])
              .map(([k, label]) => (
                <button key={k} type="button" className="docs-menuitem" onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { a.borders(k, k === 'none' ? undefined : thin); close(); }}>{label}</button>
              ))}
            <button type="button" className="docs-menuitem" onMouseDown={(e) => e.preventDefault()}
              onClick={() => { a.borders('outer', { style: 'thick', color: '#000000' }); close(); }}>Thick outer</button>
            <button type="button" className="docs-menuitem" onMouseDown={(e) => e.preventDefault()}
              onClick={() => { a.borders('bottom', { style: 'double', color: '#000000' }); close(); }}>Double bottom</button>
          </div>
        )}
      </Pop>
      <Pop label={<SI.merge />} title="Merge cells" disabled={off}>
        {(close) => (
          <div>
            {([['all', 'Merge all'], ['horizontal', 'Merge horizontally'], ['vertical', 'Merge vertically'], ['none', 'Unmerge']] as const)
              .map(([k, label]) => (
                <button key={k} type="button" className="docs-menuitem" onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { a.merge(k); close(); }}>{label}</button>
              ))}
          </div>
        )}
      </Pop>
      <Sep />
      <Btn title="Align left" active={f.ha === 'left'} disabled={off} onClick={() => a.format({ ha: f.ha === 'left' ? undefined : 'left' })}><I.alignLeft /></Btn>
      <Btn title="Align centre" active={f.ha === 'center'} disabled={off} onClick={() => a.format({ ha: f.ha === 'center' ? undefined : 'center' })}><I.alignCenter /></Btn>
      <Btn title="Align right" active={f.ha === 'right'} disabled={off} onClick={() => a.format({ ha: f.ha === 'right' ? undefined : 'right' })}><I.alignRight /></Btn>
      <Pop label={f.va === 'top' ? <SI.valignTop /> : f.va === 'middle' ? <SI.valignMiddle /> : <SI.valignBottom />} title="Vertical align" disabled={off}>
        {(close) => (
          <div>
            {([['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']] as const).map(([k, label]) => (
              <button key={k} type="button" className="docs-menuitem" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { a.format({ va: k === 'bottom' ? undefined : k }); close(); }}>{label}</button>
            ))}
          </div>
        )}
      </Pop>
      <Pop label={<SI.wrap />} title="Text wrapping" disabled={off}>
        {(close) => (
          <div>
            {([['overflow', 'Overflow'], ['wrap', 'Wrap'], ['clip', 'Clip']] as const).map(([k, label]) => (
              <button key={k} type="button" className={`docs-menuitem ${(f.wrap ?? 'overflow') === k ? 'font-semibold' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { a.format({ wrap: k === 'overflow' ? undefined : k }); close(); }}>{label}</button>
            ))}
          </div>
        )}
      </Pop>
      <Sep />
      <Btn title="Insert comment (Ctrl+Alt+M)" disabled={!canComment} onClick={a.comment}><I.comment /></Btn>
      <Pop label={<SI.functions />} title="Functions" disabled={off}>
        {(close) => (
          <div>
            {['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN', 'IF', 'SUMIF', 'COUNTIF', 'VLOOKUP', 'XLOOKUP', 'ROUND', 'TODAY'].map((n) => (
              <button key={n} type="button" className="docs-menuitem" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { a.insertFunction(n); close(); }}>{n}</button>
            ))}
          </div>
        )}
      </Pop>
      <Btn title="Clear formatting (Ctrl+\)" disabled={off} onClick={a.clearFormat}><I.clear /></Btn>
    </div>
  );
}
