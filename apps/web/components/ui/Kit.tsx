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
/**
 * A stat tile in YZEN's exact anatomy: a solid, near-square coloured icon
 * chip on the LEFT (their `.avatar.avatar-md`, ~42px, 6px radius, white glyph),
 * and label → value → delta stacked to its right. The delta is a coloured
 * trend chip — green up, red down — followed by muted context ("this month").
 *
 * `tone` colours the icon chip so a row of four cards is not four identical
 * green squares — YZEN cycles primary / info / success / warning across them.
 */
export function Stat({
  label, value, caption, delta, icon, tone = 'primary',
}: {
  label: string;
  value: string;
  caption?: string;
  delta?: { value: string; direction: 'up' | 'down'; good?: boolean };
  icon?: React.ReactNode;
  tone?: 'primary' | 'info' | 'success' | 'warning' | 'error';
}) {
  const positive = delta ? (delta.good ?? delta.direction === 'up') : false;

  return (
    <MuiCard>
      <MuiCardContent sx={{ display: 'flex', gap: 1.75, alignItems: 'center' }}>
        {icon && (
          <Box sx={{ width: 44, height: 44, borderRadius: 1.5, flexShrink: 0,
                     display: 'grid', placeItems: 'center', color: '#fff',
                     bgcolor: `${tone}.main`,
                     '& svg': { width: 22, height: 22 } }}>
            {icon}
          </Box>
        )}
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontWeight: 500, fontSize: 13, color: 'text.secondary' }} noWrap>
            {label}
          </Typography>
          <Typography sx={{ fontSize: 22, fontWeight: 700, lineHeight: 1.25 }}>
            {value}
          </Typography>
          {delta ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25, fontSize: 12 }}>
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25,
                                          fontWeight: 600, color: positive ? 'success.main' : 'error.main' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  {positive ? <path d="M3 17l6-6 4 4 8-8M21 7v6M21 7h-6" />
                            : <path d="M3 7l6 6 4-4 8 8M21 17v-6M21 17h-6" />}
                </svg>
                {delta.value}
              </Box>
              {caption && <Box component="span" sx={{ color: 'text.disabled' }}>{caption}</Box>}
            </Box>
          ) : caption && (
            <Typography sx={{ display: 'block', mt: 0.25, fontSize: 12, color: 'text.disabled' }}>
              {caption}
            </Typography>
          )}
        </Box>
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
