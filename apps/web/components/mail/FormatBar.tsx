'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The composer's formatting bar — Gmail's "Formatting options" row.
 *
 * Amit, 25 Sept 2026: font, size, text and background colour, pictures,
 * alignment and an HTML editor. They could not go on the bottom row: that row
 * holds Send and Discard at the composer's 560px width, and three extra icons
 * once pushed Discard onto a second line (Composer.tsx, 21 Sept). So this is
 * its own row above it, shown by default and hidden with the "Aa" button.
 *
 * ── THE SELECTION ───────────────────────────────────────────────────────
 *  Every control here acts on the text selected in the editor. A button that
 *  takes focus on mousedown moves the selection out of the editor first, and
 *  the command then applies to nothing. So every control prevents the default
 *  on mousedown; the editor keeps its selection, and the parent's command
 *  handler re-focuses it. Menus are buttons for the same reason — a <select>
 *  takes focus and loses the selection.
 *
 * ── EMAIL-SAFE CHOICES ──────────────────────────────────────────────────
 *  Fonts are stacks that end in something every client has. Sizes are px,
 *  not execCommand's 1–7 scale, whose keyword sizes (x-large…) mean different
 *  things in different clients. Colours are a fixed palette, the same as
 *  Gmail's rows, so a message does not arrive in #F7F8F9-on-#FFFFFF.
 */

export const FONTS: { label: string; stack: string }[] = [
  { label: 'Sans Serif', stack: 'Arial, Helvetica, sans-serif' },
  { label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
  { label: 'Fixed width', stack: "'Courier New', Courier, monospace" },
  { label: 'Wide', stack: "'Arial Black', Arial, sans-serif" },
  { label: 'Narrow', stack: "'Arial Narrow', Arial, sans-serif" },
  { label: 'Comic Sans MS', stack: "'Comic Sans MS', 'Comic Sans', cursive" },
  { label: 'Garamond', stack: "Garamond, 'Times New Roman', serif" },
  { label: 'Georgia', stack: 'Georgia, serif' },
  { label: 'Tahoma', stack: 'Tahoma, Geneva, sans-serif' },
  { label: 'Trebuchet MS', stack: "'Trebuchet MS', Helvetica, sans-serif" },
  { label: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
];

export const SIZES: { label: string; px: number }[] = [
  { label: 'Small', px: 12 },
  { label: 'Normal', px: 14 },
  { label: 'Large', px: 18 },
  { label: 'Huge', px: 28 },
];

const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#d9d9d9', '#efefef', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#9900ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#d9d2e9',
  '#85200c', '#990000', '#b45f06', '#bf9000', '#38761d', '#134f5c', '#1155cc', '#351c75',
];

type MenuName = 'font' | 'size' | 'color' | 'highlight' | 'align' | null;

export function FormatBar({
  onCommand, onSize, onPicture, htmlMode, onToggleHtml,
}: {
  /** document.execCommand on the editor (the parent focuses it first). */
  onCommand: (command: string, value?: string) => void;
  onSize: (px: number) => void;
  onPicture: () => void;
  htmlMode: boolean;
  onToggleHtml: () => void;
}) {
  const [menu, setMenu] = useState<MenuName>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);

  const off = htmlMode;
  const run = (command: string, value?: string) => { onCommand(command, value); setMenu(null); };
  const toggle = (m: Exclude<MenuName, null>) => setMenu((cur) => (cur === m ? null : m));

  return (
    <div ref={barRef} role="toolbar" aria-label="Formatting"
         className="relative flex flex-wrap items-center gap-0.5 border-t border-line px-2 py-1">
      <MenuBtn label="Font" wide disabled={off} open={menu === 'font'} onClick={() => toggle('font')}>
        <span className="text-xs">Font</span>
      </MenuBtn>
      <MenuBtn label="Size" disabled={off} open={menu === 'size'} onClick={() => toggle('size')}>
        <SvgSize />
      </MenuBtn>
      <Sep />
      <Btn label="Bold (Ctrl+B)" disabled={off} onClick={() => run('bold')}><span className="text-[15px] font-bold">B</span></Btn>
      <Btn label="Italic (Ctrl+I)" disabled={off} onClick={() => run('italic')}><span className="text-[15px] italic">I</span></Btn>
      <Btn label="Underline (Ctrl+U)" disabled={off} onClick={() => run('underline')}><span className="text-[15px] underline">U</span></Btn>
      <Btn label="Strikethrough" disabled={off} onClick={() => run('strikeThrough')}><span className="text-[15px] line-through">S</span></Btn>
      <MenuBtn label="Text colour" disabled={off} open={menu === 'color'} onClick={() => toggle('color')}>
        <SvgTextColour />
      </MenuBtn>
      <MenuBtn label="Background colour" disabled={off} open={menu === 'highlight'} onClick={() => toggle('highlight')}>
        <SvgHighlight />
      </MenuBtn>
      <Sep />
      <MenuBtn label="Align" disabled={off} open={menu === 'align'} onClick={() => toggle('align')}>
        <SvgAlign kind="left" />
      </MenuBtn>
      <Btn label="Numbered list" disabled={off} onClick={() => run('insertOrderedList')}><SvgList numbered /></Btn>
      <Btn label="Bulleted list" disabled={off} onClick={() => run('insertUnorderedList')}><SvgList /></Btn>
      <Btn label="Decrease indent" disabled={off} onClick={() => run('outdent')}><SvgIndent out /></Btn>
      <Btn label="Increase indent" disabled={off} onClick={() => run('indent')}><SvgIndent /></Btn>
      <Btn label="Remove formatting" disabled={off} onClick={() => run('removeFormat')}><SvgClear /></Btn>
      <Sep />
      <Btn label="Insert picture" disabled={off} onClick={onPicture}><SvgPicture /></Btn>
      <Btn label={htmlMode ? 'Back to formatted text' : 'Edit HTML'} pressed={htmlMode} onClick={() => { setMenu(null); onToggleHtml(); }}>
        <span className="font-mono text-[11px] font-bold">&lt;/&gt;</span>
      </Btn>

      {/* ---- Menus ---------------------------------------------------- */}
      {menu === 'font' && (
        <Pop>
          {FONTS.map((f) => (
            <MenuItem key={f.label} onClick={() => run('fontName', f.stack)}>
              <span style={{ fontFamily: f.stack }}>{f.label}</span>
            </MenuItem>
          ))}
        </Pop>
      )}
      {menu === 'size' && (
        <Pop>
          {SIZES.map((s) => (
            <MenuItem key={s.label} onClick={() => { onSize(s.px); setMenu(null); }}>
              <span style={{ fontSize: Math.min(s.px, 22) }}>{s.label}</span>
            </MenuItem>
          ))}
        </Pop>
      )}
      {menu === 'color' && (
        <Pop wide>
          <Palette onPick={(c) => run('foreColor', c)} />
          <MenuItem onClick={() => run('foreColor', '#222222')}>Default colour</MenuItem>
        </Pop>
      )}
      {menu === 'highlight' && (
        <Pop wide>
          <Palette onPick={(c) => run('hiliteColor', c)} />
          <MenuItem onClick={() => run('hiliteColor', 'transparent')}>No background</MenuItem>
        </Pop>
      )}
      {menu === 'align' && (
        <Pop>
          <MenuItem onClick={() => run('justifyLeft')}><SvgAlign kind="left" /> Left</MenuItem>
          <MenuItem onClick={() => run('justifyCenter')}><SvgAlign kind="center" /> Centre</MenuItem>
          <MenuItem onClick={() => run('justifyRight')}><SvgAlign kind="right" /> Right</MenuItem>
          <MenuItem onClick={() => run('justifyFull')}><SvgAlign kind="justify" /> Justify</MenuItem>
        </Pop>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const keepSelection = (e: React.MouseEvent) => e.preventDefault();

function Btn({ label, onClick, disabled, pressed, children }: {
  label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={pressed}
            disabled={disabled} onMouseDown={keepSelection} onClick={onClick}
            className={`flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-ink-muted transition hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${pressed ? 'bg-canvas text-ink ring-1 ring-line' : ''}`}>
      {children}
    </button>
  );
}

function MenuBtn({ label, onClick, disabled, open, wide, children }: {
  label: string; onClick: () => void; disabled?: boolean; open: boolean; wide?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open}
            disabled={disabled} onMouseDown={keepSelection} onClick={onClick}
            className={`flex h-8 items-center gap-0.5 rounded-md px-1.5 text-ink-muted transition hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${wide ? 'min-w-14' : 'min-w-8'} ${open ? 'bg-canvas text-ink' : ''}`}>
      {children}
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
    </button>
  );
}

function Pop({ wide, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div role="menu" onMouseDown={keepSelection}
         className={`absolute bottom-full left-2 z-20 mb-1 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface py-1.5 text-sm shadow-raised ${wide ? 'w-60' : 'w-44'}`}>
      {children}
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onMouseDown={keepSelection} onClick={onClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink hover:bg-canvas">
      {children}
    </button>
  );
}

function Palette({ onPick }: { onPick: (hex: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-1 px-2.5 pb-2 pt-1">
      {PALETTE.map((c) => (
        <button key={c} type="button" title={c} aria-label={`Colour ${c}`}
                onMouseDown={keepSelection} onClick={() => onPick(c)}
                className="h-5 w-5 rounded-sm border border-line transition hover:scale-110"
                style={{ background: c }} />
      ))}
    </div>
  );
}

function Sep() { return <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />; }

// ---- icons (the shared Icon set has none of these) -------------------------
const S = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
function SvgSize() { return <svg {...S}><path d="M4 7V5h10v2M9 5v14M7 19h4M14 13v-1h7v1M17.5 12v7M16 19h3" /></svg>; }
function SvgTextColour() { return <svg {...S}><path d="M6 17L11 5h2l5 12M8 13h8" /><path d="M4 21h16" strokeWidth={3} stroke="#e53935" /></svg>; }
function SvgHighlight() { return <svg {...S}><path d="M15 5l4 4-8 8H7v-4z" /><path d="M4 21h16" strokeWidth={3} stroke="#fbc02d" /></svg>; }
function SvgAlign({ kind }: { kind: 'left' | 'center' | 'right' | 'justify' }) {
  const rows = { left: ['4 20', '4 14', '4 20', '4 12'], center: ['4 20', '7 17', '4 20', '8 16'], right: ['4 20', '10 20', '4 20', '12 20'], justify: ['4 20', '4 20', '4 20', '4 20'] }[kind];
  return <svg {...S}>{rows.map((r, i) => { const [a, b] = r.split(' '); return <path key={i} d={`M${a} ${6 + i * 4}h${Number(b) - Number(a)}`} />; })}</svg>;
}
function SvgList({ numbered }: { numbered?: boolean }) {
  return <svg {...S}><path d="M10 6h10M10 12h10M10 18h10" />{numbered ? <path d="M4 5h1v3M4 11h2l-2 2h2M4 17h2v2H4" strokeWidth={1.5} /> : <><circle cx="5" cy="6" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="5" cy="18" r="1" /></>}</svg>;
}
function SvgIndent({ out }: { out?: boolean }) {
  return <svg {...S}><path d="M11 6h9M11 12h9M4 18h16M4 6h0" />{out ? <path d="M8 9l-3 3 3 3" /> : <path d="M4 9l3 3-3 3" />}</svg>;
}
function SvgClear() { return <svg {...S}><path d="M6 5h11M11 5l-4 14M14 14l6 6M20 14l-6 6" /></svg>; }
function SvgPicture() { return <svg {...S}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="M21 16l-5-5-8 8" /></svg>; }
