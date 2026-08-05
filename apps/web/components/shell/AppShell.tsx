'use client';

import Box from '@mui/material/Box';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { PANEL_WIDTH, PRODUCT_RAIL_WIDTH, Sidebar, type NavSection } from './Sidebar';
import { useTheme as useAppearance } from '@/lib/theme';
import { Topbar } from './Topbar';

/**
 * Rail, topbar, content.
 *
 * One shell for the platform console, the customer console and the mail
 * client. They differ in navigation and in one chip — not in layout. Three
 * shells would drift, and the day they drift is the day someone mistakes the
 * platform console for a customer's.
 */
export function AppShell({
  scope,
  brand,
  sections,
  title,
  breadcrumb,
  actions,
  children,
}: {
  scope: 'platform' | 'organisation' | 'mail';
  brand: string;
  sections: NavSection[];
  title?: string;
  breadcrumb?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { railMode } = useAppearance();

  // The rail and panel are position:fixed so navigation never scrolls away
  // under a long thread. Fixed elements are out of flow, so the content column
  // has to be offset by hand — this is the price of the sticky rail, and it is
  // one number rather than a scroll listener.
  const offset =
    railMode === 'hidden'   ? 0
    : railMode === 'icons'  ? PRODUCT_RAIL_WIDTH
    : PRODUCT_RAIL_WIDTH + PANEL_WIDTH;

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Sidebar sections={sections} brand={brand} />

      {/* minWidth:0 is load-bearing. A flex child defaults to min-width:auto,
          so one wide table would push the whole column past the viewport
          instead of scrolling inside its own container. */}
      <Box sx={{
        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
        ml: `${offset}px`,
        transition: (t) => t.transitions.create('margin-left', { duration: 200 }),
      }}>
        <Topbar scope={scope} />

        <Box component="main" sx={{ flex: 1, p: { xs: 2, sm: 3 } }}>
          {(title || breadcrumb || actions) && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'flex-start', mb: 3 }}>
              <Box sx={{ minWidth: 0 }}>
                {title && <Typography variant="h4">{title}</Typography>}
                {breadcrumb && (
                  <Breadcrumbs sx={{ mt: 0.5, fontSize: 13 }}>
                    {breadcrumb.map((b) =>
                      b.href ? (
                        <Link key={b.label} href={b.href} underline="hover" color="primary">
                          {b.label}
                        </Link>
                      ) : (
                        // sx, not fontSize as a prop. MUI v9 removed the
                        // system shorthands from Typography — they made every
                        // component's prop surface enormous and ambiguous
                        // against real HTML attributes.
                        <Typography key={b.label} sx={{ color: 'text.secondary', fontSize: 13 }}>
                          {b.label}
                        </Typography>
                      ),
                    )}
                  </Breadcrumbs>
                )}
              </Box>
              {actions && (
                <Box sx={{ ml: 'auto', display: 'flex', gap: 1, flexWrap: 'wrap' }}>{actions}</Box>
              )}
            </Box>
          )}

          {children}
        </Box>
      </Box>
    </Box>
  );
}
