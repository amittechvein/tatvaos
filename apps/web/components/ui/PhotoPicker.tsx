'use client';

import { useRef, useState } from 'react';
import { avatarHue, initials } from '@tatvaos/core';
import { toSquareDataUrl } from '@/lib/avatars';

/**
 * Pick, preview and clear a profile photo.
 *
 * The file is cropped and resized in the browser before it ever leaves (see
 * lib/avatars), so what the preview shows is exactly what gets stored, and the
 * server's size limit is never reached. Rejections are reported here, next to
 * the control, rather than thrown at the surrounding form — picking the wrong
 * file should not look like the form failed to save.
 */
export function PhotoPicker({
  preview,
  name,
  email,
  onPick,
  onRemove,
  disabled,
  size = 72,
}: {
  /** Data URL of a newly picked photo, or an object URL of the stored one. */
  preview: string | null;
  name?: string | null;
  email?: string;
  onPick: (dataUrl: string) => void;
  /** Omitted when there is nothing that could be removed. */
  onRemove?: () => void;
  disabled?: boolean;
  size?: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onPick(await toSquareDataUrl(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be used.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-4">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            className="shrink-0 rounded-full object-cover"
            style={{ width: size, height: size }}
          />
        ) : (
          <div
            className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
            style={{
              width: size,
              height: size,
              fontSize: size * 0.36,
              backgroundColor: `hsl(${avatarHue(email || name || 'x')} 55% 45%)`,
            }}
            aria-hidden="true"
          >
            {name || email ? initials({ name: name ?? undefined, email: email ?? '' }) : '?'}
          </div>
        )}

        <div className="flex flex-col items-start gap-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-canvas disabled:opacity-50"
            >
              {busy ? 'Processing…' : preview ? 'Change photo' : 'Add photo'}
            </button>

            {preview && onRemove && (
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => { setError(null); onRemove(); }}
                className="rounded-lg px-2 py-1.5 text-sm text-ink-muted transition hover:text-danger disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>

          <p className="text-xs text-ink-muted">
            JPEG, PNG, WebP or GIF. Cropped to a square automatically.
          </p>
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void handle(e.target.files?.[0]);
          // Cleared so re-picking the SAME file still fires a change event.
          e.target.value = '';
        }}
      />
    </div>
  );
}
