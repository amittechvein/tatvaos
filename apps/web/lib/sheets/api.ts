// ============================================================================
//  TatvaOS Sheets — API client
// ============================================================================
//
//  A spreadsheet is a Docs file with its own editor: same /api/docs
//  endpoints (live channel, versions, comments), same Space file for
//  sharing, trash and stars. So this file only adds what differs — the
//  kind on create and list, the save and version routes, and the AI
//  actions — and re-exports docsApi for everything else rather than copying it.
//
//  SAVES AND VERSIONS go to /api/sheets/{id}/... (1 Oct 2026): a document's
//  file is built on the server and Docs' routes ignore the browser's copy,
//  but a spreadsheet's state and .xlsx are still the browser's until Sheets
//  has its own server build. Docs' routes refuse a spreadsheet.
// ============================================================================

import { docsApi } from '../docs';
import type { SpaceFile, SpaceScope } from '../space';

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** COPY of DocsFormat.SpreadsheetMimeType in apps/api/Modules/Docs/DocsFormat.cs. */
export const SHEETS_MIME = 'application/vnd.tatvaos.spreadsheet';

export const isSpreadsheet = (f: { mimeType?: string }) => f.mimeType === SHEETS_MIME;

export const sheetHref = (id: string) => `/sheets/s/${id}`;

export type SheetsView = 'recent' | 'owned' | 'shared' | 'starred' | 'trash';

export type SheetsAiAction = 'formula' | 'explain' | 'analyze' | 'clean';

export class SheetsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function json<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new SheetsError((body as { error?: string }).error ?? fallback, res.status);
  }
  return res.json() as Promise<T>;
}

export type SheetRow = SpaceFile & { isStarred?: boolean; ownerDisplayName?: string | null; parentName?: string | null };

export const sheetsApi = {
  ...docsApi,

  /** Is Sheets on for my organisation? Its own switch, separate from Docs'. */
  status: (f: AuthedFetch) =>
    f('/sheets/status')
      .then((r) => json<{ enabled: boolean }>(r, 'Could not check whether Sheets is on.'))
      .then((b) => b.enabled),

  list: (f: AuthedFetch, view: SheetsView, q = '') =>
    f(`/docs?kind=spreadsheet&view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`)
      .then((r) => json<{ documents: SheetRow[]; total: number }>(r, 'Could not load your spreadsheets.')),

  create: (f: AuthedFetch, title?: string, folderId?: string | null, scope: SpaceScope = 'personal') =>
    f('/docs', {
      method: 'POST',
      body: JSON.stringify(folderId
        ? { title, folderId, kind: 'spreadsheet' }
        : { title, scope, kind: 'spreadsheet' }),
    }).then((r) => json<{ id: string; title: string }>(r, 'Could not create the spreadsheet.')),

  checkpointSheet: (f: AuthedFetch, id: string, body: {
    state: string; upToSeq: number; html: string; text: string; xlsx: string;
  }) =>
    f(`/sheets/${id}/checkpoint`, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ saved: boolean }>(r, 'Could not save the spreadsheet.')),

  saveVersion: (f: AuthedFetch, id: string, body: {
    kind: 'named' | 'restore'; name?: string; state: string; html: string;
  }) =>
    f(`/sheets/${id}/versions`, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ id: string }>(r, 'Could not save the version.')),

  ai: (f: AuthedFetch, id: string, body: {
    action: SheetsAiAction; prompt?: string; context?: string; formula?: string; cell?: string;
  }) =>
    f(`/sheets/${id}/ai`, { method: 'POST', body: JSON.stringify(body) })
      .then((r) => json<{ text: string; truncated: boolean }>(r, 'TatvaOS AI could not answer.')),
};
