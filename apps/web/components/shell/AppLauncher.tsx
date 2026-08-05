'use client';

// ============================================================================
//  The app launcher — Google's nine-dot grid, for TatvaOS products
// ============================================================================
//
//  Product switching lives HERE, in the top-right, and nowhere else. It was a
//  coloured rail down the left for one iteration and got removed on sight:
//  two vertical bars read as chrome. A launcher behind one button costs one
//  extra click and gives the whole left edge back to the console's own
//  navigation — and it is where a decade of Google Workspace has taught
//  everyone to look for "the other apps".
//
//  Products that do not exist yet appear greyed with a "Soon" tag rather than
//  being hidden. A customer looking at this grid should see a suite with
//  products arriving, not a mail app wearing a launcher.
// ============================================================================

import Link from 'next/link';
import { useState } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { RAIL_PRODUCTS } from '@/lib/nav';

export function AppLauncher() {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  // The consoles sit under a divider at the bottom, apart from the products —
  // "administer the platform" is a different kind of destination from "read
  // your mail", and mixing them makes the grid harder to scan.
  const products = RAIL_PRODUCTS.filter((p) => p.code !== 'platform' && p.code !== 'core');
  const consoles = RAIL_PRODUCTS.filter((p) => p.code === 'platform' || p.code === 'core');

  return (
    <>
      <Tooltip title="TatvaOS apps">
        <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)}
                    aria-label="TatvaOS apps">
          {/* The nine dots. */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            {[5, 12, 19].flatMap((y) =>
              [5, 12, 19].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.9" />))}
          </svg>
        </IconButton>
      </Tooltip>

      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { mt: 1, p: 2, width: 316, borderRadius: 4 } } }}
      >
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.5 }}>
          {products.map((p) => <Tile key={p.code} p={p} onNavigate={() => setAnchor(null)} />)}
        </Box>

        <Box sx={{ height: '1px', bgcolor: 'divider', my: 1.5 }} />

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.5 }}>
          {consoles.map((p) => <Tile key={p.code} p={p} onNavigate={() => setAnchor(null)} />)}
        </Box>
      </Popover>
    </>
  );
}

function Tile({ p, onNavigate }: {
  p: (typeof RAIL_PRODUCTS)[number];
  onNavigate: () => void;
}) {
  const inner = (
    <Box
      {...(p.live ? { component: Link, href: p.href, onClick: onNavigate } : {})}
      sx={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75,
        py: 1.5, px: 0.5, borderRadius: 3, textDecoration: 'none',
        cursor: p.live ? 'pointer' : 'default',
        opacity: p.live ? 1 : 0.45,
        '&:hover': p.live ? { bgcolor: 'action.hover' } : {},
      }}
    >
      <Box sx={{
        width: 44, height: 44, borderRadius: 2.5, display: 'grid', placeItems: 'center',
        color: '#fff',
        background: `linear-gradient(135deg, ${p.colour}, ${alpha(p.colour, 0.75)})`,
        boxShadow: `0 3px 8px -2px ${alpha(p.colour, 0.55)}`,
      }}>
        {p.icon}
      </Box>
      <Typography variant="caption"
                  sx={{ fontWeight: 500, color: 'text.primary', lineHeight: 1.2,
                        textAlign: 'center' }}>
        {p.label}
      </Typography>
      {!p.live && (
        <Typography variant="caption" sx={{ fontSize: 10, color: 'text.disabled', mt: -0.5 }}>
          Soon
        </Typography>
      )}
    </Box>
  );

  return p.live ? inner : <Tooltip title={`${p.label} — coming soon`}>{inner}</Tooltip>;
}
