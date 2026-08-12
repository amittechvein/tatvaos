import { RequireAuth } from '@/components/RequireAuth';

/**
 * Family — the address book.
 *
 * No role list, unlike /org and /admin. Contacts are not an administrative
 * function: every signed-in person has their own, and the personal/
 * organisational split inside the API is what decides who sees what. Gating
 * this route by role would lock employees out of their own address book.
 */
export default function FamilyLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
