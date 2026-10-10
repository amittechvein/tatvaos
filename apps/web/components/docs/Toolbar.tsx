'use client';

import { useEffect, useRef, useState } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { I } from './icons';

// ============================================================================
//  The formatting toolbar and the menu bar.
//
//  Both only CALL editor commands; neither holds document state. The
//  toolbar's "active" states come from useEditorState, which re-renders on
//  selection changes without re-rendering the page around it.
// ============================================================================

export const FONTS = [
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: '"Trebuchet MS", sans-serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
  { label: 'Noto Sans (Indian scripts)', value: '"Noto Sans", "Noto Sans Devanagari", "Nirmala UI", sans-serif' },
];

const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72];

const COLOURS = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff',
  '#4a86e8', '#0000ff', '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc',
  '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3',
  '#1c4587', '#0b5394', '#134f5c', '#274e13', '#7f6000', '#783f04',
];

const SPACINGS = [
  { label: 'Single', value: '1.15' },
  { label: '1.5', value: '1.5' },
  { label: 'Double', value: '2' },
];

export type StyleName = 'normal' | 'title' | 'subtitle' | 'h1' | 'h2' | 'h3' | 'h4';

export function applyStyle(editor: Editor, style: StyleName) {
  const c = editor.chain().focus();
  switch (style) {
    case 'title': c.setHeading({ level: 1 }).updateAttributes('heading', { docStyle: 'title' }).run(); break;
    case 'subtitle': c.setParagraph().updateAttributes('paragraph', { docStyle: 'subtitle' }).run(); break;
    case 'h1': c.setHeading({ level: 1 }).updateAttributes('heading', { docStyle: null }).run(); break;
    case 'h2': c.setHeading({ level: 2 }).updateAttributes('heading', { docStyle: null }).run(); break;
    case 'h3': c.setHeading({ level: 3 }).updateAttributes('heading', { docStyle: null }).run(); break;
    case 'h4': c.setHeading({ level: 4 }).updateAttributes('heading', { docStyle: null }).run(); break;
    default: c.setParagraph().updateAttributes('paragraph', { docStyle: null }).run();
  }
}

function currentStyle(editor: Editor): StyleName {
  if (editor.isActive('heading', { docStyle: 'title' })) return 'title';
  if (editor.isActive('paragraph', { docStyle: 'subtitle' })) return 'subtitle';
  for (const l of [1, 2, 3, 4] as const) if (editor.isActive('heading', { level: l })) return `h${l}`;
  return 'normal';
}

/** A small dropdown that closes on outside click and Escape. */
export function Pop({ label, title, children, disabled, wide }: {
  label: React.ReactNode; title: string; children: (close: () => void) => React.ReactNode;
  disabled?: boolean; wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" title={title} aria-label={title} aria-expanded={open} disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="docs-tb flex items-center gap-1 px-1.5">
        {label}
        <svg viewBox="0 0 24 24" className="h-3 w-3" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="currentColor" /></svg>
      </button>
      {open && (
        <div className={`absolute left-0 top-full z-50 mt-1 rounded-lg border border-line bg-surface p-1 shadow-raised ${wide ? 'w-60' : 'min-w-[9rem]'}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Btn({ title, onClick, active, disabled, children }: {
  title: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={active} disabled={disabled}
      // mousedown default would move focus out of the editor and drop the
      // selection the command is about to act on.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`docs-tb ${active ? 'docs-tb-on' : ''}`}>
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;

export function Toolbar({ editor, canEdit, canComment, zoom, onZoom, onComment, onImage, onLink, onPrint }: {
  editor: Editor;
  canEdit: boolean;
  canComment: boolean;
  zoom: number;
  onZoom: (z: number) => void;
  onComment: () => void;
  onImage: () => void;
  onLink: () => void;
  onPrint: () => void;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canUndo: e.can().undo?.() ?? false,
      canRedo: e.can().redo?.() ?? false,
      style: currentStyle(e),
      font: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      size: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      sup: e.isActive('superscript'),
      sub: e.isActive('subscript'),
      link: e.isActive('link'),
      align: (['left', 'center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      hasSelection: !e.state.selection.empty,
    }),
  });

  const off = !canEdit;
  const fontLabel = FONTS.find((f) => f.value === s.font)?.label ?? 'Arial';
  const sizeNum = s.size ? parseInt(s.size, 10) : 11;

  return (
    <div role="toolbar" aria-label="Formatting"
      className="docs-toolbar scroll-thin flex items-center gap-0.5 overflow-x-auto rounded-full border border-line bg-surface px-3 py-1">
      <Btn title="Undo (Ctrl+Z)" disabled={off || !s.canUndo} onClick={() => editor.chain().focus().undo().run()}><I.undo /></Btn>
      <Btn title="Redo (Ctrl+Y)" disabled={off || !s.canRedo} onClick={() => editor.chain().focus().redo().run()}><I.redo /></Btn>
      <Btn title="Print (Ctrl+P)" onClick={onPrint}><I.print /></Btn>
      <Sep />
      <select aria-label="Zoom" value={zoom} onChange={(e) => onZoom(Number(e.target.value))}
        className="docs-select w-[4.5rem]">
        {[50, 75, 90, 100, 125, 150, 200].map((z) => <option key={z} value={z}>{z}%</option>)}
      </select>
      <Sep />
      <select aria-label="Style" value={s.style} disabled={off}
        onChange={(e) => applyStyle(editor, e.target.value as StyleName)}
        className="docs-select w-[7.5rem]">
        <option value="normal">Normal text</option>
        <option value="title">Title</option>
        <option value="subtitle">Subtitle</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="h4">Heading 4</option>
      </select>
      <Sep />
      <select aria-label="Font" value={s.font} disabled={off}
        onChange={(e) => {
          const v = e.target.value;
          if (v) editor.chain().focus().setFontFamily(v).run();
          else editor.chain().focus().unsetFontFamily().run();
        }}
        className="docs-select w-[7.5rem]" title={fontLabel}>
        <option value="">Arial</option>
        {FONTS.slice(1).map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
      </select>
      <Sep />
      <Btn title="Decrease font size" disabled={off}
        onClick={() => editor.chain().focus().setFontSize(`${Math.max(6, sizeNum - 1)}pt`).run()}>−</Btn>
      <select aria-label="Font size" value={sizeNum} disabled={off}
        onChange={(e) => editor.chain().focus().setFontSize(`${e.target.value}pt`).run()}
        className="docs-select w-[3.4rem] text-center">
        {(SIZES.includes(sizeNum) ? SIZES : [...SIZES, sizeNum].sort((a, b) => a - b))
          .map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <Btn title="Increase font size" disabled={off}
        onClick={() => editor.chain().focus().setFontSize(`${Math.min(400, sizeNum + 1)}pt`).run()}>+</Btn>
      <Sep />
      <Btn title="Bold (Ctrl+B)" active={s.bold} disabled={off} onClick={() => editor.chain().focus().toggleBold().run()}><I.bold /></Btn>
      <Btn title="Italic (Ctrl+I)" active={s.italic} disabled={off} onClick={() => editor.chain().focus().toggleItalic().run()}><I.italic /></Btn>
      <Btn title="Underline (Ctrl+U)" active={s.underline} disabled={off} onClick={() => editor.chain().focus().toggleUnderline().run()}><I.underline /></Btn>
      <Btn title="Strikethrough (Ctrl+Shift+S)" active={s.strike} disabled={off} onClick={() => editor.chain().focus().toggleStrike().run()}><I.strike /></Btn>
      <Pop title="Text colour" disabled={off} label={<I.color />}>
        {(close) => (
          <Swatches onPick={(c) => { editor.chain().focus().setColor(c).run(); close(); }}
            onReset={() => { editor.chain().focus().unsetColor().run(); close(); }} resetLabel="Automatic" />
        )}
      </Pop>
      <Pop title="Highlight colour" disabled={off} label={<I.highlight />}>
        {(close) => (
          <Swatches onPick={(c) => { editor.chain().focus().setHighlight({ color: c }).run(); close(); }}
            onReset={() => { editor.chain().focus().unsetHighlight().run(); close(); }} resetLabel="None" />
        )}
      </Pop>
      <Sep />
      <Btn title="Insert link (Ctrl+K)" active={s.link} disabled={off} onClick={onLink}><I.link /></Btn>
      <Btn title="Add comment (Ctrl+Alt+M)" disabled={!canComment || !s.hasSelection} onClick={onComment}><I.comment /></Btn>
      <Btn title="Insert image" disabled={off} onClick={onImage}><I.image /></Btn>
      <Sep />
      <Pop title="Align" disabled={off}
        label={s.align === 'center' ? <I.alignCenter /> : s.align === 'right' ? <I.alignRight />
          : s.align === 'justify' ? <I.alignJustify /> : <I.alignLeft />}>
        {(close) => (
          <div className="flex gap-0.5">
            {([['left', <I.alignLeft key="l" />, 'Left (Ctrl+Shift+L)'], ['center', <I.alignCenter key="c" />, 'Centre (Ctrl+Shift+E)'],
              ['right', <I.alignRight key="r" />, 'Right (Ctrl+Shift+R)'], ['justify', <I.alignJustify key="j" />, 'Justify (Ctrl+Shift+J)']] as const)
              .map(([a, icon, t]) => (
                <Btn key={a} title={t} active={s.align === a}
                  onClick={() => { editor.chain().focus().setTextAlign(a).run(); close(); }}>{icon}</Btn>
              ))}
          </div>
        )}
      </Pop>
      <Pop title="Line spacing" disabled={off} label={<I.lineSpacing />}>
        {(close) => (
          <div className="flex flex-col">
            {SPACINGS.map((sp) => (
              <button key={sp.value} type="button" className="docs-menuitem"
                onClick={() => { editor.chain().focus().setLineHeight(sp.value).run(); close(); }}>
                {sp.label}
              </button>
            ))}
          </div>
        )}
      </Pop>
      <Btn title="Checklist (Ctrl+Shift+9)" active={s.task} disabled={off} onClick={() => editor.chain().focus().toggleTaskList().run()}><I.checklist /></Btn>
      <Btn title="Bulleted list (Ctrl+Shift+8)" active={s.bullet} disabled={off} onClick={() => editor.chain().focus().toggleBulletList().run()}><I.bullets /></Btn>
      <Btn title="Numbered list (Ctrl+Shift+7)" active={s.ordered} disabled={off} onClick={() => editor.chain().focus().toggleOrderedList().run()}><I.numbers /></Btn>
      <Btn title="Decrease indent (Shift+Tab)" disabled={off} onClick={() => editor.chain().focus().outdent().run()}><I.indentLess /></Btn>
      <Btn title="Increase indent (Tab)" disabled={off} onClick={() => editor.chain().focus().indent().run()}><I.indentMore /></Btn>
      <Btn title="Clear formatting (Ctrl+\)" disabled={off}
        onClick={() => editor.chain().focus().unsetAllMarks().setLineHeight(null).run()}><I.clear /></Btn>
    </div>
  );
}

function Swatches({ onPick, onReset, resetLabel }: {
  onPick: (c: string) => void; onReset: () => void; resetLabel: string;
}) {
  return (
    <div className="w-[11.5rem] p-1">
      <button type="button" className="docs-menuitem mb-1 w-full" onClick={onReset}>{resetLabel}</button>
      <div className="grid grid-cols-6 gap-1">
        {COLOURS.map((c) => (
          <button key={c} type="button" title={c} aria-label={c}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
            className="h-6 w-6 rounded-full border border-line"
            style={{ background: c }} />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
//  The menu bar
// ============================================================================

export type MenuItem =
  | { label: string; shortcut?: string; onClick: () => void; disabled?: boolean }
  | 'sep';

export function MenuBar({ menus }: { menus: { name: string; items: MenuItem[] }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <div ref={ref} role="menubar" className="flex flex-wrap items-center text-sm text-ink">
      {menus.map((m) => (
        <div key={m.name} className="relative">
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open === m.name}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((o) => (o === m.name ? null : m.name))}
            onMouseEnter={() => { if (open && open !== m.name) setOpen(m.name); }}
            className={`rounded px-2 py-0.5 hover:bg-canvas ${open === m.name ? 'bg-canvas' : ''}`}>
            {m.name}
          </button>
          {open === m.name && (
            <div role="menu" className="absolute left-0 top-full z-50 mt-0.5 min-w-[15rem] rounded-lg border border-line bg-surface py-1 shadow-raised">
              {m.items.map((it, i) => it === 'sep' ? (
                <div key={`sep${i}`} className="my-1 h-px bg-line" role="separator" />
              ) : (
                <button key={it.label} type="button" role="menuitem" disabled={it.disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setOpen(null); it.onClick(); }}
                  className="flex w-full items-center justify-between gap-6 px-4 py-1.5 text-left text-sm text-ink hover:bg-canvas disabled:text-ink-faint disabled:hover:bg-transparent">
                  <span>{it.label}</span>
                  {it.shortcut && <span className="text-xs text-ink-faint">{it.shortcut}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
