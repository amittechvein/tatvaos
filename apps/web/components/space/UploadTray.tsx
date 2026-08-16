'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { formatSize, type SpaceFile, type SpaceScope } from '@/lib/space';
import { Icon } from '@/components/ui/Icon';

// ============================================================================
//  The upload tray — bottom-right, Drive-style
// ============================================================================
//
//  WHY A TRAY AND NOT A SPINNER ON THE PAGE.
//
//  Uploading is the one thing in Space that takes long enough for a person to
//  leave. They pick five files, then navigate into another folder, then go to
//  Mail. A progress indicator that lives on the folder page dies with that
//  page and the person is left guessing whether their upload survived —
//  usually they re-upload, which is how duplicates appear.
//
//  The tray lives in the LAYOUT, so it outlives every navigation inside
//  Space. Uploads keep running and keep reporting while the person browses.
//
//  THE THREE STATES ARE THE CONTRACT'S, NOT AN INVENTION.
//
//   uploading  progress is real: the server streams to disk rather than
//              buffering, so 80% means 80% of the bytes are written, not
//              queued in memory waiting to fail at the end.
//   failed     the server checks quota and permission BEFORE it reads any
//              bytes, so a doomed upload fails in the first instant. The
//              sentence it returns names whose storage is full, so it is
//              shown VERBATIM rather than replaced with "upload failed".
//   done       the response is the finished FileDto, so the listing can take
//              the new row directly and never needs to refetch.
// ============================================================================

export interface UploadJob {
  id: string;
  name: string;
  sizeBytes: number;
  folderId: string | null;
  scope: SpaceScope;
  progress: number;                    // 0..1
  status: 'uploading' | 'done' | 'failed' | 'cancelled';
  error?: string;
  /** The contract's machine-readable refusal: full | suspended | … */
  reason?: string;
  file?: SpaceFile;
  cancel: () => void;
}

interface UploadState {
  jobs: UploadJob[];
  /** Start uploads. Returns immediately; watch `jobs` for progress. */
  upload: (files: File[], folderId: string | null, scope: SpaceScope) => void;
  /** Files that finished since the caller last asked — for live listings. */
  drainCompleted: () => SpaceFile[];
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

const Ctx = createContext<UploadState>({
  jobs: [], upload: () => {}, drainCompleted: () => [], dismiss: () => {}, clearFinished: () => {},
});

export const useUploads = () => useContext(Ctx);

export function UploadProvider({ children }: { children: React.ReactNode }) {
  const { authedUpload } = useAuth();
  const [jobs, setJobs] = useState<UploadJob[]>([]);

  // Finished files waiting to be picked up by whichever listing is on screen.
  // A ref, not state: draining it must not itself cause a render loop.
  const completed = useRef<SpaceFile[]>([]);

  const patch = useCallback((id: string, changes: Partial<UploadJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...changes } : j)));
  }, []);

  const upload = useCallback((files: File[], folderId: string | null, scope: SpaceScope) => {
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();

      const job: UploadJob = {
        id,
        name: file.name,
        sizeBytes: file.size,
        folderId,
        scope,
        progress: 0,
        status: 'uploading',
        cancel: () => controller.abort(),
      };
      setJobs((prev) => [job, ...prev]);

      // FIELD ORDER IS THE PROTOCOL, not a formality. The server checks quota
      // against `sizeBytes` before it will read the `file` part, so `file`
      // MUST be appended last — rebuild this in a different order and the
      // early-refusal behaviour silently stops working, and a doomed 2 GB
      // upload runs to completion before being rejected.
      const form = new FormData();
      if (folderId) form.append('folderId', folderId);
      else form.append('scope', scope);
      form.append('sizeBytes', String(file.size));
      form.append('file', file, file.name);

      authedUpload<SpaceFile>('/space/files', form,
        (fraction) => patch(id, { progress: fraction }),
        controller.signal)
        .then((created) => {
          completed.current.push(created);
          patch(id, { status: 'done', progress: 1, file: created });
        })
        .catch((e: Error & { reason?: string; name?: string }) => {
          if (e.name === 'AbortError') { patch(id, { status: 'cancelled' }); return; }
          // The server's sentence, verbatim — it says whose storage is full
          // and what to do, which "Upload failed" does not.
          patch(id, { status: 'failed', error: e.message, reason: e.reason });
        });
    }
  }, [authedUpload, patch]);

  const drainCompleted = useCallback(() => {
    const out = completed.current;
    completed.current = [];
    return out;
  }, []);

  const dismiss = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setJobs((prev) => prev.filter((j) => j.status === 'uploading'));
  }, []);

  const value = useMemo<UploadState>(
    () => ({ jobs, upload, drainCompleted, dismiss, clearFinished }),
    [jobs, upload, drainCompleted, dismiss, clearFinished]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <UploadTray />
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------------------
function UploadTray() {
  const { jobs, dismiss, clearFinished } = useUploads();
  const [collapsed, setCollapsed] = useState(false);

  if (jobs.length === 0) return null;

  const active = jobs.filter((j) => j.status === 'uploading');
  const failed = jobs.filter((j) => j.status === 'failed');

  const title = active.length > 0
    ? `Uploading ${active.length} item${active.length === 1 ? '' : 's'}`
    : failed.length > 0
      ? `${failed.length} upload${failed.length === 1 ? '' : 's'} failed`
      : `${jobs.filter((j) => j.status === 'done').length} upload${
          jobs.filter((j) => j.status === 'done').length === 1 ? '' : 's'} complete`;

  return (
    <div className="fixed bottom-0 right-4 z-[1200] w-[min(360px,92vw)] overflow-hidden rounded-t-card border border-line bg-surface shadow-raised">
      <div className="flex items-center gap-2 bg-rail px-4 py-2.5 text-white">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>

        <button type="button" onClick={() => setCollapsed((v) => !v)}
                aria-label={collapsed ? 'Show uploads' : 'Hide uploads'}
                className="rounded p-1 text-rail-text hover:text-white">
          <Icon name={collapsed ? 'expand' : 'minimise'} className="h-4 w-4" />
        </button>

        {/* Closing is only offered when nothing is in flight. A close button
            during an upload reads as "cancel everything", and that is not
            what it would do. */}
        {active.length === 0 && (
          <button type="button" onClick={clearFinished} aria-label="Close"
                  className="rounded p-1 text-rail-text hover:text-white">
            <Icon name="close" className="h-4 w-4" />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="scroll-thin max-h-72 overflow-y-auto">
          {jobs.map((j) => (
            <div key={j.id} className="border-b border-line/60 px-4 py-2.5 last:border-0">
              <div className="flex items-center gap-2">
                <Icon
                  name={j.status === 'done' ? 'inbox'
                    : j.status === 'failed' ? 'junk'
                    : j.status === 'cancelled' ? 'close' : 'draft'}
                  className={`h-4 w-4 shrink-0 ${
                    j.status === 'done' ? 'text-brand-600'
                      : j.status === 'failed' ? 'text-danger' : 'text-ink-faint'}`}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-ink" title={j.name}>
                  {j.name}
                </span>

                {j.status === 'uploading' ? (
                  <>
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                      {Math.round(j.progress * 100)}%
                    </span>
                    <button type="button" onClick={j.cancel} aria-label={`Cancel ${j.name}`}
                            className="shrink-0 text-ink-faint hover:text-danger">
                      <Icon name="close" className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => dismiss(j.id)} aria-label="Dismiss"
                          className="shrink-0 text-ink-faint hover:text-ink">
                    <Icon name="close" className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {j.status === 'uploading' && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-canvas">
                  <div className="h-full rounded-full bg-brand-600 transition-[width] duration-150"
                       style={{ width: `${j.progress * 100}%` }} />
                </div>
              )}

              {j.status === 'failed' && (
                <p className="mt-1 text-xs text-danger">
                  {/* Verbatim. The server's sentence names whose storage is
                      full and what to do about it. */}
                  {j.error}
                  {j.reason === 'full' && (
                    <> <a href="/account" className="underline">See your storage</a>.</>
                  )}
                </p>
              )}

              {j.status === 'done' && (
                <p className="mt-1 text-xs text-ink-faint">{formatSize(j.sizeBytes)} · uploaded</p>
              )}

              {j.status === 'cancelled' && (
                <p className="mt-1 text-xs text-ink-faint">Cancelled</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
