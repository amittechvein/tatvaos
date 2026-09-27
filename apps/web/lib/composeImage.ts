/**
 * A picture file, ready to sit inside a message as a data: URI.
 *
 * The composer holds pictures as data: URIs; the server turns each into a
 * real inline attachment at send (apps/api/Modules/Mail/OutgoingInlineImages).
 * This decides how big that picture is allowed to be on the way in.
 *
 * ── WHY SHRINK ──────────────────────────────────────────────────────────
 *  A phone photo is 4000 px wide and 3–6 MB. Nobody reads mail at 4000 px;
 *  every recipient downloads it anyway, and five of them take a message to
 *  the 25 MB limit. So anything wider than MAX_WIDTH is scaled down, and a
 *  large photo is re-encoded as JPEG. Screenshots stay PNG: JPEG smears text.
 *
 *  GIFs are left exactly as they are — drawing one onto a canvas keeps only
 *  its first frame, which silently turns an animation into a still.
 *  WebP becomes JPEG or PNG: Outlook does not display WebP.
 */

const MAX_WIDTH = 1200;
/** A picture already this small and this narrow is inserted untouched. */
const KEEP_AS_IS_BYTES = 1_000_000;
/** A PNG still bigger than this after scaling is re-encoded as JPEG. */
const PNG_CEILING_BYTES = 2_000_000;
/** The most one picture may add to a message, as a data: URI. */
const MAX_DATA_URL_CHARS = 7_000_000;   // ~5 MB of picture
const GIF_MAX_BYTES = 3_000_000;

const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export class PictureRefused extends Error {}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new PictureRefused('The picture could not be read.'));
    r.readAsDataURL(file);
  });
}

export interface Picture { dataUrl: string; width: number | null }

export async function pictureToDataUrl(file: File): Promise<Picture> {
  if (!ACCEPTED.includes(file.type)) {
    throw new PictureRefused('Only PNG, JPEG, GIF or WebP pictures can go inside a message. Attach other files instead.');
  }

  if (file.type === 'image/gif') {
    if (file.size > GIF_MAX_BYTES) {
      throw new PictureRefused('This GIF is over 3 MB. Attach it as a file instead, so it keeps its animation.');
    }
    let w: number | null = null;
    try { const b = await createImageBitmap(file); w = b.width; b.close(); } catch { /* width unknown is fine */ }
    return { dataUrl: await readAsDataUrl(file), width: w };
  }

  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new PictureRefused('This picture could not be opened. It may be damaged.'); }

  const { width, height } = bitmap;
  if (width <= MAX_WIDTH && file.size <= KEEP_AS_IS_BYTES && file.type !== 'image/webp') {
    bitmap.close();
    return { dataUrl: await readAsDataUrl(file), width };
  }

  const scale = Math.min(1, MAX_WIDTH / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); throw new PictureRefused('This browser could not resize the picture.'); }

  const asJpeg = () => {
    // JPEG has no transparency; without a fill, transparent pixels turn black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  let out: string;
  if (file.type === 'image/png') {
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    out = canvas.toDataURL('image/png');
    // A photo saved as PNG is enormous; a screenshot is not. Measure, don't guess.
    if (out.length * 0.75 > PNG_CEILING_BYTES) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      out = asJpeg();
    }
  } else {
    out = asJpeg();
  }
  bitmap.close();

  if (out.length > MAX_DATA_URL_CHARS) {
    throw new PictureRefused('This picture is still over 5 MB after resizing. Attach it as a file instead.');
  }
  return { dataUrl: out, width: canvas.width };
}

/** The <img> the composer inserts. Width as an attribute too: Outlook reads that one. */
export function pictureTag(dataUrl: string, naturalWidth?: number): string {
  const w = naturalWidth && naturalWidth > 0 ? Math.min(naturalWidth, 600) : undefined;
  return `<img src="${dataUrl}" alt=""${w ? ` width="${w}"` : ''} style="max-width:100%;height:auto;">`;
}
