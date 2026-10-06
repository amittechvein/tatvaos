// ============================================================================
//  The document schema — every node and mark a TatvaOS document can hold
// ============================================================================
//
//  ONE list, imported by the live editor, the read-only version view AND the
//  server's render service (apps/render). The file Space serves is built on
//  the server from the stored Yjs state with exactly these rules, so the file
//  cannot say something the editor does not show (decision 0011 condition 1;
//  docs/DOCS_SERVER_RENDER_DESIGN.md). A node or mark added here reaches all
//  three at once; one added anywhere else reaches only one of them.
//
//  React-free on purpose: nothing here may import react, next, or anything
//  that needs a browser to be LOADED. (DocsImage's node view touches the DOM,
//  but only when an editor view draws it; writing HTML never calls it.)
// ============================================================================

import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { DocsImage, NoMarksOnHardBreaks, PageBreak, ParagraphFormat } from './extensions';

/**
 * The document schema. Shared by the live editor and the read-only version
 * view, so a version renders with exactly the rules it was written under —
 * and through the schema, never as raw HTML (react/no-danger is a security
 * rule in this repo, and a version's HTML is whatever an editor-level
 * browser sent). The server render passes no loader: it writes a picture's
 * address, it never fetches it.
 */
export function documentExtensions(loadImage: (src: string) => Promise<string> = async (src) => src) {
  return [
    StarterKit.configure({
      undoRedo: false, // Yjs has its own, per person — undo never undoes a colleague
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    TextStyle, Color, FontFamily, FontSize,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Subscript, Superscript,
    TableKit.configure({ table: { resizable: true } }),
    TaskList, TaskItem.configure({ nested: true }),
    ParagraphFormat, PageBreak,
    NoMarksOnHardBreaks, // storage keeps no marks on a line break: strip them as they arrive (0011 condition 4, entry 1)
    DocsImage.configure({ load: loadImage, inline: true }),
  ];
}
