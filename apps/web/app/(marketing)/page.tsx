'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

import { useAuth } from '@/lib/auth';

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
// ============================================================================

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
    router.replace(user.role === 'super_admin' ? '/admin' : '/org');
  }, [loading, user, router]);

  return (
    <Box sx={{ bgcolor: 'background.paper' }}>
      {/* ---------------------------------------------------------------- */}
      <AppBar position="sticky" elevation={0}
              sx={{ bgcolor: (t) => alpha(t.palette.background.paper, 0.9),
                    backdropFilter: 'blur(8px)', color: 'text.primary',
                    borderBottom: '1px solid', borderColor: 'divider' }}>
        <Container maxWidth="lg">
          <Toolbar disableGutters sx={{ gap: 2 }}>
            <Brand />
            <Box sx={{ ml: 'auto', display: 'flex', gap: 1.5, alignItems: 'center' }}>
              <Button component={Link} href="/login" color="inherit">Sign in</Button>
              <Button component={Link} href="/signup" variant="contained">Get started</Button>
            </Box>
          </Toolbar>
        </Container>
      </AppBar>

      {/* ---------------------------------------------------------------- */}
      <Box sx={{ position: 'relative', overflow: 'hidden', color: '#fff',
                 background: (t) => `linear-gradient(135deg, ${t.palette.primary.dark} 0%, ${t.palette.primary.main} 55%, ${t.palette.primary.light} 100%)` }}>
        <Box aria-hidden sx={{ position: 'absolute', width: 620, height: 620, borderRadius: '50%',
          top: -260, right: -180, bgcolor: alpha('#fff', 0.07) }} />
        <Box aria-hidden sx={{ position: 'absolute', width: 380, height: 380, borderRadius: '50%',
          bottom: -180, left: -120, bgcolor: alpha('#fff', 0.05) }} />

        <Container maxWidth="lg" sx={{ position: 'relative', py: { xs: 8, md: 13 } }}>
          <Chip label="TatvaOS Core · by Techvein" size="small"
                sx={{ mb: 3, color: '#fff', bgcolor: alpha('#fff', 0.16),
                      border: `1px solid ${alpha('#fff', 0.24)}` }} />

          <Typography component="h1"
                      sx={{ fontSize: { xs: 38, sm: 52, md: 62 }, fontWeight: 600,
                            lineHeight: 1.08, letterSpacing: '-0.03em', maxWidth: 860 }}>
            One identity.<br />Every product.
          </Typography>

          <Typography sx={{ mt: 3, fontSize: { xs: 16, md: 19 }, opacity: 0.86,
                            maxWidth: 640, lineHeight: 1.6 }}>
            Business email and identity for Indian organisations. Your people,
            domains, storage and billing in one place — with products that plug
            into it rather than sitting beside it.
          </Typography>

          <Box sx={{ mt: 5, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <Button component={Link} href="/signup" size="large"
                    sx={{ bgcolor: '#fff', color: 'primary.main', px: 4,
                          '&:hover': { bgcolor: alpha('#fff', 0.9) } }}>
              Start free
            </Button>
            <Button component={Link} href="/login" size="large"
                    sx={{ color: '#fff', border: `1px solid ${alpha('#fff', 0.4)}`, px: 4 }}>
              Sign in
            </Button>
          </Box>

          {/* The objection that actually stops people, answered above the fold
              rather than three sections down. */}
          <Typography sx={{ mt: 4, fontSize: 14, opacity: 0.72, maxWidth: 560 }}>
            Setting up does not touch your existing email. You prove you own your
            domain, and nothing else changes until you choose to move your mail.
          </Typography>
        </Container>
      </Box>

      {/* ---------------------------------------------------------------- */}
      <Container maxWidth="lg" sx={{ py: { xs: 8, md: 12 } }}>
        <Typography variant="h3" sx={{ maxWidth: 620, letterSpacing: '-0.02em' }}>
          Not an email product with an admin screen
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mt: 2, maxWidth: 640 }}>
          Core is the layer your organisation runs on. Mail is the first product
          on it — Drive, People, Payroll, Sheet and Word follow, and every one of
          them uses the same people, the same storage and the same bill.
        </Typography>

        <Box sx={{ mt: 6, display: 'grid', gap: 3,
                   gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
          {PILLARS.map((p) => (
            <Card key={p.title}>
              <CardContent sx={{ p: 3.5 }}>
                <Box sx={{ width: 44, height: 44, borderRadius: 2, mb: 2.5,
                           display: 'grid', placeItems: 'center', color: 'primary.main',
                           bgcolor: (t) => alpha(t.palette.primary.main, 0.12) }}>
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
                       strokeLinejoin="round">
                    <path d={p.d} />
                  </svg>
                </Box>
                <Typography variant="h6" sx={{ mb: 1 }}>{p.title}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                  {p.body}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Box>
      </Container>

      {/* ---------------------------------------------------------------- */}
      <Box sx={{ bgcolor: 'background.default', py: { xs: 8, md: 12 } }}>
        <Container maxWidth="lg">
          <Typography variant="h3" sx={{ letterSpacing: '-0.02em' }}>
            Four steps, and your mail stays put
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mt: 2, maxWidth: 620 }}>
            The order matters. You get value before you take any risk.
          </Typography>

          <Box sx={{ mt: 6, display: 'grid', gap: 3,
                     gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' } }}>
            {STEPS.map((s) => (
              <Box key={s.n}>
                <Box sx={{ width: 36, height: 36, borderRadius: '50%', mb: 2,
                           display: 'grid', placeItems: 'center', fontWeight: 600,
                           color: '#fff',
                           background: (t) => `linear-gradient(72deg, ${t.palette.primary.main}, ${t.palette.primary.light})` }}>
                  {s.n}
                </Box>
                <Typography variant="body1" sx={{ fontWeight: 600, mb: 0.75 }}>
                  {s.title}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.65 }}>
                  {s.body}
                </Typography>
              </Box>
            ))}
          </Box>
        </Container>
      </Box>

      {/* ---------------------------------------------------------------- */}
      <Container maxWidth="lg" sx={{ py: { xs: 8, md: 12 } }}>
        <Card sx={{ background: (t) => `linear-gradient(120deg, ${t.palette.primary.main}, ${t.palette.primary.light})`,
                    color: '#fff' }}>
          <CardContent sx={{ p: { xs: 4, md: 7 }, textAlign: 'center' }}>
            <Typography variant="h4" sx={{ letterSpacing: '-0.02em' }}>
              Set up in minutes
            </Typography>
            <Typography sx={{ mt: 1.5, opacity: 0.88, maxWidth: 520, mx: 'auto' }}>
              Prove you own your domain and you are in. Move your mail across
              whenever you are ready.
            </Typography>
            <Button component={Link} href="/signup" size="large"
                    sx={{ mt: 4, bgcolor: '#fff', color: 'primary.main', px: 5,
                          '&:hover': { bgcolor: alpha('#fff', 0.9) } }}>
              Get started
            </Button>
          </CardContent>
        </Card>
      </Container>

      {/* ---------------------------------------------------------------- */}
      <Divider />
      <Container maxWidth="lg" sx={{ py: 5 }}>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Brand />
          <Typography variant="caption" color="text.disabled" sx={{ ml: { sm: 'auto' } }}>
            © {new Date().getFullYear()} Techvein. Hosted in India.
          </Typography>
        </Box>
      </Container>
    </Box>
  );
}

function Brand() {
  return (
    <Box component={Link} href="/"
         sx={{ display: 'flex', alignItems: 'center', gap: 1.25, textDecoration: 'none',
               color: 'inherit' }}>
      <Box sx={{ width: 32, height: 32, borderRadius: 1.5, display: 'grid',
                 placeItems: 'center', color: '#fff', fontWeight: 700, fontSize: 15,
                 background: (t) => `linear-gradient(72deg, ${t.palette.primary.main}, ${t.palette.primary.light})` }}>
        T
      </Box>
      <Typography sx={{ fontWeight: 700, fontSize: 18, letterSpacing: '0.01em' }}>
        TatvaOS
      </Typography>
    </Box>
  );
}
