import { createTheme, type Theme } from '@mui/material/styles';

// ============================================================================
//  MUI theme
// ============================================================================
//
//  The visual language follows Materio (ThemeSelection, MIT — see NOTICE):
//  a violet primary, generously rounded cards, soft diffuse shadows instead of
//  borders, and a pill-shaped active navigation item.
//
//  Written as an MUI theme rather than copied from their source so that the
//  accent stays runtime-switchable. Materio hardcodes its palette; this builds
//  one from a single hex, which is what lets the appearance panel recolour the
//  product without a rebuild — and eventually lets a customer apply their own
//  brand colour to their own tenant.
//
//  colorSchemes rather than two separate themes: MUI emits CSS variables for
//  both modes and toggles with a class, so dark mode costs no re-render and
//  does not flash on load.
// ============================================================================

export const DEFAULT_PRIMARY = '#7367f0';

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/** Lighter and darker variants, generated so any hex works. */
function shades(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  return {
    main: hex,
    light: toHex(mix(r, 255, 0.22), mix(g, 255, 0.22), mix(b, 255, 0.22)),
    dark: toHex(mix(r, 20, 0.18), mix(g, 20, 0.18), mix(b, 20, 0.18)),
    contrastText: '#fff',
  };
}

/**
 * Materio's shadows are wide, soft and tinted toward the text colour rather
 * than pure black. Black shadows on a light surface read as grey haze; a
 * tinted one reads as depth.
 */
const shadow = (y: number, blur: number, alpha: number) =>
  `0 ${y}px ${blur}px 0 rgba(58, 53, 65, ${alpha})`;

export function buildTheme(primary: string = DEFAULT_PRIMARY): Theme {
  const p = shades(primary);

  return createTheme({
    cssVariables: { colorSchemeSelector: 'class' },

    colorSchemes: {
      light: {
        palette: {
          primary: p,
          background: { default: '#f4f5fa', paper: '#ffffff' },
          text: {
            primary: 'rgba(58, 53, 65, 0.87)',
            secondary: 'rgba(58, 53, 65, 0.68)',
            disabled: 'rgba(58, 53, 65, 0.38)',
          },
          divider: 'rgba(58, 53, 65, 0.12)',
          success: { main: '#56ca00', contrastText: '#fff' },
          warning: { main: '#ffb400', contrastText: '#fff' },
          error:   { main: '#ff4c51', contrastText: '#fff' },
          info:    { main: '#16b1ff', contrastText: '#fff' },
        },
      },
      dark: {
        palette: {
          primary: p,
          background: { default: '#28243d', paper: '#312d4b' },
          text: {
            primary: 'rgba(231, 227, 252, 0.87)',
            secondary: 'rgba(231, 227, 252, 0.68)',
            disabled: 'rgba(231, 227, 252, 0.38)',
          },
          divider: 'rgba(231, 227, 252, 0.12)',
          success: { main: '#56ca00', contrastText: '#fff' },
          warning: { main: '#ffb400', contrastText: '#fff' },
          error:   { main: '#ff4c51', contrastText: '#fff' },
          info:    { main: '#16b1ff', contrastText: '#fff' },
        },
      },
    },

    shape: { borderRadius: 6 },

    typography: {
      // var(--font-inter) is set by next/font in the root layout. The literal
      // 'Inter' stays as the second choice so a missing variable degrades to
      // any locally installed copy rather than straight to Segoe UI.
      fontFamily: [
        'var(--font-inter)', 'Inter', 'ui-sans-serif', 'system-ui',
        'Segoe UI', 'Roboto', 'Arial', 'sans-serif',
      ].join(','),
      h1: { fontSize: '2.375rem', fontWeight: 500, letterSpacing: '-0.02em' },
      h2: { fontSize: '2rem', fontWeight: 500, letterSpacing: '-0.02em' },
      h3: { fontSize: '1.5rem', fontWeight: 500 },
      h4: { fontSize: '1.3125rem', fontWeight: 500 },
      h5: { fontSize: '1.125rem', fontWeight: 500 },
      h6: { fontSize: '1rem', fontWeight: 500 },
      body1: { fontSize: '0.9375rem' },
      body2: { fontSize: '0.875rem' },
      button: { textTransform: 'none', fontWeight: 500 },
    },

    components: {
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            borderRadius: 12,
            // Softer and wider than the default — depth rather than outline.
            boxShadow: shadow(3, 14, 0.08),
            // No border. Materio separates cards with shadow alone; adding a
            // border as well makes a dense screen look like a spreadsheet.
            backgroundImage: 'none',
            transition: 'box-shadow 0.2s',
            '&:hover': { boxShadow: shadow(5, 20, 0.12) },
          },
        },
      },

      MuiCardHeader: {
        defaultProps: {
          // slotProps, not titleTypographyProps — v9 removed the old names in
          // favour of one slot convention across every component.
          slotProps: {
            title: { variant: 'h6' },
            subheader: { variant: 'body2' },
          },
        },
        styleOverrides: { root: { padding: '22px 24px 12px' } },
      },

      MuiCardContent: {
        styleOverrides: {
          root: { padding: '24px', '&:last-child': { paddingBottom: '24px' } },
        },
      },

      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 6, padding: '8px 20px' },
        },
        // Materio's raised buttons carry a coloured glow rather than a grey
        // shadow, which is what makes the primary action feel lit.
        //
        // A variant rather than the old containedPrimary override key: v9
        // dropped the per-colour class names, and matching on props is more
        // honest anyway — it says which button, not which generated class.
        variants: [
          {
            props: { variant: 'contained', color: 'primary' },
            style: ({ theme }) => ({
              boxShadow: `0 2px 6px 0 ${theme.palette.primary.main}66`,
              '&:hover': { boxShadow: `0 4px 12px 0 ${theme.palette.primary.main}80` },
            }),
          },
        ],
      },

      MuiChip: {
        styleOverrides: {
          root: { fontWeight: 500, borderRadius: 4 },
          sizeSmall: { height: 22, fontSize: '0.75rem' },
        },
      },

      MuiTableCell: {
        styleOverrides: {
          head: {
            fontSize: '0.8125rem',
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          },
        },
      },

      MuiLinearProgress: {
        styleOverrides: { root: { height: 6, borderRadius: 3 } },
      },

      MuiTextField: { defaultProps: { size: 'small' } },

      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },

      MuiTooltip: { defaultProps: { arrow: true } },
    },
  });
}
