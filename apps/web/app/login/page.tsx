'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useAuth } from '@/lib/auth';

function SignInForm() {
  const { signIn, user, mustChangePassword, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in — usually a bookmarked /login or a back button.
  useEffect(() => {
    if (loading || !user) return;
    router.replace(mustChangePassword
      ? '/change-password'
      : params.get('next') ?? destinationFor(user.role));
  }, [loading, user, mustChangePassword, router, params]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      // The server returns one message for wrong password, unknown address and
      // suspended account, on purpose. Passing it straight through keeps that
      // property — inventing a friendlier client-side message would leak the
      // difference the server worked to hide.
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center',
               bgcolor: 'background.default', p: 2 }}>
      <Box sx={{ width: '100%', maxWidth: 420 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                   gap: 1.5, mb: 4 }}>
          <Box sx={{ width: 40, height: 40, borderRadius: 2, display: 'grid',
                     placeItems: 'center', color: '#fff', fontWeight: 700, fontSize: 18,
                     background: (t) => `linear-gradient(72deg, ${t.palette.primary.main}, ${t.palette.primary.light})` }}>
            T
          </Box>
          <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: '0.02em' }}>
            TatvaOS
          </Typography>
        </Box>

        <Card>
          <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
            <Typography variant="h5" sx={{ mb: 0.5 }}>Welcome back</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Sign in to reach your organisation.
            </Typography>

            <Box component="form" onSubmit={submit} noValidate>
              {error && <Alert severity="error" sx={{ mb: 2.5 }}>{error}</Alert>}

              <TextField
                fullWidth
                label="Email address"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                sx={{ mb: 2.5 }}
              />

              <TextField
                fullWidth
                label="Password"
                type={reveal ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        {/* A reveal toggle reduces failed attempts on long
                            passwords, and this account locks after five. */}
                        <IconButton
                          onClick={() => setReveal((v) => !v)}
                          edge="end"
                          size="small"
                          aria-label={reveal ? 'Hide password' : 'Show password'}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                               stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
                            <circle cx="12" cy="12" r="3" />
                            {!reveal && <path d="M4 20L20 4" />}
                          </svg>
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />

              <Button
                type="submit"
                fullWidth
                variant="contained"
                size="large"
                disabled={busy || !email || !password}
                sx={{ mt: 3.5 }}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </Box>
          </CardContent>
        </Card>

        <Typography variant="caption" color="text.disabled"
                    sx={{ display: 'block', textAlign: 'center', mt: 3 }}>
          Forgotten your password? Your organisation&apos;s administrator can reset it.
        </Typography>
      </Box>
    </Box>
  );
}

/** Super admins run the platform; everyone else lands in their own product. */
function destinationFor(role: string): string {
  if (role === 'super_admin') return '/admin';
  if (role === 'org_owner' || role === 'org_admin') return '/org/users';
  return '/mail/f-inbox';
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary or the whole route opts out of
  // static rendering and the build warns.
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
