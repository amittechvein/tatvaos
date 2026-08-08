'use client';

// ============================================================================
//  Your account — the personal hub
// ============================================================================
//
//  Modelled on the account pages people already know: identity in the centre,
//  sections down the left, search across the top. This is the page every
//  EMPLOYEE lands on, so it deliberately does not use AdminShell — the admin
//  chrome offers navigation an employee cannot follow, and a page full of
//  doors that refuse to open reads as broken.
//
//  The session list is still the security heart of it. Somebody who suspects
//  their account is used elsewhere needs to see where it is signed in and end
//  those sessions themselves, without waiting on an admin.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { PhotoPicker } from '@/components/ui/PhotoPicker';
import { avatarObjectUrl, bustAvatar } from '@/lib/avatars';

import { RequireAuth } from '@/components/RequireAuth';
import { AppLauncher } from '@/components/shell/AppLauncher';
import { AccountMenu } from '@/components/shell/AccountMenu';
import { Button, Card } from '@/components/ui/Kit';
import { useAuth } from '@/lib/auth';

// ---------------------------------------------------------------------------
//  Data shapes
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  issuedAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
}

interface Me {
  organisation: { name: string; type: string } | null;
  products: string[];
  mailboxAddress: string | null;
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

// ---------------------------------------------------------------------------
//  Sections
//
//  One page, client-side switching. Routes per section would be more "web",
//  but every section reads from the same three requests — separate pages
//  would refetch what is already on screen to draw a different half of it.
// ---------------------------------------------------------------------------

type SectionId = 'home' | 'personal' | 'security' | 'devices' | 'accounts';

const SECTIONS: {
  id: SectionId; label: string; tint: string; keywords: string; icon: React.ReactNode;
}[] = [
  {
    id: 'home', label: 'Home', tint: '#3563f0',
    keywords: 'home overview start',
    icon: <path d="M3 10.5 12 3l9 7.5M5.5 9.5V21h13V9.5" />,
  },
  {
    id: 'personal', label: 'Personal info', tint: '#22a35b',
    keywords: 'personal info name email phone role organisation department profile',
    icon: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1.3-3.4 3.8-5 7-5s5.7 1.6 7 5" /></>,
  },
  {
    id: 'security', label: 'Security and sign-in', tint: '#f06321',
    keywords: 'security sign-in password change two-step verification 2fa mfa',
    icon: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 018 0v3" /></>,
  },
  {
    id: 'devices', label: 'Your devices', tint: '#a855f7',
    keywords: 'devices sessions signed in browser sign out everywhere',
    icon: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  },
  {
    id: 'accounts', label: 'Accounts on this browser', tint: '#0ca5a5',
    keywords: 'accounts switch profile multiple browser',
    icon: <><circle cx="9" cy="9" r="3" /><circle cx="16.5" cy="10.5" r="2.5" /><path d="M3.5 19c1-2.7 3-4 5.5-4s4.5 1.3 5.5 4M14.5 15.5c2 .2 3.5 1.4 4.5 3.5" /></>,
  },
];

export default function AccountPage() {
  return (
    <RequireAuth>
      <AccountHub />
    </RequireAuth>
  );
}

function AccountHub() {
  const { user, accounts, authedFetch, signOut } = useAuth();

  const [section, setSection] = useState<SectionId>('home');
  const [q, setQ] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const [myPhoto, setMyPhoto] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Asked for unconditionally: this page has no hasAvatar flag to consult, and
  // a 404 simply resolves to null, which renders as initials.
  useEffect(() => {
    const id = user?.id;
    if (!id) return;
    let alive = true;
    avatarObjectUrl(authedFetch, id).then((u) => { if (alive) setMyPhoto(u); });
    return () => { alive = false; };
  }, [authedFetch, user?.id]);

  /**
   * Saves immediately rather than collecting into a Save button — this page has
   * no form to submit, so a picked photo that sat unsaved would be a trap.
   * Passing null removes the photo.
   */
  async function updatePhoto(dataUrl: string | null) {
    const id = user?.id;
    if (!id) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      if (dataUrl === null) {
        const r = await authedFetch(`/org/users/${id}/avatar`, { method: 'DELETE' });
        if (!r.ok) throw new Error('Could not remove the photo.');
        setMyPhoto(null);
      } else {
        const r = await authedFetch(`/org/users/${id}/avatar`, {
          method: 'PUT',
          body: JSON.stringify({ dataUrl }),
        });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.error ?? 'Could not save the photo.');
        // The data URL is a valid src, so the new photo shows without a refetch.
        setMyPhoto(dataUrl);
      }
      bustAvatar(id);
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : 'Could not update the photo.');
    } finally {
      setPhotoBusy(false);
    }
  }

  const load = useCallback(async () => {
    const [meRes, sesRes] = await Promise.all([
      authedFetch('/auth/me'),
      authedFetch('/auth/sessions'),
    ]);
    if (meRes.ok) setMe(await meRes.json());
    if (sesRes.ok) setSessions(await sesRes.json());
    setLoading(false);
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  // The search filters the section list — it is a way IN to a section, not a
  // full-text search over settings we do not have that many of yet.
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return SECTIONS;
    return SECTIONS.filter((s) =>
      s.label.toLowerCase().includes(term) || s.keywords.includes(term));
  }, [q]);

  const active = accounts.find((a) => a.active);
  const initial = (user?.displayName ?? '?').charAt(0).toUpperCase();

  return (
    <Box sx={{ minHeight: '100dvh', bgcolor: 'background.paper',
               display: 'flex', flexDirection: 'column' }}>

      {/* ---- Top bar --------------------------------------------------- */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: { xs: 2, md: 3 },
                 py: 1.25, position: 'sticky', top: 0, zIndex: 10,
                 bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography sx={{ fontSize: 20, fontWeight: 500 }}>
          <Box component="span" sx={{ fontWeight: 700, color: 'primary.main' }}>TatvaOS</Box>
          {' '}Account
        </Typography>
        <Box sx={{ flex: 1 }} />
        <AppLauncher />
        <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} sx={{ p: 0.5 }}>
          <Avatar sx={{ width: 34, height: 34, fontSize: 15, fontWeight: 600,
                        bgcolor: 'primary.main' }}>
            {initial}
          </Avatar>
        </IconButton>
        <AccountMenu anchorEl={menuAnchor} onClose={() => setMenuAnchor(null)} />
      </Box>

      {/* ---- Body: sections rail + content ----------------------------- */}
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>

        <Box component="nav"
             sx={{ width: 290, flexShrink: 0, py: 2, pr: 1,
                   display: { xs: 'none', md: 'block' },
                   position: 'sticky', top: 57, alignSelf: 'flex-start' }}>
          {visible.map((s) => {
            const isActive = s.id === section;
            return (
              <Box key={s.id} onClick={() => { setSection(s.id); setQ(''); }}
                   sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2.5, py: 1.25,
                         mb: 0.5, cursor: 'pointer', userSelect: 'none',
                         borderRadius: '0 999px 999px 0',
                         bgcolor: isActive
                           ? (t) => alpha(t.palette.primary.main, 0.12) : 'transparent',
                         '&:hover': {
                           bgcolor: (t) => alpha(t.palette.primary.main, isActive ? 0.12 : 0.05),
                         } }}>
                <Box sx={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                           display: 'grid', placeItems: 'center',
                           bgcolor: alpha(s.tint, 0.15), color: s.tint }}>
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="1.8"
                       strokeLinecap="round" strokeLinejoin="round">
                    {s.icon}
                  </svg>
                </Box>
                <Typography variant="body2" sx={{ fontWeight: isActive ? 600 : 500 }}>
                  {s.label}
                </Typography>
              </Box>
            );
          })}
          {visible.length === 0 && (
            <Typography variant="body2" color="text.disabled" sx={{ px: 2.5, py: 2 }}>
              Nothing matches “{q}”.
            </Typography>
          )}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, overflowY: 'auto', px: { xs: 2, md: 4 }, pb: 8 }}>
          <Box sx={{ maxWidth: 760, mx: 'auto' }}>

            {section === 'home' && (
              <>
                <Box sx={{ textAlign: 'center', pt: 6, pb: 4 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2.5 }}>
                    <PhotoPicker
                      preview={myPhoto}
                      name={user?.displayName}
                      email={user?.email}
                      onPick={(d) => void updatePhoto(d)}
                      onRemove={() => void updatePhoto(null)}
                      disabled={photoBusy}
                      size={96}
                    />
                  </Box>
                  {photoError && (
                    <Typography variant="body2" sx={{ color: 'error.main', mb: 1.5 }}>
                      {photoError}
                    </Typography>
                  )}
                  <Typography variant="h4" sx={{ fontWeight: 500 }}>
                    {user?.displayName}
                  </Typography>
                  <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
                    {user?.email}
                  </Typography>
                  {me?.organisation && (
                    <Chip size="small" label={`Managed by ${me.organisation.name}`}
                          sx={{ mt: 1.5 }} />
                  )}
                </Box>

                <TextField fullWidth placeholder="Search your account settings"
                           value={q} onChange={(e) => setQ(e.target.value)}
                           onKeyDown={(e) => {
                             const first = visible[0];
                             if (e.key === 'Enter' && first && q.trim()) {
                               setSection(first.id); setQ('');
                             }
                           }}
                           sx={{ mb: 5,
                                 '& .MuiOutlinedInput-root': { borderRadius: 999, px: 1 } }}
                           slotProps={{ input: { startAdornment: (
                             <InputAdornment position="start">
                               <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                                    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                                 <circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" />
                               </svg>
                             </InputAdornment>
                           ) } }} />

                <Box sx={{ display: 'grid', gap: 2.5,
                           gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
                  <Card title="Security check"
                        subtitle={`Signed in on ${sessions.length || '…'} device${sessions.length === 1 ? '' : 's'}`}>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                      Review where your account is signed in, and end anything
                      you do not recognise.
                    </Typography>
                    <Button variant="ghost" onClick={() => setSection('devices')}>Review devices</Button>
                  </Card>
                  <Card title="Password"
                        subtitle={user?.mfaEnabled ? 'Two-step verification is on' : 'Two-step verification is off'}>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                      A password only you know is the one lock on everything here.
                    </Typography>
                    <Button variant="ghost" href="/change-password">Change password</Button>
                  </Card>
                </Box>
              </>
            )}

            {section !== 'home' && (
              <Typography variant="h5" sx={{ fontWeight: 500, pt: 5, pb: 3 }}>
                {SECTIONS.find((s) => s.id === section)?.label}
              </Typography>
            )}

            {section === 'personal' && (
              <Card>
                {loading ? <CircularProgress size={22} /> : (
                  <>
                    <InfoRow label="Name" value={user?.displayName ?? '—'} />
                    <InfoRow label="Sign-in email" value={user?.email ?? '—'} />
                    <InfoRow label="Mailbox"
                             value={me?.mailboxAddress ?? 'No mailbox on this account'} />
                    <InfoRow label="Organisation" value={me?.organisation?.name ?? '—'} />
                    <InfoRow label="Role"
                             value={(user?.role ?? '—').replace(/_/g, ' ')} capitalize />
                    <InfoRow label="Products"
                             value={me?.products?.length ? me.products.join(', ') : '—'}
                             capitalize last />
                    <Alert severity="info" sx={{ mt: 3 }}>
                      Name, email and role are managed by your organisation&apos;s
                      administrator — ask them for a change. Everything on the
                      Security page you control yourself.
                    </Alert>
                  </>
                )}
              </Card>
            )}

            {section === 'security' && (
              <Box sx={{ display: 'grid', gap: 2.5 }}>
                <Card title="Password"
                      subtitle="Changing it signs out every session, including this one">
                  <Button variant="primary" href="/change-password">Change password</Button>
                </Card>
                <Card title="Two-step verification"
                      subtitle={user?.mfaEnabled
                        ? 'On — a code is required alongside your password'
                        : 'Off'}>
                  <Typography variant="body2" color="text.secondary">
                    {user?.mfaEnabled
                      ? 'Managed from your authenticator app.'
                      : 'Coming to this page soon. Until then your password and your phone number (for OTP sign-in) protect this account.'}
                  </Typography>
                </Card>
                <Card title="Where you are signed in"
                      subtitle="Every device holding a live session"
                      actions={
                        <Button variant="ghost" onClick={() => setSection('devices')}>
                          See devices
                        </Button>
                      }>
                  <Typography variant="body2" color="text.secondary">
                    {sessions.length} active session{sessions.length === 1 ? '' : 's'}.
                  </Typography>
                </Card>
              </Box>
            )}

            {section === 'devices' && (
              <Card actions={
                <Button variant="ghost" onClick={() => void signOut(true)}>
                  Sign out everywhere
                </Button>
              }>
                {loading ? (
                  <Box sx={{ display: 'grid', placeItems: 'center', py: 4 }}>
                    <CircularProgress size={22} />
                  </Box>
                ) : sessions.length === 0 ? (
                  <Typography variant="body2" color="text.disabled">No sessions.</Typography>
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
            )}

            {section === 'accounts' && (
              <Card subtitle="Switch between them from the avatar in the top right — no password needed">
                {accounts.length <= 1 ? (
                  <Typography variant="body2" color="text.disabled">
                    Only this account is on this browser. Add another from the
                    avatar menu in the top right.
                  </Typography>
                ) : (
                  <Box sx={{ display: 'grid', gap: 1.5 }}>
                    {accounts.map((a) => (
                      <Box key={a.slot} sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <Box sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                                   bgcolor: a.signedIn ? 'success.main' : 'text.disabled' }} />
                        <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                          {a.email}{a.active ? ' — this one' : ''}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {a.signedIn ? 'Signed in' : 'Signed out'}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                )}
                <Typography variant="caption" color="text.disabled"
                            sx={{ display: 'block', mt: 2 }}>
                  They stay on this browser only. On a shared machine, use sign
                  out everywhere on the devices page.
                </Typography>
              </Card>
            )}

            <Divider sx={{ mt: 8, mb: 2 }} />
            <Typography variant="caption" color="text.disabled" sx={{ textAlign: 'center',
                        display: 'block' }}>
              Only you can see your settings.
              {active?.organisation ? ` Your account is managed by ${active.organisation}.` : ''}
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------

function InfoRow({ label, value, capitalize, last }: {
  label: string; value: string; capitalize?: boolean; last?: boolean;
}) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px 1fr' },
               gap: 0.5, py: 1.75,
               borderBottom: last ? 'none' : '1px solid', borderColor: 'divider' }}>
      <Typography variant="caption" color="text.secondary"
                  sx={{ textTransform: 'uppercase', letterSpacing: 0.4, pt: 0.25 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ textTransform: capitalize ? 'capitalize' : 'none' }}>
        {value}
      </Typography>
    </Box>
  );
}
