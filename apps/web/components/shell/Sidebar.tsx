'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
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

export const RAIL_WIDTH = 260;
export const RAIL_WIDTH_ICONS = 72;

/**
 * The navigation rail.
 *
 * The active item is a fully rounded pill with a violet gradient and a
 * coloured glow beneath it — Materio's signature, and the thing that makes
 * the accent colour feel like the product's rather than a highlight applied
 * to it. Built from theme values, not fixed hexes, so it follows whatever
 * accent the user picks in the appearance panel.
 *
 * A permanent Drawer rather than a fixed <aside>: MUI handles the elevation,
 * the scroll containment and the width transition, and switching to a
 * temporary Drawer on mobile later is one prop rather than a rewrite.
 */
export function Sidebar({ sections, brand }: { sections: NavSection[]; brand: string }) {
  const pathname = usePathname();
  const { railMode } = useAppearance();
  const [open, setOpen] = useState<string | null>(null);

  if (railMode === 'hidden') return null;
  const icons = railMode === 'icons';
  const width = icons ? RAIL_WIDTH_ICONS : RAIL_WIDTH;

  return (
    <Drawer
      variant="permanent"
      sx={{
        width,
        flexShrink: 0,
        // The transition is on the paper too, or the rail snaps to its new
        // width while the content area slides.
        transition: (t) => t.transitions.create('width', { duration: 200 }),
        '& .MuiDrawer-paper': {
          width,
          border: 0,
          boxShadow: (t) => `0 0 12px 0 ${alpha(t.palette.text.primary, 0.08)}`,
          overflowX: 'hidden',
          transition: (t) => t.transitions.create('width', { duration: 200 }),
        },
      }}
    >
      {/* Brand */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, height: 64, px: icons ? 0 : 3,
                 justifyContent: icons ? 'center' : 'flex-start', flexShrink: 0 }}>
        <Box
          sx={{
            width: 32, height: 32, borderRadius: 1.5, display: 'grid', placeItems: 'center',
            fontWeight: 700, fontSize: 15, color: '#fff',
            background: (t) => `linear-gradient(72deg, ${t.palette.primary.main}, ${t.palette.primary.light})`,
          }}
        >
          T
        </Box>
        {!icons && (
          <Typography sx={{ fontWeight: 700, letterSpacing: '0.02em', fontSize: 19 }}>
            {brand}
          </Typography>
        )}
      </Box>

      <Box sx={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, pb: 2 }} className="scroll-thin">
        {sections.map((section) => (
          <List key={section.heading} dense sx={{ px: 1.5, py: 0 }}>
            {/* Heading with a rule running off to the right — Materio's way of
                separating groups without drawing a full divider across the
                rail, which would cut the active pill in half. */}
            {!icons && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, pt: 2.5, pb: 1 }}>
                <Typography
                  variant="caption"
                  sx={{ fontWeight: 500, color: 'text.disabled', fontSize: 12,
                        whiteSpace: 'nowrap' }}
                >
                  {section.heading}
                </Typography>
                <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
              </Box>
            )}

            {section.items.map((item) => {
              const active =
                pathname === item.href ||
                pathname.startsWith(`${item.href}/`) ||
                item.children?.some((c) => pathname === c.href);
              const expanded = open === item.href;

              const row = (
                <ListItemButton
                  {...(item.disabled
                    ? { disabled: true }
                    : item.children
                      ? { onClick: () => setOpen(expanded ? null : item.href) }
                      : { component: Link, href: item.href })}
                  selected={!item.disabled && !!active}
                  title={icons ? item.label : undefined}
                  sx={{
                    borderRadius: 999,
                    minHeight: 42,
                    mb: 0.25,
                    px: icons ? 0 : 2,
                    justifyContent: icons ? 'center' : 'flex-start',
                    '&.Mui-selected, &.Mui-selected:hover': {
                      color: '#fff',
                      background: (t) =>
                        `linear-gradient(72deg, ${t.palette.primary.main}, ${t.palette.primary.light})`,
                      boxShadow: (t) => `0 2px 6px 0 ${alpha(t.palette.primary.main, 0.48)}`,
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
                    <Chip
                      label={item.badge}
                      size="small"
                      sx={{ ml: 'auto', height: 20, fontSize: 10, fontWeight: 600,
                            // Opacity is inherited from the disabled button, so
                            // this needs lifting back or the chip is unreadable.
                            opacity: 2 }}
                    />
                  )}

                  {!icons && item.children && (
                    <Box component="span" sx={{ ml: 'auto', display: 'flex', opacity: 0.6,
                      transform: expanded ? 'rotate(90deg)' : 'none',
                      transition: 'transform 0.15s' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                           stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                           strokeLinejoin="round">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </Box>
                  )}
                </ListItemButton>
              );

              return (
                <Box key={item.href}>
                  {row}
                  {!icons && item.children && (
                    <Collapse in={expanded} unmountOnExit>
                      <List dense sx={{ pl: 4, py: 0 }}>
                        {item.children.map((c) => (
                          <ListItemButton
                            key={c.href}
                            component={Link}
                            href={c.href}
                            selected={pathname === c.href}
                            sx={{ borderRadius: 999, minHeight: 34, pl: 1.5,
                                  '&.Mui-selected': { bgcolor: 'transparent', color: 'primary.main' } }}
                          >
                            {/* A small ring rather than an icon. Nested items
                                in Materio are marked, not iconified — giving
                                each one its own glyph makes the group read as
                                five unrelated destinations. */}
                            <ListItemIcon sx={{ minWidth: 26 }}>
                              <Box sx={{ width: 6, height: 6, borderRadius: '50%',
                                         border: '1.5px solid currentColor',
                                         opacity: pathname === c.href ? 1 : 0.55 }} />
                            </ListItemIcon>
                            <ListItemText
                              primary={c.label}
                              slotProps={{ primary: { sx: { fontSize: 13 } } }}
                            />
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
    </Drawer>
  );
}
