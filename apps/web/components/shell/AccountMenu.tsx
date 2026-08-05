'use client';

// ============================================================================
//  The account chooser
// ============================================================================
//
//  Several accounts signed in at once, switchable without a password. An IT
//  admin holding accounts in three customers, or someone running their own
//  address alongside hr@, should not have to sign out to move between them.
//
//  Two behaviours are worth keeping deliberately:
//
//  1. SIGNING OUT DOES NOT REMOVE THE ACCOUNT FROM THE LIST. It becomes a
//     "Signed out" row with Sign in / Remove, exactly as in the screenshot
//     this was built from. An account that vanishes on sign-out reads as data
//     loss, and the person then has to remember the address to get back.
//
//  2. NOTHING HERE HOLDS A TOKEN. The list arrives from the API, assembled
//     server-side from httpOnly cookies. Switching is a server call that
//     revalidates the target slot's refresh token. This component knows names
//     and slot numbers, which is all it needs to render.
// ============================================================================

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

import { useAuth, type AccountSlot } from '@/lib/auth';

/** Stable per-address colour, so an account keeps the same tile every time. */
const TILE = ['#7367f0', '#28c76f', '#ff9f43', '#ea5455', '#00cfe8', '#a855f7'];

function tint(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return TILE[h % TILE.length] ?? '#7367f0';
}

function initials(name: string, email: string): string {
  const src = name.trim() || email;
  const parts = src.split(/[\s.@_-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[1]?.[0] ?? '' : '';
  return (a + b).toUpperCase();
}

export function AccountMenu({ anchorEl, onClose }: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { user, accounts, signOut, switchTo, forget, refreshAccounts } = useAuth();

  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The roster changes in another tab too — signing out over there should not
  // leave this menu offering an account that is gone.
  useEffect(() => { if (anchorEl) void refreshAccounts(); }, [anchorEl, refreshAccounts]);

  const others = accounts.filter((a) => a.email !== user?.email);

  async function onSwitch(a: AccountSlot) {
    if (!a.signedIn) { router.push(`/login?email=${encodeURIComponent(a.email)}`); return; }
    setBusy(a.slot);
    setError(null);
    try {
      await switchTo(a.slot);
      onClose();
      // Full navigation, not router.push. Every open screen is holding data
      // for the previous tenant, and a client-side transition would leave
      // stale rows on the page while the new session loads underneath.
      window.location.assign('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch account.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Menu
      anchorEl={anchorEl}
      open={!!anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { width: 340, mt: 0.5, borderRadius: 3, overflow: 'hidden' } } }}
    >
      {/* ---- the account in use ---- */}
      <Box sx={{ px: 2.5, pt: 2, pb: 2.5, textAlign: 'center' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{user?.email}</Typography>
        {accounts.find((a) => a.active)?.organisation && (
          <Typography variant="caption" color="text.secondary">
            Managed by {accounts.find((a) => a.active)?.organisation}
          </Typography>
        )}

        <Avatar sx={{
          width: 72, height: 72, mx: 'auto', my: 2, fontSize: 26, fontWeight: 600,
          bgcolor: tint(user?.email ?? ''),
        }}>
          {initials(user?.displayName ?? '', user?.email ?? '')}
        </Avatar>

        <Typography variant="h6" sx={{ mb: 2 }}>
          Hi, {(user?.displayName ?? '').split(' ')[0] || 'there'}
        </Typography>

        <Button variant="outlined" size="small" href="/account"
                sx={{ borderRadius: 5, px: 2.5 }} onClick={onClose}>
          Manage your account
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mx: 2, mb: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* ---- the other accounts ---- */}
      {others.length > 0 && (
        <Box sx={{ bgcolor: (t) => alpha(t.palette.text.primary, 0.04) }}>
          <MenuItem onClick={() => setExpanded((v) => !v)}
                    sx={{ py: 1.5, display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {expanded ? 'Hide more accounts' : `Show ${others.length} more account${others.length === 1 ? '' : 's'}`}
            </Typography>
            <Box sx={{ display: 'grid', placeItems: 'center',
                       transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </Box>
          </MenuItem>

          <Collapse in={expanded}>
            {others.map((a) => (
              <Box key={a.slot}
                   sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <Avatar sx={{ width: 34, height: 34, fontSize: 13, fontWeight: 600,
                                bgcolor: a.signedIn ? tint(a.email) : 'action.disabledBackground',
                                color: a.signedIn ? '#fff' : 'text.disabled' }}>
                    {initials(a.displayName, a.email)}
                  </Avatar>

                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                      {a.displayName}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap
                                sx={{ display: 'block' }}>
                      {a.email}
                    </Typography>
                  </Box>

                  {a.signedIn ? (
                    <IconButton size="small" disabled={busy !== null}
                                onClick={() => void onSwitch(a)} aria-label={`Switch to ${a.email}`}>
                      {busy === a.slot
                        ? <CircularProgress size={16} />
                        : <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                               stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M9 18l6-6-6-6" />
                          </svg>}
                    </IconButton>
                  ) : (
                    <Typography variant="caption"
                                sx={{ px: 1, py: 0.25, borderRadius: 1, flexShrink: 0,
                                      bgcolor: 'action.hover', color: 'text.secondary' }}>
                      Signed out
                    </Typography>
                  )}
                </Box>

                {!a.signedIn && (
                  <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
                    <Button size="small" variant="contained" sx={{ borderRadius: 5, flex: 1 }}
                            onClick={() => void onSwitch(a)}>
                      Sign in
                    </Button>
                    <Button size="small" variant="outlined" color="inherit"
                            sx={{ borderRadius: 5, flex: 1 }}
                            onClick={() => void forget(a.slot)}>
                      Remove
                    </Button>
                  </Box>
                )}
              </Box>
            ))}
          </Collapse>
        </Box>
      )}

      <Divider />

      <Box sx={{ display: 'flex', gap: 1, p: 1.5 }}>
        <Button fullWidth size="small" variant="outlined" color="inherit"
                sx={{ borderRadius: 5 }}
                onClick={() => { onClose(); router.push('/login?add=1'); }}>
          Add account
        </Button>
        <Button fullWidth size="small" variant="outlined" color="inherit"
                sx={{ borderRadius: 5 }}
                onClick={() => { onClose(); void signOut(); }}>
          Sign out
        </Button>
      </Box>

      {accounts.length > 1 && (
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          <Button fullWidth size="small" color="error" sx={{ borderRadius: 5 }}
                  onClick={() => { onClose(); void signOut(true); }}>
            Sign out of all accounts
          </Button>
        </Box>
      )}

      <Box sx={{ px: 2.5, pb: 2 }}>
        <Typography variant="caption" color="text.disabled">
          Accounts stay signed in on this browser only. On a shared machine use
          &ldquo;Sign out of all accounts&rdquo;.
        </Typography>
      </Box>
    </Menu>
  );
}
