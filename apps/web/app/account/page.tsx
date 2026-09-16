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
//
//  ---------------------------------------------------------------------------
//  CONVERTED OFF MUI. Two notes for whoever edits the layout next.
//
//  Columns are flex or an ENUMERATED grid-cols-*, never an arbitrary template.
//  YZEN ships its own 12-column `.grid` that collides with Tailwind's, and
//  overrides.css can only re-declare the counts listed in it — an arbitrary
//  value like grid-cols-[180px_1fr] silently flattens to one column. This page
//  used Bootstrap's row/col for that reason until 16 Sept 2026; the layouts
//  below are the same shapes in flex and grid-cols-2.
//
//  Tailwind's preflight is off (YZEN's Bootstrap reboot owns the reset), so a
//  bare element keeps its browser defaults. Every list and input below carries
//  an explicit class for that reason.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { PhotoPicker } from '@/components/ui/PhotoPicker';
import { avatarObjectUrl, bustAvatar } from '@/lib/avatars';

import { RequireAuth } from '@/components/RequireAuth';
import { AppLauncher } from '@/components/shell/AppLauncher';
import { AccountMenu } from '@/components/shell/AccountMenu';
import { Badge, Button, Card } from '@/components/ui/Kit';
import { Alert } from '@/components/ui/Page';
import { RecoveryCard } from '@/components/account/RecoveryCard';
import { useAuth } from '@/lib/auth';
import { fetchMyStorage, formatBytes, meterColour, type MyStorage } from '@/lib/myStorage';
import { Input } from '@/components/ui/Form';
import {
  beginMfa, confirmMfa, disableMfa, fetchMfaStatus, groupSecret,
  regenerateRecoveryCodes, type MfaBegin, type MfaStatus,
} from '@/lib/mfa';

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

/** The console green. Fixed rather than read from the theme — MUI's palette
 *  went with MUI, and this is the one brand colour the page needs. */
const BRAND = '#6C3CE9';

/** Replaces MUI's alpha(). Takes #rrggbb and returns an rgba() string. */
function tint(hex: string, a: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
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

/** Replaces MUI's CircularProgress. */
function Spinner({ size = 22 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full"
      style={{
        width: size, height: size,
        border: '2px solid rgba(0,0,0,.12)', borderTopColor: BRAND,
      }}
      role="status"
      aria-label="Loading"
    />
  );
}

// ---------------------------------------------------------------------------
//  Sections
//
//  One page, client-side switching. Routes per section would be more "web",
//  but every section reads from the same three requests — separate pages
//  would refetch what is already on screen to draw a different half of it.
// ---------------------------------------------------------------------------

type SectionId = 'home' | 'personal' | 'security' | 'devices' | 'accounts' | 'storage';

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
    id: 'storage', label: 'Storage', tint: '#4285f4',
    keywords: 'storage space quota full mail files drive usage gb',
    icon: <><path d="M17.5 19H7a5 5 0 1 1 .9-9.92A6 6 0 0 1 19.6 11a4 4 0 0 1-2.1 8z" /></>,
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
  const [hovered, setHovered] = useState<SectionId | null>(null);

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
    <div className="flex flex-col bg-white" style={{ minHeight: '100dvh' }}>

      {/* ---- Top bar --------------------------------------------------- */}
      <div
        className="flex items-center gap-2 px-4 md:px-6 bg-white border-b border-line sticky top-0"
        style={{ paddingTop: 10, paddingBottom: 10, zIndex: 10 }}
      >
        <span style={{ fontSize: 20, fontWeight: 500 }}>
          <span style={{ fontWeight: 700, color: BRAND }}>TatvaOS</span> Account
        </span>
        <div className="flex-auto" />
        <AppLauncher />
        <button
          type="button"
          className="inline-grid shrink-0 place-items-center rounded-full p-1 hover:bg-canvas"
          onClick={(e) => setMenuAnchor(e.currentTarget)}
          aria-label="Account menu"
        >
          <span
            className="grid rounded-full text-white"
            style={{
              width: 34, height: 34, placeItems: 'center',
              fontSize: 15, fontWeight: 600, background: BRAND,
            }}
          >
            {initial}
          </span>
        </button>
        <AccountMenu anchorEl={menuAnchor} onClose={() => setMenuAnchor(null)} />
      </div>

      {/* ---- Body: sections rail + content ----------------------------- */}
      <div className="flex flex-auto" style={{ minHeight: 0 }}>

        <nav
          className="hidden md:block flex-shrink-0 py-4 pe-2 sticky self-start"
          style={{ width: 290, top: 57 }}
        >
          {visible.map((s) => {
            const isActive = s.id === section;
            // Hover is state rather than CSS: the tint is computed per section
            // from its own colour, which a stylesheet rule cannot know.
            const bg = isActive
              ? tint(BRAND, 0.12)
              : hovered === s.id ? tint(BRAND, 0.05) : 'transparent';

            return (
              <div
                key={s.id}
                onClick={() => { setSection(s.id); setQ(''); }}
                onMouseEnter={() => setHovered(s.id)}
                onMouseLeave={() => setHovered(null)}
                className="flex items-center gap-4 px-4 mb-1 select-none"
                style={{
                  paddingTop: 10, paddingBottom: 10, cursor: 'pointer',
                  borderRadius: '0 999px 999px 0', background: bg,
                }}
              >
                <span
                  className="grid rounded-full flex-shrink-0"
                  style={{
                    width: 38, height: 38, placeItems: 'center',
                    background: tint(s.tint, 0.15), color: s.tint,
                  }}
                >
                  <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="1.8"
                       strokeLinecap="round" strokeLinejoin="round">
                    {s.icon}
                  </svg>
                </span>
                <span className="text-[0.875rem]" style={{ fontWeight: isActive ? 600 : 500 }}>
                  {s.label}
                </span>
              </div>
            );
          })}
          {visible.length === 0 && (
            <p className="text-[0.875rem] text-ink-muted px-4 py-4 mb-0">Nothing matches “{q}”.</p>
          )}
        </nav>

        <div className="flex-auto px-4 md:px-6" style={{ minWidth: 0, overflowY: 'auto', paddingBottom: 64 }}>
          <div className="mx-auto" style={{ maxWidth: 760 }}>

            {section === 'home' && (
              <>
                <div className="text-center" style={{ paddingTop: 48, paddingBottom: 32 }}>
                  <div className="flex justify-center mb-4">
                    <PhotoPicker
                      preview={myPhoto}
                      name={user?.displayName}
                      email={user?.email}
                      onPick={(d) => void updatePhoto(d)}
                      onRemove={() => void updatePhoto(null)}
                      disabled={photoBusy}
                      size={96}
                    />
                  </div>
                  {photoError && (
                    <p className="text-[0.875rem] text-danger mb-2">{photoError}</p>
                  )}
                  <h1 className="mb-0" style={{ fontSize: 30, fontWeight: 500 }}>
                    {user?.displayName}
                  </h1>
                  <p className="text-ink-muted mt-1 mb-0">{user?.email}</p>
                  {me?.organisation && (
                    <span className="mt-4 inline-block">
                      <Badge tone="neutral">Managed by {me.organisation.name}</Badge>
                    </span>
                  )}
                </div>

                {/* The search pill. The icon is positioned rather than an input
                    group, so the field keeps its fully rounded shape. */}
                <div className="relative" style={{ marginBottom: 40 }}>
                  <span
                    className="absolute text-ink-muted flex items-center"
                    style={{ left: 18, top: 0, bottom: 0, pointerEvents: 'none' }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" />
                    </svg>
                  </span>
                  <Input
                    type="text"
                    
                    style={{ paddingLeft: 46, height: 46 }}
                    placeholder="Search your account settings"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      const first = visible[0];
                      if (e.key === 'Enter' && first && q.trim()) {
                        setSection(first.id); setQ('');
                      }
                    }}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Card title="Security check"
                          subtitle={`Signed in on ${sessions.length || '…'} device${sessions.length === 1 ? '' : 's'}`}>
                      <p className="text-[0.875rem] text-ink-muted mb-4">
                        Review where your account is signed in, and end anything
                        you do not recognise.
                      </p>
                      <Button variant="ghost" onClick={() => setSection('devices')}>Review devices</Button>
                    </Card>
                  </div>
                  <div>
                    <Card title="Password"
                          subtitle={user?.mfaEnabled ? 'Two-step verification is on' : 'Two-step verification is off'}>
                      <p className="text-[0.875rem] text-ink-muted mb-4">
                        A password only you know is the one lock on everything here.
                      </p>
                      <Button variant="ghost" href="/change-password">Change password</Button>
                    </Card>
                  </div>
                </div>
              </>
            )}

            {section !== 'home' && (
              <h2 className="mb-0" style={{ fontSize: 24, fontWeight: 500, paddingTop: 40, paddingBottom: 24 }}>
                {SECTIONS.find((s) => s.id === section)?.label}
              </h2>
            )}

            {section === 'personal' && (
              <Card>
                {loading ? <Spinner /> : (
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
                    <Alert tone="info" className="mt-6 mb-0">
                      Name, email and role are managed by your organisation&apos;s
                      administrator — ask them for a change. Everything on the
                      Security page you control yourself.
                    </Alert>
                  </>
                )}
              </Card>
            )}

            {section === 'security' && (
              <div className="flex flex-col gap-4">
                <Card title="Password"
                      subtitle="Changing it signs out every session, including this one">
                  <Button variant="primary" href="/change-password">Change password</Button>
                </Card>
                <MfaCard />
                <RecoveryCard />
                <Card title="Where you are signed in"
                      subtitle="Every device holding a live session"
                      actions={
                        <Button variant="ghost" onClick={() => setSection('devices')}>
                          See devices
                        </Button>
                      }>
                  <p className="text-[0.875rem] text-ink-muted mb-0">
                    {sessions.length} active session{sessions.length === 1 ? '' : 's'}.
                  </p>
                </Card>
              </div>
            )}

            {section === 'devices' && (
              <Card actions={
                <Button variant="ghost" onClick={() => void signOut(true)}>
                  Sign out everywhere
                </Button>
              }>
                {loading ? (
                  <div className="flex justify-center py-6">
                    <Spinner />
                  </div>
                ) : sessions.length === 0 ? (
                  <p className="text-[0.875rem] text-ink-muted mb-0">No sessions.</p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {sessions.map((s) => (
                      <div key={s.id} className="flex gap-2 items-start">
                        <span className="text-ink-muted" style={{ marginTop: 2 }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                               stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                            <rect x="3" y="4" width="18" height="12" rx="2" />
                            <path d="M8 20h8M12 16v4" />
                          </svg>
                        </span>
                        <div className="flex-auto" style={{ minWidth: 0 }}>
                          <div className="text-[0.875rem]">{describeAgent(s.userAgent)}</div>
                          <div className="text-[0.75rem] text-ink-muted">
                            {s.ipAddress ?? 'unknown address'} · started {when(s.issuedAt)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <Alert tone="info" className="mt-6 mb-0">
                  Signing out everywhere also ends this one. Changing your password
                  does the same thing — which is what you want if the reason for
                  changing it is that somebody else knows it.
                </Alert>
              </Card>
            )}

            {section === 'storage' && <StorageSection />}

            {section === 'accounts' && (
              <Card subtitle="Switch between them from the avatar in the top right — no password needed">
                {accounts.length <= 1 ? (
                  <p className="text-[0.875rem] text-ink-muted mb-0">
                    Only this account is on this browser. Add another from the
                    avatar menu in the top right.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {accounts.map((a) => (
                      <div key={a.slot} className="flex items-center gap-2">
                        <span
                          className="rounded-full flex-shrink-0"
                          style={{
                            width: 8, height: 8,
                            background: a.signedIn ? '#22a35b' : '#adb5bd',
                          }}
                        />
                        <span className="text-[0.875rem] flex-auto truncate">
                          {a.email}{a.active ? ' — this one' : ''}
                        </span>
                        <span className="text-[0.75rem] text-ink-muted">
                          {a.signedIn ? 'Signed in' : 'Signed out'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[0.75rem] text-ink-muted block mt-4 mb-0">
                  They stay on this browser only. On a shared machine, use sign
                  out everywhere on the devices page.
                </p>
              </Card>
            )}

            <hr style={{ marginTop: 64, marginBottom: 16 }} />
            <p className="text-[0.75rem] text-ink-muted text-center mb-0">
              Only you can see your settings.
              {active?.organisation ? ` Your account is managed by ${active.organisation}.` : ''}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function InfoRow({ label, value, capitalize, last }: {
  label: string; value: string; capitalize?: boolean; last?: boolean;
}) {
  return (
    // A third/two-thirds split on anything wider than a phone, stacked below
    // it. Flex rather than a grid template: an arbitrary template would be
    // flattened by YZEN's .grid (see the note at the top of this file).
    <div
      className={`flex flex-col gap-1 sm:flex-row ${last ? '' : 'border-b border-line'}`}
      style={{ paddingTop: 14, paddingBottom: 14 }}
    >
      <div className="sm:w-1/3">
        <span
          className="text-[0.75rem] text-ink-muted uppercase block"
          style={{ letterSpacing: '0.4px', paddingTop: 2 }}
        >
          {label}
        </span>
      </div>
      <div className="min-w-0 sm:w-2/3">
        <span className="text-[0.875rem]" style={{ textTransform: capitalize ? 'capitalize' : 'none' }}>
          {value}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Two-step verification
// ---------------------------------------------------------------------------
//
//  Three states in one card: off, mid-enrolment, and on. Kept together because
//  they are one story — splitting them across dialogs would mean the recovery
//  codes appear in a modal that can be dismissed, and those are shown exactly
//  once.
//
//  THE QR IS GENERATED IN THIS BROWSER, and that is the whole reason the
//  `qrcode` dependency exists. The otpauth:// URI contains the TOTP secret, so
//  rendering it through any QR image service — however convenient — would hand
//  the second factor to a third party. It never leaves the page.
//
//  The typed key stays below it. Cameras fail, desktop authenticators have no
//  camera at all, and a scan-only flow strands those people.

function MfaCard() {
  const { authedFetch } = useAuth();

  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<MfaBegin | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchMfaStatus(authedFetch));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your settings.');
    }
  }, [authedFetch]);

  useEffect(() => { void load(); }, [load]);

  // Rendered locally from the provisioning URI. A failure here is not fatal —
  // the typed key below still works — so it resolves to null rather than
  // throwing into the card's error state.
  useEffect(() => {
    if (!setup) { setQr(null); return; }
    let alive = true;
    QRCode.toDataURL(setup.otpauthUri, { width: 200, margin: 1 })
      .then((url) => { if (alive) setQr(url); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [setup]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  // The codes replace everything else while they are on screen. They cannot be
  // shown again, so a card that also offers other buttons invites someone to
  // click one and lose them.
  if (codes) {
    return (
      <Card title="Save your recovery codes"
            subtitle="Each one works once. They are the only way in if you lose your phone.">
        <Alert tone="warn">
          These are shown <strong>once</strong> and cannot be retrieved later.
          Print them, or put them in a password manager — not in the same place
          as your phone.
        </Alert>

        <ul className="list-none pl-0 font-mono rounded bg-canvas p-4 mb-4"
            style={{ columnCount: 2, columnGap: 24 }}>
          {codes.map((c) => <li key={c} className="py-1">{c}</li>)}
        </ul>

        <div className="flex gap-2">
          <Button variant="secondary"
                  onClick={() => void navigator.clipboard.writeText(codes.join('\n'))}>
            Copy all
          </Button>
          <Button variant="primary"
                  onClick={() => { setCodes(null); setSetup(null); setCode(''); void load(); }}>
            I have saved them
          </Button>
        </div>
      </Card>
    );
  }

  // Mid-enrolment: a secret exists, nothing is on yet.
  if (setup) {
    return (
      <Card title="Set up two-step verification"
            subtitle="Add TatvaOS to your authenticator app, then enter the code it shows">
        {error && <Alert tone="danger">{error}</Alert>}

        <ol className="ps-4 text-[0.875rem] mb-4">
          <li className="mb-2">
            Open your authenticator app — Google Authenticator, Authy, 1Password
            or Microsoft Authenticator all work.
          </li>
          <li className="mb-2">
            Scan this with the app:
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="QR code for your authenticator app"
                   width={200} height={200}
                   className="block my-2 rounded border border-line bg-white p-2" />
            ) : (
              <div className="my-2 text-[0.8125rem] text-ink-muted">
                The QR could not be drawn — use the key below instead.
              </div>
            )}
          </li>
          <li className="mb-2">
            No camera? Enter this key by hand instead:
            <div className="font-mono rounded bg-canvas p-4 my-2"
                 style={{ fontSize: 15, letterSpacing: '0.05em', wordBreak: 'break-all' }}>
              {groupSecret(setup.secret)}
            </div>
            <Button variant="ghost"
                    onClick={() => void navigator.clipboard.writeText(setup.secret)}>
              Copy key
            </Button>
          </li>
          <li>Enter the six-digit code it shows.</li>
        </ol>

        <div className="mb-4" style={{ maxWidth: 220 }}>
          <label className="mb-1 block text-[0.8125rem] font-medium text-ink" htmlFor="tv-mfa-confirm">
            Code from your app
          </label>
          <Input
            id="tv-mfa-confirm"
            
            inputMode="numeric"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </div>

        <div className="flex gap-2">
          <Button variant="ghost" disabled={busy}
                  onClick={() => { setSetup(null); setCode(''); setError(null); }}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || code.length !== 6}
                  onClick={() => void run(async () => {
                    const done = await confirmMfa(authedFetch, code);
                    setCodes(done.recoveryCodes);
                  })}>
            {busy ? 'Checking…' : 'Turn it on'}
          </Button>
        </div>
      </Card>
    );
  }

  // On.
  if (status?.enabled) {
    return (
      <Card title="Two-step verification"
            subtitle="On — a code from your app is required alongside your password">
        {error && <Alert tone="danger">{error}</Alert>}

        <p className="text-[0.875rem] text-ink-muted">
          {status.recoveryCodesRemaining === 0
            ? 'You have no recovery codes left. Generate a new set — without one, losing your phone means asking an administrator to reset this.'
            : `${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.`}
        </p>

        <div className="mb-4" style={{ maxWidth: 320 }}>
          <label className="mb-1 block text-[0.8125rem] font-medium text-ink" htmlFor="tv-mfa-pw">
            Your password
          </label>
          <Input
            id="tv-mfa-pw"
            
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {/* Asked for because a live session is not enough to weaken the
              factor — a borrowed unlocked laptop is exactly what it defends
              against. */}
          <div className="mt-1 text-[0.75rem] text-ink-muted">Required to change these settings.</div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button variant="secondary" disabled={busy || password.length === 0}
                  onClick={() => void run(async () => {
                    const fresh = await regenerateRecoveryCodes(authedFetch, password);
                    setPassword('');
                    setCodes(fresh.recoveryCodes);
                  })}>
            New recovery codes
          </Button>
          <Button variant="ghost" disabled={busy || password.length === 0}
                  onClick={() => void run(async () => {
                    await disableMfa(authedFetch, password);
                    setPassword('');
                    await load();
                  })}>
            Turn off
          </Button>
        </div>
      </Card>
    );
  }

  // Off.
  return (
    <Card title="Two-step verification"
          subtitle="Off — your password alone signs you in">
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="text-[0.875rem] text-ink-muted">
        Ask for a code from your phone as well as your password. It means a
        stolen password on its own is not enough to reach your account or your
        mail.
      </p>

      {status?.enrolmentPending && (
        <Alert tone="info" className="py-2">
          You started setting this up and did not finish. Starting again
          replaces the earlier key.
        </Alert>
      )}

      <Button variant="primary" disabled={busy}
              onClick={() => void run(async () => setSetup(await beginMfa(authedFetch)))}>
        {busy ? 'Starting…' : status?.enrolmentPending ? 'Start again' : 'Turn it on'}
      </Button>
    </Card>
  );
}

/**
 * Where the one allowance is spent.
 *
 * The rails show a single number; this is the answer to the question that
 * always follows it — "full of what". Per product, heaviest first, because
 * somebody reading this is deciding what to delete.
 */
function StorageSection() {
  const { authedFetch } = useAuth();
  const [s, setS] = useState<MyStorage | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchMyStorage(authedFetch).then(setS).catch(() => setErr('Could not load your storage.'));
  }, [authedFetch]);

  if (err) return <Card title="Storage"><p className="text-[0.875rem] text-danger mb-0">{err}</p></Card>;
  if (!s) return <Card title="Storage"><Spinner /></Card>;

  const pct = Math.min(100, s.usedFraction * 100);

  return (
    <div className="flex flex-col gap-4">
      <Card title="Your storage" subtitle={s.note}>
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-[1.5rem] font-semibold">{formatBytes(s.usedBytes)}</span>
          <span className="text-[0.875rem] text-ink-muted">of {formatBytes(s.quotaBytes)} used</span>
        </div>

        <div style={{ height: 10, borderRadius: 999, background: 'rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999,
                        background: meterColour(s.usedFraction), transition: 'width 200ms ease' }} />
        </div>

        <p className="text-[0.8125rem] text-ink-muted mt-2 mb-0">
          {formatBytes(s.availableBytes)} still free.
          {s.isCritical
            ? ' You are nearly out — new mail and uploads will be refused.'
            : s.isWarning
              ? ' Worth clearing some space before it runs out.'
              : ''}
        </p>
      </Card>

      <Card title="What is using it" subtitle="Heaviest first">
        {s.products.length === 0 ? (
          <p className="text-[0.875rem] text-ink-muted mb-0">Nothing stored yet.</p>
        ) : s.products.map((p) => {
          const share = s.usedBytes > 0 ? (p.usedBytes / s.usedBytes) * 100 : 0;
          return (
            <div key={p.code} className="mb-4">
              <div className="flex justify-between text-[0.875rem] mb-1">
                <span className="font-semibold">{p.name}</span>
                <span className="text-ink-muted">{formatBytes(p.usedBytes)}</span>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: 'rgba(0,0,0,.06)', overflow: 'hidden' }}>
                {/* Share of what is USED, not of the quota — this bar answers
                    "which product should I clear out", and against a mostly
                    empty quota every bar would otherwise look like nothing. */}
                <div style={{ height: '100%', width: `${share}%`, borderRadius: 999,
                              background: p.code === 'mail' ? '#ff4c51' : '#28c76f' }} />
              </div>
            </div>
          );
        })}

        <p className="text-[0.75rem] text-ink-muted mb-0">
          Files in Space that are in the trash still take up room until they are
          purged, thirty days after you delete them.
        </p>
      </Card>
    </div>
  );
}
