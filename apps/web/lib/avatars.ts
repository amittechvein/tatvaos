// ============================================================================
//  Profile photos
// ============================================================================
//
//  Two jobs live here: turning a picked file into something small enough to
//  send, and fetching a stored photo for display.
//
//  The fetch half exists because the avatar endpoint is authenticated. An
//  <img src="/api/org/users/x/avatar"> does NOT carry the bearer token — the
//  browser issues that request on its own — so the image has to be fetched with
//  authedFetch and handed to the <img> as an object URL instead.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** What the server accepts. Checked here so a wrong file fails instantly. */
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** The server's ceiling. We resize well below it, so this is a backstop. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Stored edge length. 256 is retina-sharp at every size we render (≤96px). */
const OUTPUT_PX = 256;

// ---------------------------------------------------------------------------
//  Object-URL cache
//
//  Keyed by user id and shared across every component, so a list of fifty
//  people fetches each photo once rather than once per row and once per
//  re-render. Entries are promises: two rows mounting in the same tick share
//  one request instead of racing.
//
//  Nothing is revoked on unmount — the URL is cached, not owned by a component.
//  bustAvatar() is the single place a URL is released, called after an upload or
//  a delete so the next read re-fetches.
// ---------------------------------------------------------------------------
const cache = new Map<string, Promise<string | null>>();

// Anything currently showing a photo needs to know when it is replaced: the
// object URL it is holding gets revoked below, which would otherwise leave a
// broken image on screen until that component happened to remount.
type Listener = (userId: string) => void;
const listeners = new Set<Listener>();

/** Subscribe to photo changes. Returns the unsubscribe function. */
export function onAvatarChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function avatarObjectUrl(authedFetch: AuthedFetch, userId: string): Promise<string | null> {
  const hit = cache.get(userId);
  if (hit) return hit;

  const pending = authedFetch(`/org/users/${userId}/avatar`)
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b && b.size > 0 ? URL.createObjectURL(b) : null))
    // A missing or failed photo is not an error worth surfacing — the caller
    // falls back to initials, which is a perfectly good avatar.
    .catch(() => null);

  cache.set(userId, pending);
  return pending;
}

/** Forget (and release) a cached photo — after replacing or removing one. */
export function bustAvatar(userId: string): void {
  const pending = cache.get(userId);
  cache.delete(userId);
  pending?.then((url) => { if (url) URL.revokeObjectURL(url); }).catch(() => {});
  listeners.forEach((fn) => fn(userId));
}

// ---------------------------------------------------------------------------
//  File → square data URL
// ---------------------------------------------------------------------------
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
    img.src = url;
  });
}

/**
 * Centre-crops to a square, scales to 256px and returns a JPEG data URL.
 *
 * Resizing here rather than validating-and-rejecting means the 2 MB cap is
 * effectively unreachable: a 12 MP phone photo lands around 20 KB. The person
 * picking the file never has to think about dimensions or file size.
 *
 * Output is always JPEG on a white background. JPEG has no alpha, so a
 * transparent PNG would otherwise composite onto black. An animated GIF becomes
 * its first frame — an animated avatar is not a feature anyone asked for.
 */
export async function toSquareDataUrl(file: File): Promise<string> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error('Choose a JPEG, PNG, WebP or GIF image.');
  }

  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error('That image appears to be empty.');

  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_PX;
  canvas.height = OUTPUT_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not process the image.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, OUTPUT_PX, OUTPUT_PX);
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
    0, 0, OUTPUT_PX, OUTPUT_PX,
  );

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  // base64 carries ~4 characters per 3 bytes; this is a guard, not a real limit.
  if (dataUrl.length * 0.75 > MAX_UPLOAD_BYTES) {
    throw new Error('That image is still too large after resizing.');
  }
  return dataUrl;
}
