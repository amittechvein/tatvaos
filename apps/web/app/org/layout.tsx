import { RequireAuth } from '@/components/RequireAuth';

/**
 * The customer's own console — their admins managing their own people.
 *
 * super_admin is included because platform support needs to be able to see
 * what a customer sees when helping them. Every such action is audited with a
 * "platform:" prefix, so it is distinguishable afterwards from something the
 * customer did themselves.
 */
export default function OrgLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth roles={['super_admin', 'org_owner', 'org_admin']}>
      {children}
    </RequireAuth>
  );
}
