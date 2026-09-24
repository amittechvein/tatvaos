import { redirect } from 'next/navigation';

/**
 * Never a page of its own. New-sign-in emails sent before 24 Sept 2026 link
 * here for "Change my password" — the button a worried reader presses.
 */
export default function AccountPasswordRedirect() {
  redirect('/change-password');
}
