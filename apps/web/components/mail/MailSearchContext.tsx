'use client';

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';

/**
 * The mail search query, shared between the TOP BAR and the mail page.
 *
 * ── WHY THE SEARCH BOX LIVES IN THE HEADER ──────────────────────────────
 *
 *  Until 23 September 2026 there were two search boxes on screen at once:
 *  a real one inside the Inbox, and a dead one in the top bar — a bare
 *  `<input>` with no value, no handler and nothing listening, shipped in
 *  commit 594824d, whose own message calls it a "ghost search". It came
 *  from the purchased template and was never wired to anything. Amit, on
 *  seeing the two together: remove the lower one and move its features up,
 *  "as there is too much space".
 *
 *  So the top bar now carries the real thing. That puts the box in the
 *  shell and the results in the page, on opposite sides of the React tree,
 *  which is what this context is for.
 *
 *  THE BOX APPEARS ONLY WHEN SOMETHING IS LISTENING. `useMailSearchHost`
 *  registers the page that owns the results; with no host the header draws
 *  no search at all, rather than an input that swallows typing. That is
 *  the whole bug being fixed here, and re-creating it in the other
 *  direction would be worse than leaving it alone.
 */

export interface MailSearchFolder { label: string; value: string }

interface MailSearchValue {
  query: string;
  setQuery: (next: string) => void;
  /** Real folders of the open mailbox, for the advanced form's "Search in". */
  folders: MailSearchFolder[];
  /** True while a page is listening — the header draws a box only then. */
  hosted: boolean;
  /**
   * The header input, so the mail page's "/" shortcut can still focus a box
   * that is no longer inside it.
   */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Used by useMailSearchHost; not for pages to call directly. */
  host: (folders: MailSearchFolder[]) => () => void;
}

const Ctx = createContext<MailSearchValue | null>(null);

export function MailSearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const [folders, setFolders] = useState<MailSearchFolder[]>([]);
  const [hosts, setHosts] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const host = useCallback((next: MailSearchFolder[]) => {
    setHosts((n) => n + 1);
    setFolders(next);
    return () => {
      setHosts((n) => {
        const left = n - 1;
        // The last page listening has gone. Drop the query with it: a search
        // still running behind a box nobody can see is the ghost problem
        // wearing different clothes.
        if (left <= 0) { setQuery(''); setFolders([]); }
        return left;
      });
    };
  }, []);

  const value = useMemo(
    () => ({ query, setQuery, folders, hosted: hosts > 0, host, inputRef }),
    [query, folders, hosts, host],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The query, for whoever draws the box or the chips. */
export function useMailSearch(): MailSearchValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMailSearch outside MailSearchProvider');
  return v;
}

/**
 * Claims the header's search box for this page, and hands it the mailbox's
 * folders. Returns the query and its setter.
 */
export function useMailSearchHost(folders: MailSearchFolder[]) {
  const { query, setQuery, host } = useMailSearch();

  // Folder ARRAYS are rebuilt every render, so the effect is keyed on the
  // contents. Keyed on the array itself this registers and unregisters on
  // every render, which empties the header box as fast as it is typed in.
  const key = folders.map((f) => `${f.value}\u0000${f.label}`).join('\u0001');

  useEffect(() => host(folders.slice()), [key, host]); // eslint-disable-line react-hooks/exhaustive-deps

  return { query, setQuery };
}
