'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { useAuth } from '@/lib/auth';

/**
 * Forced on first sign-in, because the account still has a password an admin
 * generated, read off a screen and sent over chat. Until it is changed, the
 * person is not the only one who knows it.
 */
export default function ChangePasswordPage() {
  const { user, loading, changePassword } = useAuth();
  const router = useRouter();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user && !done) router.replace('/login');
  }, [loading, user, done, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (next !== confirm) return setError('The two new passwords do not match.');
    if (next.length < 12) return setError('Use at least 12 characters.');
    if (next === current) return setError('The new password must be different from the current one.');

    setBusy(true);
    try {
      await changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell>
        <Typography variant="h5" sx={{ mb: 1 }}>Password changed</Typography>
        <Typography variant="body2" color="text.secondary">
          Every other session has been signed out, including on your other devices.
          That is deliberate — if someone else knew the old password, leaving their
          session running would defeat the point of changing it.
        </Typography>
        <Button fullWidth variant="contained" size="large" sx={{ mt: 3.5 }}
                onClick={() => router.replace('/login')}>
          Sign in again
        </Button>
      </Shell>
    );
  }

  return (
    <Shell>
      <Typography variant="h5" sx={{ mb: 0.5 }}>Choose a new password</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Your current password was created by an administrator, so more than one
        person knows it.
      </Typography>

      <Box component="form" onSubmit={submit} noValidate>
        {error && <Alert severity="error" sx={{ mb: 2.5 }}>{error}</Alert>}

        <TextField fullWidth type="password" label="Current password" required
                   autoComplete="current-password" value={current} sx={{ mb: 2.5 }}
                   onChange={(e) => setCurrent(e.target.value)} />

        <TextField fullWidth type="password" label="New password" required
                   autoComplete="new-password" value={next}
                   onChange={(e) => setNext(e.target.value)} />

        <Strength value={next} />

        <TextField
          fullWidth type="password" label="Confirm new password" required
          autoComplete="new-password" value={confirm} sx={{ mt: 2.5 }}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirm.length > 0 && confirm !== next}
          helperText={confirm.length > 0 && confirm !== next ? 'These do not match.' : ' '}
        />

        <Typography variant="caption" color="text.secondary"
                    sx={{ display: 'block', mt: 1, lineHeight: 1.6 }}>
          At least 12 characters. Length matters far more than symbols — a short
          phrase you will actually remember beats something unmemorable with a
          punctuation mark in it.
        </Typography>

        <Button type="submit" fullWidth variant="contained" size="large" sx={{ mt: 3 }}
                disabled={busy || !current || !next || !confirm}>
          {busy ? 'Changing…' : 'Change password'}
        </Button>
      </Box>
    </Shell>
  );
}

/**
 * Length only — deliberately not a character-class score.
 *
 * Scores that reward a capital and a digit rate "Password1!" highly, and it is
 * on every wordlist there is. Length is the property that actually resists
 * guessing, so that is the only thing shown.
 */
function Strength({ value }: { value: string }) {
  if (!value) return <Box sx={{ height: 22 }} />;

  const pct = Math.min(100, (value.length / 16) * 100);
  const weak = value.length < 12;
  const strong = value.length >= 16;

  return (
    <Box sx={{ mt: 1 }}>
      <LinearProgress
        variant="determinate"
        value={pct}
        color={weak ? 'error' : strong ? 'success' : 'warning'}
      />
      <Typography variant="caption"
                  color={weak ? 'error.main' : strong ? 'success.main' : 'warning.main'}>
        {weak ? `${12 - value.length} more character${12 - value.length === 1 ? '' : 's'}`
              : strong ? 'Good length' : 'Long enough'}
      </Typography>
    </Box>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center',
               bgcolor: 'background.default', p: 2 }}>
      <Card sx={{ width: '100%', maxWidth: 440 }}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>{children}</CardContent>
      </Card>
    </Box>
  );
}
