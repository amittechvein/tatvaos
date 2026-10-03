'use client';

import { useState } from 'react';
import { formatDateTime } from '@/lib/dates';
import type { CommentThread } from '@/lib/docs';
import { I } from './icons';

/**
 * The comments sidebar. Threads come from the server; this component only
 * renders them and reports what the person did. Anchoring (where in the
 * text a thread points) is the editor's job — see DocEditor's anchor code.
 */
export function CommentsPanel({
  threads, meId, canComment, canEdit, activeId, onActivate, draft, onDraftCancel, onDraftSubmit,
  onReply, onResolve, onDelete, onEdit, onClose, orphaned,
}: {
  threads: CommentThread[];
  meId: string;
  canComment: boolean;
  canEdit: boolean;
  activeId: string | null;
  onActivate: (id: string) => void;
  draft: { quote: string } | null;
  onDraftCancel: () => void;
  onDraftSubmit: (body: string) => Promise<void>;
  onReply: (id: string, body: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onClose: () => void;
  /** Threads whose anchored text no longer exists in the document. */
  orphaned: Set<string>;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const open = threads.filter((t) => !t.resolvedAt);
  const resolved = threads.filter((t) => t.resolvedAt);
  const list = showResolved ? resolved : open;

  return (
    <aside className="flex h-full w-full flex-col" aria-label="Comments">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="flex-1 text-sm font-semibold text-ink">Comments</h2>
        <button type="button" onClick={() => setShowResolved((v) => !v)}
          className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted hover:bg-canvas">
          {showResolved ? `Open (${open.length})` : `Resolved (${resolved.length})`}
        </button>
        <button type="button" onClick={onClose} aria-label="Close comments"
          className="rounded p-1 text-ink-faint hover:bg-canvas hover:text-ink"><I.close className="h-4 w-4" /></button>
      </header>

      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {draft && (
          <Composer
            quote={draft.quote}
            placeholder="Add a comment"
            submitLabel="Comment"
            onCancel={onDraftCancel}
            onSubmit={onDraftSubmit}
            autoFocus
          />
        )}

        {list.length === 0 && !draft && (
          <p className="px-2 py-10 text-center text-sm text-ink-faint">
            {showResolved ? 'No resolved comments.'
              : canComment ? 'No comments yet. Select some text and choose Add comment.'
              : 'No comments yet.'}
          </p>
        )}

        {list.map((t) => (
          <Thread key={t.id} t={t} meId={meId} active={t.id === activeId}
            orphaned={orphaned.has(t.id)}
            canComment={canComment} canEdit={canEdit}
            onActivate={() => onActivate(t.id)}
            onReply={(b) => onReply(t.id, b)}
            onResolve={(r) => onResolve(t.id, r)}
            onDelete={(id) => onDelete(id)}
            onEdit={(id, b) => onEdit(id, b)} />
        ))}
      </div>
    </aside>
  );
}

function Thread({ t, meId, active, orphaned, canComment, canEdit, onActivate, onReply, onResolve, onDelete, onEdit }: {
  t: CommentThread; meId: string; active: boolean; orphaned: boolean;
  canComment: boolean; canEdit: boolean;
  onActivate: () => void;
  onReply: (body: string) => Promise<void>;
  onResolve: (resolved: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  return (
    <div role="article" onClick={onActivate}
      className={`rounded-xl border bg-surface p-3 text-sm shadow-sm transition ${
        active ? 'border-brand-600 ring-1 ring-brand-600/30' : 'border-line'}`}>
      {t.quote && (
        <p className={`mb-2 border-l-2 pl-2 text-xs ${orphaned ? 'border-line text-ink-faint line-through' : 'border-[#f5c518] text-ink-muted'}`}
          title={orphaned ? 'The text this comment was about has been deleted' : undefined}>
          {t.quote.length > 140 ? `${t.quote.slice(0, 140)}…` : t.quote}
        </p>
      )}
      <Message c={t} meId={meId} canEdit={canEdit} canComment={canComment}
        onDelete={() => onDelete(t.id)} onEdit={(b) => onEdit(t.id, b)}
        extra={canComment && (
          <button type="button" title={t.resolvedAt ? 'Reopen' : 'Resolve'}
            aria-label={t.resolvedAt ? 'Reopen thread' : 'Resolve thread'}
            onClick={(e) => { e.stopPropagation(); void onResolve(!t.resolvedAt); }}
            className="rounded p-1 text-brand-600 hover:bg-canvas">
            {t.resolvedAt ? <I.undo className="h-4 w-4" /> : <I.resolve className="h-4 w-4" />}
          </button>
        )} />
      {t.resolvedAt && (
        <p className="mt-1 text-xs text-ink-faint">Resolved{t.resolvedByName ? ` by ${t.resolvedByName}` : ''}</p>
      )}
      {t.replies.map((r) => (
        <div key={r.id} className="mt-3 border-t border-line/70 pt-2">
          <Message c={r} meId={meId} canEdit={canEdit} canComment={canComment}
            onDelete={() => onDelete(r.id)} onEdit={(b) => onEdit(r.id, b)} />
        </div>
      ))}
      {canComment && (active || replying) && (
        replying ? (
          <div className="mt-2" onClick={(e) => e.stopPropagation()}>
            <Composer placeholder="Reply" submitLabel="Reply" autoFocus
              onCancel={() => setReplying(false)}
              onSubmit={async (b) => { await onReply(b); setReplying(false); }} />
          </div>
        ) : (
          <button type="button" onClick={(e) => { e.stopPropagation(); setReplying(true); }}
            className="mt-2 w-full rounded-full border border-line px-3 py-1 text-left text-xs text-ink-faint hover:bg-canvas">
            Reply…
          </button>
        )
      )}
    </div>
  );
}

function Message({ c, meId, canEdit, canComment, onDelete, onEdit, extra }: {
  c: CommentThread; meId: string; canEdit: boolean; canComment: boolean;
  onDelete: () => void; onEdit: (body: string) => Promise<void>; extra?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const mine = c.authorUserId === meId;
  return (
    <div>
      <div className="flex items-start gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
          {(c.authorName ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{c.authorName ?? 'Former member'}</p>
          <p className="text-xs text-ink-faint">
            {formatDateTime(c.createdAt)}{c.editedAt ? ' · edited' : ''}
          </p>
        </div>
        {extra}
        {canComment && (mine || canEdit) && !editing && (
          <span className="flex">
            {mine && (
              <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(true); }}
                className="rounded px-1 text-xs text-ink-faint hover:text-ink">Edit</button>
            )}
            <button type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(c.parentId ? 'Delete this reply?' : 'Delete this comment and its replies?')) onDelete();
              }}
              className="rounded px-1 text-xs text-ink-faint hover:text-danger">Delete</button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <Composer initial={c.body} submitLabel="Save" autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (b) => { await onEdit(b); setEditing(false); }} />
        </div>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-ink">{c.body}</p>
      )}
    </div>
  );
}

function Composer({ quote, initial = '', placeholder, submitLabel, onCancel, onSubmit, autoFocus }: {
  quote?: string; initial?: string; placeholder?: string; submitLabel: string;
  onCancel: () => void; onSubmit: (body: string) => Promise<void>; autoFocus?: boolean;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const b = body.trim();
    if (!b) return;
    setBusy(true); setErr(null);
    try { await onSubmit(b); setBody(''); }
    catch (e) { setErr(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-brand-600/50 bg-surface p-3 shadow-sm">
      {quote && (
        <p className="mb-2 border-l-2 border-[#f5c518] pl-2 text-xs text-ink-muted">
          {quote.length > 140 ? `${quote.slice(0, 140)}…` : quote}
        </p>
      )}
      <textarea value={body} onChange={(e) => setBody(e.target.value)} autoFocus={autoFocus}
        placeholder={placeholder} rows={3} aria-label={placeholder ?? submitLabel}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
          if (e.key === 'Escape') onCancel();
        }}
        className="w-full resize-none rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand-600" />
      {err && <p className="mt-1 text-xs text-danger">{err}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy}
          className="rounded-full px-3 py-1 text-xs font-medium text-brand-600 hover:bg-canvas">Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={busy || !body.trim()}
          className="rounded-full bg-brand-600 px-4 py-1 text-xs font-semibold text-white disabled:opacity-50">
          {busy ? '…' : submitLabel}
        </button>
      </div>
    </div>
  );
}
