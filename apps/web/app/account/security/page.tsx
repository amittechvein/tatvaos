import { redirect } from 'next/navigation';

/**
 * Never a page of its own. New-sign-in emails sent before 24 Sept 2026 link
 * here for "review every active session"; the session list lives in the
 * account hub's devices section.
 */
export default function AccountSecurityRedirect() {
  redirect('/account?section=devices');
}
