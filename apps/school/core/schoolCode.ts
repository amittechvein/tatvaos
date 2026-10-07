/**
 * The school code from a scanned QR link (https://school.tatvaos.com/s/DEMO) or typed text.
 * Codes are not case-sensitive; the backend accepts the full link too, but the app sends the code.
 */
export function codeFrom(text: string): string {
  const m = text.trim().match(/\/s\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/);
  return (m ? m[1] : text.trim()).toUpperCase();
}
