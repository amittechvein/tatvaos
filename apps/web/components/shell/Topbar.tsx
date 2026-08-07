'use client';

import { useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import { alpha } from '@mui/material/styles';
import { useAuth } from '@/lib/auth';
import { AccountMenu } from './AccountMenu';
import { AppLauncher } from './AppLauncher';
import { useTheme as useAppearance } from '@/lib/theme';
import { Switcher } from './Switcher';

/**
 * The bar across the top.
 *
 * YZEN's header (data-header-styles="light") is a SOLID white band with a
 * hairline bottom border — flush, not floating. The blurred translucent
 * Materio bar was replaced because a see-through header over a dark sidebar
 * and light content reads as three planes fighting; a solid white bar with a
 * border sits cleanly between the charcoal rail and the grey canvas.
 */
export function Topbar({ scope }: { scope: 'platform' | 'organisation' | 'mail' }) {
  const { user } = useAuth();
  const { mode, setMode, railMode, toggleRail } = useAppearance();
  const [switcher, setSwitcher] = useState(false);
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  return (
    <>
      <AppBar
        position="sticky"
        elevation={0}
        sx={{
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderBottom: (t) => `1px solid ${t.palette.divider}`,
        }}
      >
        <Toolbar sx={{ gap: 1, minHeight: { xs: 58, sm: 60 } }}>
          {/* One control, three stops: full → icons → hidden → full. The
              glyph shows what you will GET, not what you have, so the button
              is a preview rather than a status light — and the tooltip names
              it, because an icon alone cannot explain a three-way cycle. */}
          <Tooltip title={
            railMode === 'expanded' ? 'Collapse to icons'
            : railMode === 'icons'  ? 'Hide the sidebar'
            : 'Show the sidebar'
          }>
            <IconButton onClick={toggleRail} size="small"
                        aria-label={
                          railMode === 'expanded' ? 'Collapse sidebar to icons'
                          : railMode === 'icons'  ? 'Hide sidebar'
                          : 'Show sidebar'
                        }>
              {railMode === 'expanded'
                ? <Glyph d="M4 7h16M4 12h10M4 17h16" />
                : railMode === 'icons'
                  ? <Glyph d="M15 5l-7 7 7 7M20 5v14" />
                  : <Glyph d="M9 5l7 7-7 7M4 5v14" />}
            </IconButton>
          </Tooltip>

          {/* YZEN's header search: a real bordered input, not a ghost. Muted
              icon, subtle border that turns primary on focus. */}
          <TextField
            placeholder="Search"
            size="small"
            sx={{
              width: 260, display: { xs: 'none', md: 'block' },
              '& .MuiOutlinedInput-root': {
                borderRadius: 2,
                bgcolor: 'background.paper',
                '& fieldset': { borderColor: 'divider' },
              },
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start" sx={{ color: 'text.disabled' }}>
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
                     ml: scope === 'platform' ? 1 : 'auto',
                     // YZEN header icons are a calm muted grey, not full-ink —
                     // the profile avatar is the only saturated thing up here.
                     color: 'text.secondary' }}>
            <AppLauncher />

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
              {/* The dot means "this session is live", which — unlike a fake
                  notification count — is true whenever it renders. */}
              <Badge
                overlap="circular"
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                variant="dot"
                sx={{ '& .MuiBadge-badge': {
                  bgcolor: 'success.main',
                  boxShadow: (t) => `0 0 0 2px ${t.palette.background.paper}`,
                  width: 9, height: 9, borderRadius: '50%',
                } }}
              >
                <Avatar
                  sx={{ width: 34, height: 34, fontSize: 14, fontWeight: 700,
                        bgcolor: 'primary.main' }}
                >
                  {(user?.displayName ?? '?').charAt(0).toUpperCase()}
                </Avatar>
              </Badge>
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
