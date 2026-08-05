'use client';

// ============================================================================
//  Your account
// ============================================================================
//
//  The person's own settings, as opposed to the organisation's. Deliberately
//  separate from /org: an admin editing their own password should not be on a
//  screen that also edits everyone else's.
//
//  The session list is the point of this page. Somebody who suspects their
//  account has been used elsewhere needs to see where it is signed in and end
//  those sessions themselves, without waiting on an admin.
// ============================================================================

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';

import { AdminShell } from '@/components/admin/AdminShell';
import { Button, Card } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';

interface SessionRow {
  id: string;
  issuedAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
}

/** Enough to recognise your own devices; not a fingerprinting exercise. */
function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}

function when(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function AccountPage() {
  const { user, accounts, authedFetch, signOut } = useAuth();

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await authedFetch('/auth/sessions');
    if (res.ok) setSessions(await res.json());
    setLoading(false);
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  const active = accounts.find((a) => a.active);

  return (
    <AdminShell scope="organisation" title="Your account"
                subtitle="Your sign-in, your devices">
      <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
        <Card>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 3 }}>
            <Avatar sx={{ width: 56, height: 56, fontSize: 20, fontWeight: 600,
                          bgcolor: 'primary.main' }}>
              {(user?.displayName ?? '?').charAt(0).toUpperCase()}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h6" noWrap>{user?.displayName}</Typography>
              <Typography variant="body2" color="text.secondary" noWrap>{user?.email}</Typography>
              {active?.organisation && (
                <Typography variant="caption" color="text.disabled">
                  Managed by {active.organisation}
                </Typography>
              )}
            </Box>
          </Box>

          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 3 }}>
            <Chip size="small" label={(user?.role ?? '').replace(/_/g, ' ')}
                  sx={{ textTransform: 'capitalize' }} />
            <Chip size="small" color={user?.mfaEnabled ? 'success' : 'default'}
                  label={user?.mfaEnabled ? 'Two-step verification on' : 'Two-step verification off'} />
          </Box>

          <Button variant="primary" href="/change-password">Change password</Button>
        </Card>

        <Card
          title="Where you are signed in"
          subtitle="Every device holding a live session for this account"
          actions={
            <Button variant="ghost" onClick={() => void signOut(true)}>
              Sign out everywhere
            </Button>
          }
        >
          {loading ? (
            <Box sx={{ display: 'grid', placeItems: 'center', py: 4 }}>
              <CircularProgress size={22} />
            </Box>
          ) : sessions.length === 0 ? (
            <Typography variant="body2" color="text.disabled">No other sessions.</Typography>
          ) : (
            <Box sx={{ display: 'grid', gap: 2 }}>
              {sessions.map((s) => (
                <Box key={s.id} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                  <Box sx={{ mt: 0.25, color: 'text.secondary' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <rect x="3" y="4" width="18" height="12" rx="2" />
                      <path d="M8 20h8M12 16v4" />
                    </svg>
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2">{describeAgent(s.userAgent)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {s.ipAddress ?? 'unknown address'} · started {when(s.issuedAt)}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Box>
          )}

          <Alert severity="info" sx={{ mt: 3 }}>
            Signing out everywhere also ends this one. Changing your password
            does the same thing — which is what you want if the reason for
            changing it is that somebody else knows it.
          </Alert>
        </Card>
      </Box>

      {accounts.length > 1 && (
        <Card className="mt-6" title="Other accounts on this browser"
              subtitle="Switch between them from the avatar in the top right — no password needed">
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            {accounts.filter((a) => !a.active).map((a) => (
              <Box key={a.slot} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                           bgcolor: a.signedIn ? 'success.main' : 'text.disabled' }} />
                <Typography variant="body2" sx={{ flex: 1 }} noWrap>{a.email}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {a.signedIn ? 'Signed in' : 'Signed out'}
                </Typography>
              </Box>
            ))}
          </Box>
          <Typography variant="caption" color="text.disabled"
                      sx={{ display: 'block', mt: 2 }}>
            They stay on this browser only. On a shared machine, use{' '}
            <Link href="#" onClick={(e) => { e.preventDefault(); void signOut(true); }}>
              sign out everywhere
            </Link>.
          </Typography>
        </Card>
      )}
    </AdminShell>
  );
}
