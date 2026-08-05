'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { useTheme as useAppearance } from '@/lib/theme';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  children?: { href: string; label: string }[];
  /** Visible but not navigable — a product that does not exist yet. */
  disabled?: boolean;
  /** Small chip on the right, e.g. "Soon". */
  badge?: string;
}

export interface NavSection {
  heading: string;
  items: NavItem[];
}

export const PANEL_WIDTH = 262;
export const PANEL_WIDTH_ICONS = 72;

// ============================================================================
//  One sidebar, three widths — Materio's shape
// ============================================================================
//
//  A coloured product rail sat beside this panel for one iteration and was
//  removed on sight: two competing verticals read as chrome, not navigation.
//  Product switching lives in the topbar's app launcher instead, which is
//  where Google Workspace keeps it and therefore where people look first.
//
//  The three states cycle from one button: full → icons → hidden. Icons mode
//  keeps every destination one click away while giving the mail list the
//  width back; hidden gives everything back.
//
//  ---------------------------------------------------------------------------
//  THE PANEL IS FIXED; ONLY THE CONTENT COLUMN SCROLLS.
//
//  On a mail client you scroll constantly, and navigation that scrolls away
//  with a long thread means scrolling back up to go anywhere. The panel is
//  position:fixed at full viewport height with its own internal overflow,
//  and AppShell offsets the content by its width.
//  ---------------------------------------------------------------------------

export function Sidebar({ sections, brand }: { sections: NavSection[]; brand: string }) {
  const pathname = usePathname();
  const { railMode } = useAppearance();
  const [open, setOpen] = useState<string | null>(null);

  // LONGEST match wins, across the whole panel. "/org" is a prefix of every
  // page in the console, so prefix-matching each item independently lit the
  // Dashboard pill on all of them — two glowing pills on every screen, found
  // the first time the shell was looked at rather than built.
  const activeHref = sections
    .flatMap((sec) => sec.items)
    .flatMap((i) => [i.href, ...(i.children?.map((c) => c.href) ?? [])])
    .filter((h) => h && (pathname === h || pathname.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];

  if (railMode === 'hidden') return null;

  const icons = railMode === 'icons';
  const width = icons ? PANEL_WIDTH_ICONS : PANEL_WIDTH;

  return (
    <Box
      component="nav"
      aria-label="Navigation"
      sx={{
        position: 'fixed', top: 0, left: 0, bottom: 0,
        zIndex: (t) => t.zIndex.drawer,
        width,
        display: 'flex', flexDirection: 'column',
        bgcolor: 'background.paper',
        // Shadow, not a border. Materio separates the drawer from the page
        // with soft depth; a 1px line next to shadowed cards reads as a
        // wireframe that never got skinned.
        boxShadow: (t) => `0 0 16px 0 ${alpha(t.palette.text.primary, 0.1)}`,
        transition: (t) => t.transitions.create('width', { duration: 200 }),
        overflow: 'hidden',
      }}
    >
      {/* Brand */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, height: 64, flexShrink: 0,
                 px: icons ? 0 : 3, justifyContent: icons ? 'center' : 'flex-start' }}>
        <Box
          component={Link}
          href="/"
          sx={{
            width: 34, height: 34, borderRadius: 2, display: 'grid', placeItems: 'center',
            flexShrink: 0, fontWeight: 700, fontSize: 16, color: '#fff', textDecoration: 'none',
            background: (t) => `linear-gradient(135deg, ${t.palette.primary.main}, ${t.palette.primary.light})`,
            boxShadow: (t) => `0 2px 6px 0 ${alpha(t.palette.primary.main, 0.4)}`,
          }}
        >
          T
        </Box>
        {!icons && (
          <Typography sx={{ fontWeight: 700, fontSize: 19, letterSpacing: '0.01em' }} noWrap>
            {brand}
          </Typography>
        )}
      </Box>

      <Box sx={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, pb: 2 }} className="scroll-thin">
        {sections.map((section) => (
          <List key={section.heading} dense sx={{ pl: 0, pr: icons ? 0 : 1.5, py: 0 }}>
            {!icons && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, pl: 3, pr: 1.5,
                         pt: 2.5, pb: 1 }}>
                <Typography variant="caption"
                            sx={{ fontWeight: 500, color: 'text.disabled', fontSize: 12,
                                  whiteSpace: 'nowrap' }}>
                  {section.heading}
                </Typography>
                <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
              </Box>
            )}

            {section.items.map((item) => {
              const active =
                item.href === activeHref ||
                item.children?.some((c) => c.href === activeHref);
              const expanded = open === item.href;

              const row = (
                <ListItemButton
                  {...(item.disabled
                    ? { disabled: true }
                    // In icons mode there is nowhere to unfold children, so
                    // the parent navigates directly to its own page instead.
                    : item.children && !icons
                      ? { onClick: () => setOpen(expanded ? null : item.href) }
                      : { component: Link, href: item.href })}
                  selected={!item.disabled && !!active}
                  sx={{
                    // Materio's signature: the active pill bleeds from the
                    // panel's left edge — flat left, rounded right. In icons
                    // mode it becomes a centred rounded tile, since a
                    // half-pill on a 72px panel just looks cut off.
                    ...(icons
                      ? { borderRadius: 2, minHeight: 44, mb: 0.5, mx: 'auto',
                          width: 46, justifyContent: 'center', px: 0 }
                      : { borderRadius: '0 999px 999px 0', minHeight: 44, mb: 0.5,
                          pl: 3, pr: 2 }),
                    '&.Mui-selected, &.Mui-selected:hover': {
                      color: '#fff',
                      background: (t) =>
                        `linear-gradient(270deg, ${t.palette.primary.light}, ${t.palette.primary.main})`,
                      boxShadow: (t) => `0 4px 10px -2px ${alpha(t.palette.primary.main, 0.5)}`,
                      '& .MuiListItemIcon-root': { color: '#fff' },
                    },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: icons ? 0 : 34, color: 'text.secondary' }}>
                    {item.icon}
                  </ListItemIcon>
                  {!icons && (
                    <ListItemText
                      primary={item.label}
                      slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 500 } } }}
                    />
                  )}
                  {!icons && item.badge && (
                    <Chip label={item.badge} size="small"
                          sx={{ ml: 'auto', height: 20, fontSize: 10, fontWeight: 600,
                                // Opacity is inherited from the disabled button;
                                // lifted back or the chip is unreadable on the
                                // very items it labels.
                                opacity: 2 }} />
                  )}
                  {!icons && item.children && (
                    <Box component="span"
                         sx={{ ml: 'auto', display: 'flex', opacity: 0.6,
                               transform: expanded ? 'rotate(90deg)' : 'none',
                               transition: 'transform 0.15s' }}>
                      <Glyph d="M9 6l6 6-6 6" size={14} />
                    </Box>
                  )}
                </ListItemButton>
              );

              return (
                <Box key={item.href}>
                  {icons ? (
                    <Tooltip title={item.label} placement="right">
                      <Box component="span" sx={{ display: 'block' }}>{row}</Box>
                    </Tooltip>
                  ) : row}

                  {!icons && item.children && (
                    <Collapse in={expanded} unmountOnExit>
                      <List dense sx={{ pl: 5.5, py: 0 }}>
                        {item.children.map((c) => (
                          <ListItemButton
                            key={c.href} component={Link} href={c.href}
                            selected={pathname === c.href}
                            sx={{ borderRadius: 999, minHeight: 36, pl: 1.5,
                                  '&.Mui-selected': {
                                    bgcolor: 'transparent', color: 'primary.main',
                                    '& .MuiListItemText-primary': { fontWeight: 600 } } }}
                          >
                            {/* A ring, not an icon. Giving each nested item its
                                own glyph makes one group read as five unrelated
                                destinations. */}
                            <ListItemIcon sx={{ minWidth: 26 }}>
                              <Box sx={{ width: 6, height: 6, borderRadius: '50%',
                                         border: '1.5px solid currentColor',
                                         opacity: pathname === c.href ? 1 : 0.55 }} />
                            </ListItemIcon>
                            <ListItemText primary={c.label}
                                          slotProps={{ primary: { sx: { fontSize: 13 } } }} />
                          </ListItemButton>
                        ))}
                      </List>
                    </Collapse>
                  )}
                </Box>
              );
            })}
          </List>
        ))}
      </Box>
    </Box>
  );
}

function Glyph({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
