// Indian formats (NF-10): money as ₹1,23,456 and dates as DD/MM/YYYY or "10 October".
// Written by hand rather than with Intl so every phone shows the same grouping.

export function inr(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  const neg = v < 0;
  const s = String(Math.abs(v));
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}₹${rest ? `${rest},${last3}` : last3}`;
}

/** "2026-10-07" (or an ISO timestamp) → a Date at noon UTC of that day, so time zones never shift it. */
export function dayOf(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function ddmmyyyy(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** Today in India as YYYY-MM-DD, whatever the phone's own zone. */
export function todayIndia(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

/** The ten digits of an Indian mobile number, or null ("+91 98765 43210" → "9876543210"). */
export function tenDigits(input: string): string | null {
  const d = input.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
