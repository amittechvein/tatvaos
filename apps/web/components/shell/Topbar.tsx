'use client';

import { useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import { alpha } from '@mui/material/styles';
import { useAuth } from '@/lib/auth';
import { AccountMenu } from './AccountMenu';
import { useTheme as useAppearance } from '@/lib/theme';
import { Switcher } from './Switcher';

/**
 * The bar across the top.
 *
 * Materio floats it over the content on a blurred, semi-transparent surface
 * rather than sitting it in a solid band — which is why the page appears to
 * slide underneath rather than behind it. That needs both the backdrop filter
 * and a transparent background; either alone looks like a mistake.
 */
export function Topbar({ scope }: { scope: 'platform' | 'organisation' | 'mail' }) {
  const { user } = useAuth();
  const { mode, setMode, toggleRail } = useAppearance();
  const [switcher, setSwitcher] = useState(false);
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  return (
    <>
      <AppBar
        position="sticky"
        elevation={0}
        sx={{
          bgcolor: (t) => alpha(t.palette.background.default, 0.85),
          backdropFilter: 'blur(8px)',
          color: 'text.primary',
          borderBottom: 0,
        }}
      >
        <Toolbar sx={{ gap: 1, minHeight: { xs: 60, sm: 64 } }}>
          <IconButton onClick={toggleRail} aria-label="Toggle sidebar" size="small">
            <Glyph d="M4 7h16M4 12h10M4 17h16" />
          </IconButton>

          <TextField
            placeholder="Search…"
            size="small"
            sx={{ maxWidth: 320, display: { xs: 'none', md: 'block' },
                  '& .MuiOutlinedInput-root': { borderRadius: 999 } }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Glyph d="M15 15l4 4M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </InputAdornment>
                ),
              },
            }}
          />

          {/*
            Platform admin acts across every customer's data. This chip is the
            only always-visible reminder of which console this is, and the cost
            of confusing them is suspending the wrong organisation.
          */}
          {scope === 'platform' && (
            <Chip label="Platform admin" color="warning" size="small"
                  variant="outlined" sx={{ ml: 'auto', fontWeight: 600 }} />
          )}

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5,
                     ml: scope === 'platform' ? 1 : 'auto' }}>
            <IconButton
              size="small"
              onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
              aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {mode === 'dark'
                ? <Glyph d="M12 3v2m0 14v2m9-9h-2M5 12H3m14.5-6.5l-1.4 1.4M7.9 16.1l-1.4 1.4m11.6 0l-1.4-1.4M7.9 7.9L6.5 6.5M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                : <Glyph d="M20 13.5A8 8 0 1110.5 4a6.5 6.5 0 009.5 9.5z" />}
            </IconButton>

            <IconButton size="small" onClick={() => setSwitcher(true)} aria-label="Appearance">
              <Glyph d="M10.3 3h3.4l.5 2.3 1.9 1.1 2.2-.8 1.7 3-1.7 1.6v2.2l1.7 1.6-1.7 3-2.2-.8-1.9 1.1-.5 2.3h-3.4l-.5-2.3-1.9-1.1-2.2.8-1.7-3 1.7-1.6v-2.2L4 8.6l1.7-3 2.2.8 1.9-1.1.5-2.3z" />
            </IconButton>

            <IconButton onClick={(e) => setAnchor(e.currentTarget)} size="small" sx={{ ml: 0.5 }}>
              <Avatar
                sx={{ width: 34, height: 34, fontSize: 14, fontWeight: 600,
                      background: (t) => `linear-gradient(72deg, ${t.palette.primary.main}, ${t.palette.primary.light})` }}
              >
                {(user?.displayName ?? '?').charAt(0).toUpperCase()}
              </Avatar>
            </IconButton>

            <AccountMenu anchorEl={anchor} onClose={() => setAnchor(null)} />
          </Box>
        </Toolbar>
      </AppBar>

      <Switcher open={switcher} onClose={() => setSwitcher(false)} />
    </>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
