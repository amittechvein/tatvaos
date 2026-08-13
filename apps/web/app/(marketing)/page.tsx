'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/lib/auth';
import { homeFor } from '@/components/RequireAuth';

// ============================================================================
//  The front door
// ============================================================================
//
//  Until this existed, `/` redirected straight to sign-in — so anyone who heard
//  about TatvaOS and typed the domain landed on a password prompt with no route
//  to signup at all. The self-service flow was unreachable by the people it was
//  built for.
//
//  Written for one reader: an administrator at an Indian school, clinic or small
//  business who is currently paying for Google Workspace or using free Gmail
//  with their domain, and is not certain those are the same thing.
//
//  ---------------------------------------------------------------------------
//  CONVERTED OFF MUI. Bootstrap's container/row/col replaces Container and the
//  sx grids — YZEN ships a colliding `.grid`, and arbitrary Tailwind values
//  like grid-cols-[repeat(4,1fr)] flatten to one column without warning.
//  Tailwind's preflight is off, so nothing here relies on a normalised default.
// ============================================================================

/** The brand ramp, fixed here now that MUI's palette has gone. */
const BRAND_DARK = '#0a8a4b';
const BRAND = '#03b562';
const BRAND_LIGHT = '#35d68c';

const PILLARS = [
  {
    title: 'One identity, every product',
    body: 'A person exists once. One sign-in reaches Mail today, and Drive, People and Payroll as they arrive. When someone leaves, one action removes all of it — not six.',
    d: 'M16 19v-2a4 4 0 00-8 0v2M12 11a3 3 0 100-6 3 3 0 000 6',
  },
  {
    title: 'Isolated by the database',
    body: 'Your data is separated by PostgreSQL row-level security, not by application code remembering to filter. It holds even when the code is wrong — which is the only kind of guarantee worth having.',
    d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  },
  {
    title: 'Storage bought once, split by you',
    body: 'Buy one number and divide it across products yourself. Move space from Mail to Drive whenever you like — no new purchase, no support ticket.',
    d: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7',
  },
  {
    title: 'Hosted in India',
    body: 'Your data stays in-region for DPDP compliance, with a full audit trail of every administrative action taken on your organisation — including by us.',
    d: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18a15 15 0 010-18',
  },
];

const STEPS = [
  { n: '1', title: 'Tell us about your organisation', body: 'Name, type, and who you are. Two minutes.' },
  { n: '2', title: 'Prove you own your domain', body: 'One record, four ways to add it. Pick whichever you can actually do.' },
  { n: '3', title: 'Start using it', body: 'Create people and categories immediately. Your existing email is untouched.' },
  { n: '4', title: 'Move your mail when ready', body: 'A separate step, inside your console, on your schedule. Reversible.' },
];

export default function Landing() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Someone already signed in has no use for a sales page.
  useEffect(() => {
    if (loading || !user) return;
    router.replace(homeFor(user.role));
  }, [loading, user, router]);

  return (
    <div className="bg-white">
      {/* ---------------------------------------------------------------- */}
      <header
        className="position-sticky top-0 border-bottom"
        style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(8px)', zIndex: 20 }}
      >
        <div className="container py-2">
          <div className="d-flex align-items-center gap-3">
            <Brand />
            <div className="ms-auto d-flex gap-2 align-items-center">
              <Link href="/login" className="btn btn-link text-body text-decoration-none">Sign in</Link>
              <Link href="/signup" className="btn btn-primary">Get started</Link>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      <section
        className="position-relative text-white"
        style={{
          overflow: 'hidden',
          background: `linear-gradient(135deg, ${BRAND_DARK} 0%, ${BRAND} 55%, ${BRAND_LIGHT} 100%)`,
        }}
      >
        <div aria-hidden className="position-absolute rounded-circle"
             style={{ width: 620, height: 620, top: -260, right: -180, background: 'rgba(255,255,255,0.07)' }} />
        <div aria-hidden className="position-absolute rounded-circle"
             style={{ width: 380, height: 380, bottom: -180, left: -120, background: 'rgba(255,255,255,0.05)' }} />

        <div className="container position-relative py-5" style={{ paddingTop: 80, paddingBottom: 80 }}>
          <span
            className="badge rounded-pill mb-4"
            style={{
              color: '#fff', background: 'rgba(255,255,255,0.16)',
              border: '1px solid rgba(255,255,255,0.24)', fontWeight: 500,
            }}
          >
            TatvaOS Core · by Techvein
          </span>

          <h1 className="mb-0" style={{ fontSize: 'clamp(38px, 6vw, 62px)', fontWeight: 600,
                                        lineHeight: 1.08, letterSpacing: '-0.03em', maxWidth: 860 }}>
            One identity.<br />Every product.
          </h1>

          <p className="mb-0" style={{ marginTop: 24, fontSize: 'clamp(16px, 2vw, 19px)',
                                       opacity: 0.86, maxWidth: 640, lineHeight: 1.6 }}>
            Business email and identity for Indian organisations. Your people,
            domains, storage and billing in one place — with products that plug
            into it rather than sitting beside it.
          </p>

          <div className="d-flex gap-3 flex-wrap" style={{ marginTop: 40 }}>
            <Link href="/signup" className="btn btn-lg px-4"
                  style={{ background: '#fff', color: BRAND, fontWeight: 600 }}>
              Start free
            </Link>
            <Link href="/login" className="btn btn-lg px-4"
                  style={{ color: '#fff', border: '1px solid rgba(255,255,255,0.4)' }}>
              Sign in
            </Link>
          </div>

          {/* The objection that actually stops people, answered above the fold
              rather than three sections down. */}
          <p className="mb-0" style={{ marginTop: 32, fontSize: 14, opacity: 0.72, maxWidth: 560 }}>
            Setting up does not touch your existing email. You prove you own your
            domain, and nothing else changes until you choose to move your mail.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <div className="container" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <h2 style={{ maxWidth: 620, letterSpacing: '-0.02em', fontWeight: 600 }}>
          Not an email product with an admin screen
        </h2>
        <p className="text-muted mt-3" style={{ maxWidth: 640 }}>
          Core is the layer your organisation runs on. Mail is the first product
          on it — Drive, People, Payroll, Sheet and Word follow, and every one of
          them uses the same people, the same storage and the same bill.
        </p>

        <div className="row g-4" style={{ marginTop: 24 }}>
          {PILLARS.map((p) => (
            <div key={p.title} className="col-12 col-md-6">
              <div className="card custom-card h-100">
                <div className="card-body" style={{ padding: 28 }}>
                  <span
                    className="d-grid mb-3"
                    style={{
                      width: 44, height: 44, borderRadius: 10, placeItems: 'center',
                      color: BRAND, background: 'rgba(3,181,98,0.12)',
                    }}
                  >
                    <svg width="21" height="21" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
                         strokeLinejoin="round">
                      <path d={p.d} />
                    </svg>
                  </span>
                  <h3 className="mb-2" style={{ fontSize: 19, fontWeight: 600 }}>{p.title}</h3>
                  <p className="text-muted mb-0" style={{ fontSize: 14, lineHeight: 1.7 }}>
                    {p.body}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      <section className="bg-light" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div className="container">
          <h2 style={{ letterSpacing: '-0.02em', fontWeight: 600 }}>
            Four steps, and your mail stays put
          </h2>
          <p className="text-muted mt-3" style={{ maxWidth: 620 }}>
            The order matters. You get value before you take any risk.
          </p>

          <div className="row g-4" style={{ marginTop: 24 }}>
            {STEPS.map((s) => (
              <div key={s.n} className="col-12 col-sm-6 col-lg-3">
                <span
                  className="d-grid rounded-circle mb-3 text-white"
                  style={{
                    width: 36, height: 36, placeItems: 'center', fontWeight: 600,
                    background: `linear-gradient(72deg, ${BRAND}, ${BRAND_LIGHT})`,
                  }}
                >
                  {s.n}
                </span>
                <div className="fw-semibold mb-1">{s.title}</div>
                <p className="text-muted mb-0" style={{ fontSize: 14, lineHeight: 1.65 }}>
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <div className="container" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div
          className="card custom-card text-white border-0"
          style={{ background: `linear-gradient(120deg, ${BRAND}, ${BRAND_LIGHT})` }}
        >
          <div className="card-body text-center" style={{ padding: 56 }}>
            <h2 style={{ letterSpacing: '-0.02em', fontWeight: 600 }}>Set up in minutes</h2>
            <p className="mx-auto mb-0" style={{ marginTop: 12, opacity: 0.88, maxWidth: 520 }}>
              Prove you own your domain and you are in. Move your mail across
              whenever you are ready.
            </p>
            <Link href="/signup" className="btn btn-lg px-5"
                  style={{ marginTop: 32, background: '#fff', color: BRAND, fontWeight: 600 }}>
              Get started
            </Link>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      <hr className="m-0" />
      <div className="container py-4">
        <div className="d-flex gap-3 flex-wrap align-items-center">
          <Brand />
          <span className="fs-12 text-muted ms-sm-auto">
            © {new Date().getFullYear()} Techvein. Hosted in India.
          </span>
        </div>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="d-flex align-items-center gap-2 text-decoration-none text-body">
      <span
        className="d-grid text-white"
        style={{
          width: 32, height: 32, borderRadius: 8, placeItems: 'center',
          fontWeight: 700, fontSize: 15,
          background: `linear-gradient(72deg, ${BRAND}, ${BRAND_LIGHT})`,
        }}
      >
        T
      </span>
      <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: '0.01em' }}>TatvaOS</span>
    </Link>
  );
}
