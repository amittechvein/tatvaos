'use client';

// ============================================================================
//  The primitives every screen is built from — now MUI underneath.
//
//  The API is unchanged from the Tailwind version on purpose. Every page
//  imports Card, Button, Stat, Table and the rest from here, so keeping the
//  props identical meant the styling library could be swapped without editing
//  twenty pages in the same commit. That is the whole reason this file exists
//  rather than pages importing MUI directly.
//
//  New screens may use MUI directly. These stay because they encode decisions
//  that should not be re-made per page — which red means danger, where the
//  storage thresholds sit, what a card header looks like.
// ============================================================================

import MuiCard from '@mui/material/Card';
import MuiCardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import MuiButton, { type ButtonProps } from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import MuiTable from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';

// ---------------------------------------------------------------------------
export function Card({
  title, subtitle, actions, children, className, padded = true,
}: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Off for tables, which manage their own edge-to-edge padding. */
  padded?: boolean;
}) {
  return (
    <MuiCard className={className}>
      {(title || actions) && (
        <CardHeader title={title} subheader={subtitle} action={actions} />
      )}
      {padded ? <MuiCardContent>{children}</MuiCardContent> : children}
    </MuiCard>
  );
}

// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const MAP: Record<Variant, Pick<ButtonProps, 'variant' | 'color'>> = {
  primary:   { variant: 'contained', color: 'primary' },
  secondary: { variant: 'outlined',  color: 'inherit' },
  ghost:     { variant: 'text',      color: 'inherit' },
  // Destructive actions are red everywhere, and red is not themeable. A
  // customer picking a green accent must not end up with a green Delete.
  danger:    { variant: 'contained', color: 'error' },
};

export function Button({
  variant = 'secondary', children, ...rest
}: Omit<ButtonProps, 'variant' | 'color'> & { variant?: Variant }) {
  return <MuiButton {...MAP[variant]} {...rest}>{children}</MuiButton>;
}

// ---------------------------------------------------------------------------
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const TONE: Record<Tone, 'success' | 'warning' | 'error' | 'info' | 'default'> = {
  ok: 'success', warn: 'warning', danger: 'error', info: 'info', neutral: 'default',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <Chip
      size="small"
      color={TONE[tone]}
      label={children}
      sx={{ textTransform: 'capitalize' }}
      variant="filled"
    />
  );
}

/** Maps a status string to a tone in one place, so every screen agrees. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'active': return 'ok';
    case 'trial': case 'pending': return 'warn';
    case 'suspended': case 'deleted': case 'past_due': return 'danger';
    default: return 'neutral';
  }
}

// ---------------------------------------------------------------------------
export function Stat({
  label, value, caption, delta, icon,
}: {
  label: string;
  value: string;
  caption?: string;
  delta?: { value: string; direction: 'up' | 'down'; good?: boolean };
  icon?: React.ReactNode;
}) {
  // Up is not automatically good. Storage used rising is not a success, so
  // callers say what they mean rather than the component inferring it from an
  // arrow direction.
  const positive = delta ? (delta.good ?? delta.direction === 'up') : false;

  return (
    <MuiCard>
      <MuiCardContent sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, letterSpacing: '0.06em',
                                              textTransform: 'uppercase', color: 'text.secondary' }}>
            {label}
          </Typography>
          {caption && (
            <Typography variant="caption" sx={{ display: 'block', color: 'text.disabled' }}>
              {caption}
            </Typography>
          )}
          <Typography variant="h3" sx={{ mt: 1, fontWeight: 700, lineHeight: 1.1 }}>
            {value}
          </Typography>
          {delta && (
            <Typography variant="caption"
                        sx={{ display: 'block', mt: 0.5, color: positive ? 'success.main' : 'error.main' }}>
              <strong>{delta.value}</strong>{' '}
              <Box component="span" sx={{ color: 'text.secondary' }}>
                {delta.direction === 'up' ? 'higher' : 'lower'}
              </Box>
            </Typography>
          )}
        </Box>
        {icon && (
          <Box sx={{ width: 46, height: 46, borderRadius: 2.5, display: 'grid', placeItems: 'center',
                     flexShrink: 0, color: 'primary.main',
                     bgcolor: (t) => alpha(t.palette.primary.main, 0.14),
                     boxShadow: (t) => `inset 0 0 0 1px ${alpha(t.palette.primary.main, 0.16)}` }}>
            {icon}
          </Box>
        )}
      </MuiCardContent>
    </MuiCard>
  );
}

// ---------------------------------------------------------------------------
export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <TableContainer>
      <MuiTable size="small">
        <TableHead>
          <TableRow>
            {head.map((h, i) => (
              // Blank column headings are legitimate — an actions column has no
              // name — so the index disambiguates rather than the label.
              <TableCell key={`${h}-${i}`}>{h}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>{children}</TableBody>
      </MuiTable>
    </TableContainer>
  );
}

export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <TableCell className={className}>{children}</TableCell>;
}

// ---------------------------------------------------------------------------
/**
 * A progress bar that changes colour as it fills.
 *
 * The thresholds are the same ones StorageAllocator enforces on the server:
 * 80% warns, 95% blocks new users. Showing amber where the backend starts
 * warning means the screen and the API tell the same story.
 */
export function Meter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const colour = pct >= 95 ? 'error' : pct >= 80 ? 'warning' : 'primary';

  return <LinearProgress variant="determinate" value={pct} color={colour} />;
}

// ---------------------------------------------------------------------------
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <Box sx={{ px: 3, py: 7, textAlign: 'center' }}>
      <Typography variant="body1" sx={{ fontWeight: 500 }}>{title}</Typography>
      {hint && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mx: 'auto', maxWidth: 420 }}>
          {hint}
        </Typography>
      )}
      {action && <Box sx={{ mt: 3 }}>{action}</Box>}
    </Box>
  );
}
