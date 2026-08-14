// ============================================================================
//  Two-step verification
// ============================================================================
//
//  Enrolment is three calls, and the middle one is the point:
//
//    begin    a secret comes back. Nothing about the account has changed.
//    confirm  a code from the app proves it works. NOW it is on, and the
//             recovery codes are returned — once, and never again.
//    disable  password required.
//
//  The sign-in half lives in lib/auth.tsx, because it happens before there is
//  a session to hang it off.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface MfaStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
  /** A secret was generated but never confirmed — offer to start again. */
  enrolmentPending: boolean;
}

export interface MfaBegin {
  /** Base32, for typing into an app by hand when a camera will not cooperate. */
  secret: string;
  /** otpauth:// — what a QR encodes. NEVER send this to a third party. */
  otpauthUri: string;
}

export interface MfaConfirmed {
  enabled: boolean;
  recoveryCodes: string[];
  note: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return typeof body.error === 'string' ? body.error : fallback;
}

export async function fetchMfaStatus(authedFetch: AuthedFetch): Promise<MfaStatus> {
  const res = await authedFetch('/auth/mfa');
  if (!res.ok) throw new Error(await readError(res, 'Could not load your settings.'));
  return res.json();
}

export async function beginMfa(authedFetch: AuthedFetch): Promise<MfaBegin> {
  const res = await authedFetch('/auth/mfa/begin', { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Could not start the setup.'));
  return res.json();
}

export async function confirmMfa(
  authedFetch: AuthedFetch, code: string,
): Promise<MfaConfirmed> {
  const res = await authedFetch('/auth/mfa/confirm', {
    method: 'POST',
    body: JSON.stringify({ code: code.trim() }),
  });
  if (!res.ok) throw new Error(await readError(res, 'That code was not accepted.'));
  return res.json();
}

export async function disableMfa(
  authedFetch: AuthedFetch, password: string,
): Promise<void> {
  const res = await authedFetch('/auth/mfa/disable', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not turn it off.'));
}

export async function regenerateRecoveryCodes(
  authedFetch: AuthedFetch, password: string,
): Promise<MfaConfirmed> {
  const res = await authedFetch('/auth/mfa/recovery-codes', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not issue new codes.'));
  return res.json();
}

/**
 * The secret in groups of four.
 *
 * Not decoration: this is read off one screen and typed into a phone, and an
 * unbroken 32-character string is where people lose their place. The server
 * ignores spaces, so the grouping costs nothing.
 */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? [secret]).join(' ');
}
