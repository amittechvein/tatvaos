// ============================================================================
//  Account recovery — the two ways back in without a password
// ============================================================================
//
//  Recovery email   set → a link is mailed → clicking it verifies. Until then
//                   the address is held but not trusted.
//  Recovery number  request → a code is texted TO THE NEW NUMBER → verify
//                   swaps it in. The old number stays live until the new one
//                   has proved itself.
//
//  The nudge card (components/RecoveryReminder.tsx) reads the same status
//  endpoint; the account page reads the extra fields.
//
//  EVERY CHANGE NEEDS THE CURRENT PASSWORD, from 15 September 2026. Without it,
//  anyone at an unlocked, signed-in laptop could add their own recovery email,
//  reset the password and keep the account. The server answers 403 (not 401,
//  which the auth client would treat as an expired session) when the password
//  is missing or wrong. Resending to an address or number that is ALREADY
//  pending needs no password, so those calls may omit it.
// ============================================================================

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface RecoveryStatus {
  hasPhone: boolean;
  hasVerifiedRecoveryEmail: boolean;
  needsAttention: boolean;
  phone: string | null;
  /** A new number waiting for its code — present only while the code is live. */
  pendingPhone: string | null;
  recoveryEmail: string | null;
  recoveryEmailVerified: boolean;
  /** When the last verification link went out; null once verified. */
  recoveryEmailSentAt: string | null;
}

export interface SentReply { sent: boolean; message: string; }
export interface CodeSentReply extends SentReply {
  /** Echoed only when SMS failed AND the testing-mode setting is on. */
  devCode: string | null;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return typeof body.error === 'string' ? body.error : fallback;
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function fetchRecoveryStatus(authedFetch: AuthedFetch): Promise<RecoveryStatus> {
  const res = await authedFetch('/auth/recovery-status');
  if (!res.ok) throw new Error(await readError(res, 'Could not load your recovery settings.'));
  return res.json();
}

export async function setRecoveryEmail(
  authedFetch: AuthedFetch, email: string, currentPassword?: string,
): Promise<SentReply> {
  const res = await authedFetch('/auth/recovery-email', post({ email, currentPassword }));
  if (!res.ok) throw new Error(await readError(res, 'Could not save that address.'));
  return res.json();
}

export async function removeRecoveryEmail(authedFetch: AuthedFetch, currentPassword: string): Promise<void> {
  const res = await authedFetch('/auth/recovery-email', { ...post({ currentPassword }), method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'Could not remove the recovery email.'));
}

export async function requestPhoneChange(
  authedFetch: AuthedFetch, phone: string, currentPassword?: string,
): Promise<CodeSentReply> {
  const res = await authedFetch('/auth/phone', post({ phone, currentPassword }));
  if (!res.ok) throw new Error(await readError(res, 'Could not send a code to that number.'));
  return res.json();
}

export async function verifyPhoneChange(
  authedFetch: AuthedFetch, code: string,
): Promise<{ verified: boolean; phone: string }> {
  const res = await authedFetch('/auth/phone/verify', post({ code }));
  if (!res.ok) throw new Error(await readError(res, 'That code was not accepted.'));
  return res.json();
}

export async function removePhone(authedFetch: AuthedFetch, currentPassword: string): Promise<void> {
  const res = await authedFetch('/auth/phone', { ...post({ currentPassword }), method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'Could not remove the recovery number.'));
}
