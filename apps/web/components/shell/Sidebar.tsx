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

// YZEN's default menu is dark (data-menu-styles="dark") over a light page and
// light header. The charcoal is their rgb(45,45,48); text is muted white,
// icons stay primary-green, and the active item is green text on a faint
// green wash. These are fixed rather than theme palette values because the
// dark rail is a constant of the design, not something that flips with the
// page's light/dark mode.
const RAIL_BG = '#2d2d30';
const RAIL_BORDER = 'rgba(255, 255, 255, 0.08)';
const RAIL_TEXT = 'rgba(255, 255, 255, 0.72)';
const RAIL_LABEL = 'rgba(255, 255, 255, 0.38)';
const RAIL_HOVER = 'rgba(255, 255, 255, 0.06)';

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
        bgcolor: RAIL_BG,
        color: RAIL_TEXT,
        borderRight: `1px solid ${RAIL_BORDER}`,
        transition: (t) => t.transitions.create('width', { duration: 200 }),
        overflow: 'hidden',
      }}
    >
      {/* Brand */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, height: 64, flexShrink: 0,
                 px: icons ? 0 : 3, justifyContent: icons ? 'center' : 'flex-start',
                 borderBottom: `1px solid ${RAIL_BORDER}` }}>
        <Box
          component={Link}
          href="/"
          sx={{
            width: 32, height: 32, borderRadius: 1.5, display: 'grid', placeItems: 'center',
            flexShrink: 0, fontWeight: 800, fontSize: 16, color: '#fff', textDecoration: 'none',
            bgcolor: 'primary.main',
          }}
        >
          T
        </Box>
        {!icons && (
          <Typography sx={{ fontWeight: 800, fontSize: 19, letterSpacing: '-0.01em', color: '#fff' }} noWrap>
            {brand}
          </Typography>
        )}
      </Box>

      <Box sx={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, pb: 2 }} className="scroll-thin">
        {sections.map((section) => (
          <List key={section.heading} dense sx={{ pl: 0, pr: icons ? 0 : 1.5, py: 0 }}>
            {!icons && (
              // YZEN's category label: small, uppercase, wide-tracked, muted —
              // no divider rule. The all-caps section header is the single
              // biggest "this is an admin console" tell in their sidebar.
              <Box sx={{ pl: 3, pr: 1.5, pt: 2.75, pb: 0.75 }}>
                <Typography
                  sx={{ fontWeight: 600, color: RAIL_LABEL, fontSize: 11,
                        letterSpacing: '0.09em', textTransform: 'uppercase',
                        whiteSpace: 'nowrap' }}>
                  {section.heading}
                </Typography>
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
                    // YZEN's active item is not a filled pill — it is the item
                    // turned PRIMARY: green text, green icon, semibold, over a
                    // faint green wash. The icons are green even when inactive,
                    // which is YZEN's signature (.side-menu__icon { color:
                    // primary }); the label is the thing that changes weight
                    // and colour on select.
                    borderRadius: 2, minHeight: 42, mb: 0.25, color: RAIL_TEXT,
                    ...(icons
                      ? { mx: 'auto', width: 46, justifyContent: 'center', px: 0 }
                      : { mx: 1, px: 2 }),
                    '&:hover': { bgcolor: RAIL_HOVER, color: '#fff' },
                    '&.Mui-selected, &.Mui-selected:hover': {
                      color: 'primary.main',
                      bgcolor: (t) => alpha(t.palette.primary.main, 0.14),
                      '& .MuiListItemText-primary': { fontWeight: 700 },
                      '& .MuiListItemIcon-root': { color: 'primary.main' },
                    },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: icons ? 0 : 32, color: 'primary.main' }}>
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
                            sx={{ borderRadius: 2, minHeight: 36, pl: 1.5, color: RAIL_TEXT,
                                  '&:hover': { bgcolor: RAIL_HOVER, color: '#fff' },
                                  '&.Mui-selected': {
                                    bgcolor: 'transparent', color: 'primary.main',
                                    '& .MuiListItemText-primary': { fontWeight: 700 } } }}
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
