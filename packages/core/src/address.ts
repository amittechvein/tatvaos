import type { Address } from '@tatvaos/types';

/** Display name if present, otherwise the local part - never a raw empty string. */
export function displayName(a: Address): string {
  if (a.name && a.name.trim()) return a.name.trim();
  const local = a.email.split('@')[0] ?? a.email;
  return local;
}

export function initials(a: Address): string {
  const name = displayName(a);
  const parts = name.split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/** Deterministic colour per address, so the same person looks the same everywhere. */
export function avatarHue(email: string): number {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

export function formatRecipients(list: Address[], max = 3): string {
  if (list.length === 0) return '';
  const shown = list.slice(0, max).map(displayName).join(', ');
  const rest = list.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}
