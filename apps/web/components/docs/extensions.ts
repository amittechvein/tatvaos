// ============================================================================
//  Docs' own editor extensions — the pieces TipTap does not ship.
// ============================================================================

import { Extension, Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphFormat: {
      setLineHeight: (value: string | null) => ReturnType;
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
  }
}

const BLOCKS = ['paragraph', 'heading'];
const INDENT_STEP = 36; // px — half an inch at 72dpi, what Docs and Word use
const MAX_INDENT = 8;

/**
 * Line spacing and indentation, as attributes on paragraphs and headings —
 * Docs' model, where both belong to the paragraph rather than to a run of
 * text. (TipTap's own LineHeight is a text-style mark, which spaces one
 * word differently from the next: not what "line spacing" means.)
 *
 * Inside a list, indent/outdent nest and un-nest the item instead, which is
 * what Tab does in every word processor.
 */
export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',

  addGlobalAttributes() {
    return [{
      types: BLOCKS,
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => el.style.lineHeight || null,
          renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {}),
        },
        // Title and Subtitle, the two named styles that are not a heading
        // level. Stored as data-style so the saved HTML keeps them.
        docStyle: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-style'),
          renderHTML: (a) => (a.docStyle ? { 'data-style': a.docStyle } : {}),
        },
        indent: {
          default: 0,
          parseHTML: (el) => {
            const px = parseInt(el.style.marginLeft || '0', 10);
            return Number.isFinite(px) ? Math.min(MAX_INDENT, Math.round(px / INDENT_STEP)) : 0;
          },
          renderHTML: (a) => (a.indent ? { style: `margin-left: ${a.indent * INDENT_STEP}px` } : {}),
        },
      },
    }];
  },

  addCommands() {
    const shift = (delta: number) => () => ({ state, tr, dispatch, editor }: {
      state: EditorState; tr: import('@tiptap/pm/state').Transaction;
      dispatch?: (tr: import('@tiptap/pm/state').Transaction) => void; editor: import('@tiptap/core').Editor;
    }) => {
      if (editor.isActive('listItem') || editor.isActive('taskItem')) {
        const item = editor.isActive('taskItem') ? 'taskItem' : 'listItem';
        return delta > 0
          ? editor.chain().sinkListItem(item).run()
          : editor.chain().liftListItem(item).run();
      }
      const { from, to } = state.selection;
      let changed = false;
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!BLOCKS.includes(node.type.name)) return;
        const next = Math.max(0, Math.min(MAX_INDENT, (node.attrs.indent ?? 0) + delta));
        if (next !== node.attrs.indent) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          changed = true;
        }
      });
      if (changed && dispatch) dispatch(tr);
      return changed;
    };

    return {
      setLineHeight: (value) => ({ state, tr, dispatch }) => {
        const { from, to } = state.selection;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (BLOCKS.includes(node.type.name)) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight: value });
          }
        });
        if (dispatch) dispatch(tr);
        return true;
      },
      indent: shift(1),
      outdent: shift(-1),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Tab in a paragraph indents, as it does in a word processor. It is
      // deliberately NOT bound when the editor cannot change (read-only):
      // then Tab must move focus, or a keyboard user is trapped.
      Tab: () => this.editor.isEditable && this.editor.commands.indent(),
      'Shift-Tab': () => this.editor.isEditable && this.editor.commands.outdent(),
    };
  },
});

/**
 * A manual page break. In the editor it is a labelled dashed rule; in print
 * and PDF it is a real break (break-after in the docs stylesheet).
 */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div[data-page-break]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-break': '', class: 'docs-page-break' })];
  },

  addCommands() {
    return {
      setPageBreak: () => ({ chain }) =>
        chain().insertContent({ type: this.name }).createParagraphNear().run(),
    };
  },

  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() };
  },
});

/**
 * Pictures stored by Docs are behind the reader's session, and an <img>
 * cannot send the access token (it lives in memory, not a cookie). So the
 * node keeps the API path as its src — meaningful, stable, and what the
 * saved HTML carries — and the view fetches it through the signed-in fetch
 * and shows a blob URL. Pictures from elsewhere (a pasted https:// URL)
 * load directly.
 */
export const DocsImage = Image.extend<{
  inline: boolean; allowBase64: boolean; HTMLAttributes: Record<string, unknown>;
  resize: false; load: (src: string) => Promise<string>;
}>({
  addOptions() {
    return {
      ...this.parent!(),
      load: async (src: string) => src,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute('width'),
        renderHTML: (a) => (a.width ? { width: a.width } : {}),
      },
    };
  },

  addNodeView() {
    return ({ node }) => {
      const img = document.createElement('img');
      img.className = 'docs-image';
      img.alt = node.attrs.alt ?? '';
      if (node.attrs.width) img.setAttribute('width', String(node.attrs.width));
      const src = String(node.attrs.src ?? '');
      if (src.startsWith('/api/')) {
        img.setAttribute('data-loading', '');
        this.options.load(src)
          .then((url) => { img.src = url; img.removeAttribute('data-loading'); })
          .catch(() => { img.alt = 'This picture could not be loaded.'; img.removeAttribute('data-loading'); });
      } else {
        img.src = src;
      }
      return { dom: img };
    };
  },
});

// ---------------------------------------------------------------------------
//  Comment highlights
// ---------------------------------------------------------------------------
//
//  A comment is anchored by two Yjs relative positions stored with the
//  comment on the server (NOT marks in the document — a Commenter cannot
//  change the document, and must still be able to comment). Each render,
//  the editor asks `ranges()` for the current absolute positions and paints
//  decorations; the host recomputes them from the anchors whenever the
//  document or the thread list changes.

export interface CommentRange {
  id: string;
  from: number;
  to: number;
  active: boolean;
}

export const commentHighlightKey = new PluginKey('docsCommentHighlights');

export const CommentHighlights = Extension.create<{
  ranges: (state: EditorState) => CommentRange[];
  onClick: (id: string) => void;
}>({
  name: 'commentHighlights',

  addOptions() {
    return { ranges: () => [], onClick: () => {} };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      new Plugin({
        key: commentHighlightKey,
        props: {
          decorations(state) {
            const size = state.doc.content.size;
            const decos = opts.ranges(state)
              .filter((r) => r.from < r.to && r.to <= size)
              .map((r) => Decoration.inline(r.from, r.to, {
                class: r.active ? 'docs-comment docs-comment-active' : 'docs-comment',
                'data-comment-id': r.id,
              }));
            return DecorationSet.create(state.doc, decos);
          },
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest?.('[data-comment-id]');
            const id = el?.getAttribute('data-comment-id');
            if (id) opts.onClick(id);
            return false;
          },
        },
      }),
    ];
  },
});
