'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { useTheme as useAppearance } from '@/lib/theme';
import { RAIL_PRODUCTS } from '@/lib/nav';

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

export const PRODUCT_RAIL_WIDTH = 68;
export const PANEL_WIDTH = 262;

// ============================================================================
//  Two tiers, because the product has two levels of navigation
// ============================================================================
//
//  The narrow coloured rail is WHICH PRODUCT — Core, Mail, Drive, Payroll.
//  The panel beside it is WHERE INSIDE IT. That split is not decoration: it
//  mirrors the Core/product architecture, so adding Drive next year means one
//  entry in the rail and its own panel, with nothing about this file changing.
//
//  A single flat list would have to mix "Mail" and "Departments" as peers,
//  and they are not peers — one is a product, the other is a screen within
//  one. Users read that confusion as clutter long before they can name it.
//
//  ---------------------------------------------------------------------------
//  THE RAIL AND PANEL ARE FIXED; ONLY THE CONTENT COLUMN SCROLLS.
//
//  On a mail client you scroll constantly, and navigation that scrolls away
//  with a long message means scrolling back up to go anywhere. Both tiers are
//  position:fixed at full viewport height with their own internal overflow,
//  and AppShell offsets the content by their combined width.
//  ---------------------------------------------------------------------------

/** Which rail entry owns the current URL. */
function activeProduct(pathname: string): string {
  const hit = RAIL_PRODUCTS.find(
    (p) => p.match.some((m) => pathname === m || pathname.startsWith(`${m}/`)));
  return hit?.code ?? RAIL_PRODUCTS[0]?.code ?? 'core';
}

export function Sidebar({ sections, brand }: { sections: NavSection[]; brand: string }) {
  const pathname = usePathname();
  const { railMode } = useAppearance();
  const [open, setOpen] = useState<string | null>(null);

  // LONGEST match wins, across the whole panel. "/org" is a prefix of every
  // page in the console, so prefix-matching each item independently lit the
  // Dashboard pill on all of them — two glowing pills on every screen, seen
  // the first time the new shell was actually looked at rather than built.
  const activeHref = sections
    .flatMap((sec) => sec.items)
    .flatMap((i) => [i.href, ...(i.children?.map((c) => c.href) ?? [])])
    .filter((h) => h && (pathname === h || pathname.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];

  if (railMode === 'hidden') return null;

  const current = activeProduct(pathname);
  const showPanel = railMode === 'expanded';

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      {/*  Tier 1 — products                                               */}
      {/* ---------------------------------------------------------------- */}
      <Box
        component="nav"
        aria-label="Products"
        sx={{
          position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: (t) => t.zIndex.drawer + 1,
          width: PRODUCT_RAIL_WIDTH,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          // A solid accent block rather than a tinted surface. It is the one
          // element that should read as the brand from across a room.
          background: (t) => `linear-gradient(180deg, ${t.palette.primary.main}, ${t.palette.primary.dark})`,
          color: '#fff',
        }}
      >
        <Tooltip title={brand} placement="right">
          <Box
            component={Link}
            href="/"
            sx={{
              width: 40, height: 40, mt: 1.75, mb: 2, borderRadius: 2,
              display: 'grid', placeItems: 'center', flexShrink: 0,
              fontWeight: 700, fontSize: 17, color: '#fff', textDecoration: 'none',
              bgcolor: alpha('#fff', 0.18),
            }}
          >
            T
          </Box>
        </Tooltip>

        <Box sx={{ flex: 1, width: '100%', overflowY: 'auto', overflowX: 'hidden' }}
             className="scroll-thin">
          {RAIL_PRODUCTS.map((p) => {
            const isCurrent = p.code === current;
            return (
              <Tooltip key={p.code} placement="right"
                       title={p.live ? p.label : `${p.label} — coming soon`}>
                {/* span, because a disabled button does not fire the events a
                    Tooltip listens for, and "why is there no tooltip on the
                    greyed items" is a real question people ask. */}
                <Box component="span" sx={{ display: 'block' }}>
                  <IconButton
                    {...(p.live ? { component: Link, href: p.href } : { disabled: true })}
                    aria-current={isCurrent ? 'page' : undefined}
                    sx={{
                      width: 44, height: 44, mx: 'auto', my: 0.4, borderRadius: 2,
                      display: 'flex',
                      color: isCurrent ? '#fff' : alpha('#fff', 0.62),
                      bgcolor: isCurrent ? alpha('#fff', 0.2) : 'transparent',
                      '&:hover': { bgcolor: alpha('#fff', 0.14), color: '#fff' },
                      '&.Mui-disabled': { color: alpha('#fff', 0.3) },
                    }}
                  >
                    {p.icon}
                  </IconButton>
                </Box>
              </Tooltip>
            );
          })}
        </Box>

        {/* Utility, pinned to the bottom like the reference. Kept apart from
            navigation because these are things you DO, not places you go. */}
        <Box sx={{ pb: 1.5, display: 'flex', flexDirection: 'column', gap: 0.4 }}>
          <Tooltip title="Support" placement="right">
            <IconButton sx={{ color: alpha('#fff', 0.62), '&:hover': { color: '#fff' } }}>
              <Glyph d="M12 21a9 9 0 100-18 9 9 0 000 18zM9.1 9a3 3 0 015.8 1c0 2-3 2.6-3 4M12 17h.01" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* ---------------------------------------------------------------- */}
      {/*  Tier 2 — where inside this product                              */}
      {/* ---------------------------------------------------------------- */}
      <Collapse in={showPanel} orientation="horizontal" timeout={200}
                sx={{ position: 'fixed', top: 0, bottom: 0, left: PRODUCT_RAIL_WIDTH,
                      zIndex: (t) => t.zIndex.drawer }}>
        <Box
          component="nav"
          aria-label="Sections"
          sx={{
            width: PANEL_WIDTH, height: '100%',
            display: 'flex', flexDirection: 'column',
            bgcolor: 'background.paper',
            borderRight: '1px solid', borderColor: 'divider',
          }}
        >
          <Box sx={{ height: 64, px: 3, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 18, letterSpacing: '0.01em' }} noWrap>
              {brand}
            </Typography>
          </Box>

          <Box sx={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, pb: 2 }}
               className="scroll-thin">
            {sections.map((section) => (
              <List key={section.heading} dense sx={{ px: 1.5, py: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, pt: 2.5, pb: 1 }}>
                  <Typography variant="caption"
                              sx={{ fontWeight: 500, color: 'text.disabled', fontSize: 12,
                                    whiteSpace: 'nowrap' }}>
                    {section.heading}
                  </Typography>
                  <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
                </Box>

                {section.items.map((item) => {
                  const active =
                    item.href === activeHref ||
                    item.children?.some((c) => c.href === activeHref);
                  const expanded = open === item.href;

                  return (
                    <Box key={item.href}>
                      <ListItemButton
                        {...(item.disabled
                          ? { disabled: true }
                          : item.children
                            ? { onClick: () => setOpen(expanded ? null : item.href) }
                            : { component: Link, href: item.href })}
                        selected={!item.disabled && !!active}
                        sx={{
                          borderRadius: 999, minHeight: 42, mb: 0.25, px: 2,
                          '&.Mui-selected, &.Mui-selected:hover': {
                            color: '#fff',
                            background: (t) =>
                              `linear-gradient(72deg, ${t.palette.primary.main}, ${t.palette.primary.light})`,
                            boxShadow: (t) => `0 2px 6px 0 ${alpha(t.palette.primary.main, 0.48)}`,
                            '& .MuiListItemIcon-root': { color: '#fff' },
                          },
                        }}
                      >
                        <ListItemIcon sx={{ minWidth: 34, color: 'text.secondary' }}>
                          {item.icon}
                        </ListItemIcon>
                        <ListItemText
                          primary={item.label}
                          slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 500 } } }}
                        />
                        {item.badge && (
                          <Chip label={item.badge} size="small"
                                sx={{ ml: 'auto', height: 20, fontSize: 10, fontWeight: 600,
                                      // Opacity is inherited from the disabled
                                      // button; lifted back or the chip is
                                      // unreadable on the very items it labels.
                                      opacity: 2 }} />
                        )}
                        {item.children && (
                          <Box component="span"
                               sx={{ ml: 'auto', display: 'flex', opacity: 0.6,
                                     transform: expanded ? 'rotate(90deg)' : 'none',
                                     transition: 'transform 0.15s' }}>
                            <Glyph d="M9 6l6 6-6 6" size={14} />
                          </Box>
                        )}
                      </ListItemButton>

                      {item.children && (
                        <Collapse in={expanded} unmountOnExit>
                          <List dense sx={{ pl: 4, py: 0 }}>
                            {item.children.map((c) => (
                              <ListItemButton
                                key={c.href} component={Link} href={c.href}
                                selected={pathname === c.href}
                                sx={{ borderRadius: 999, minHeight: 34, pl: 1.5,
                                      '&.Mui-selected': {
                                        bgcolor: 'transparent', color: 'primary.main' } }}
                              >
                                {/* A ring, not an icon. Giving each nested item
                                    its own glyph makes one group read as five
                                    unrelated destinations. */}
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
      </Collapse>
    </>
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
