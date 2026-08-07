import { alpha, createTheme, type Theme } from '@mui/material/styles';

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

// YZEN's primary green. Must match DEFAULT_ACCENT in lib/theme.tsx — MUI
// builds its palette from whatever the appearance layer resolves to, so two
// files disagreeing ships the product in a colour neither names.
export const DEFAULT_PRIMARY = '#03b562';

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
          // YZEN's exact light surfaces: a cool near-white canvas (#f2f4f9),
          // white cards, ink-black text (#0a0a0a), and the specific muted blue
          // (#8d9eb5) their secondary text uses. Borders are their #e2e5e7.
          background: { default: '#f2f4f9', paper: '#ffffff' },
          text: {
            primary: '#0a0a0a',
            secondary: '#8d9eb5',
            disabled: '#a8b3c7',
          },
          divider: '#e6e9ee',
          success: { main: '#03b562', contrastText: '#fff' },
          warning: { main: '#f5b849', contrastText: '#fff' },
          error:   { main: '#e6533c', contrastText: '#fff' },
          info:    { main: '#49b6f5', contrastText: '#fff' },
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

    // Squarer than Materio's soft 6px. An enterprise/banking console reads as
    // precise, not playful — defined edges, not pillows. 8px is the compromise
    // that still lets the edge-bleed nav pill and chips look intentional.
    shape: { borderRadius: 8 },

    typography: {
      // var(--font-inter) is set by next/font in the root layout. The literal
      // 'Inter' stays as the second choice so a missing variable degrades to
      // any locally installed copy rather than straight to Segoe UI.
      fontFamily: [
        'var(--font-inter)', 'Inter', 'ui-sans-serif', 'system-ui',
        'Segoe UI', 'Roboto', 'Arial', 'sans-serif',
      ].join(','),
      // Heavier headings than Materio's 500. Bold type is the cheapest way a
      // dense data console reads as authoritative rather than sketchy.
      h1: { fontSize: '2.375rem', fontWeight: 700, letterSpacing: '-0.022em' },
      h2: { fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.022em' },
      h3: { fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.015em' },
      h4: { fontSize: '1.3125rem', fontWeight: 700, letterSpacing: '-0.01em' },
      h5: { fontSize: '1.125rem', fontWeight: 700, letterSpacing: '-0.01em' },
      h6: { fontSize: '1rem', fontWeight: 700, letterSpacing: '-0.005em' },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      body1: { fontSize: '0.9375rem' },
      body2: { fontSize: '0.875rem' },
      button: { textTransform: 'none', fontWeight: 600 },
    },

    components: {
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: ({ theme }) => ({
            // YZEN cards: white, a hairline border, a barely-there shadow, and
            // a modest 10px radius. Definition comes from the border, not a
            // drop shadow — that is what makes a dense grid of them read as an
            // admin console rather than a set of floating consumer tiles.
            borderRadius: 10,
            border: `1px solid ${theme.palette.divider}`,
            boxShadow: '0 1px 2px 0 rgba(16, 24, 40, 0.04)',
            backgroundImage: 'none',
            transition: 'box-shadow 0.2s, border-color 0.2s',
            '&:hover': {
              boxShadow: '0 4px 16px 0 rgba(16, 24, 40, 0.08)',
              borderColor: alpha(theme.palette.primary.main, 0.28),
            },
          }),
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
        // A ruled header. The divider under the title is what separates a
        // "section of a report" from "some text above some other text".
        styleOverrides: {
          root: ({ theme }) => ({
            padding: '18px 22px',
            borderBottom: `1px solid ${theme.palette.divider}`,
          }),
        },
      },

      MuiCardContent: {
        styleOverrides: {
          root: { padding: '22px', '&:last-child': { paddingBottom: '22px' } },
        },
      },

      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 8, padding: '8px 18px', fontWeight: 600 },
          sizeLarge: { padding: '11px 24px', fontSize: '0.95rem' },
        },
        // Materio's raised buttons carry a coloured glow rather than a grey
        // shadow, which is what makes the primary action feel lit. Stronger
        // here — the primary action on a bank screen should be unmissable.
        variants: [
          {
            props: { variant: 'contained', color: 'primary' },
            style: ({ theme }) => ({
              boxShadow: `0 3px 10px 0 ${theme.palette.primary.main}59`,
              '&:hover': { boxShadow: `0 6px 18px 0 ${theme.palette.primary.main}73` },
            }),
          },
          {
            props: { variant: 'outlined', color: 'inherit' },
            style: ({ theme }) => ({
              borderColor: theme.palette.divider,
              color: theme.palette.text.primary,
              '&:hover': {
                borderColor: alpha(theme.palette.primary.main, 0.5),
                backgroundColor: alpha(theme.palette.primary.main, 0.04),
              },
            }),
          },
        ],
      },

      MuiChip: {
        styleOverrides: {
          // Filled status chips read stronger than Materio's tint because the
          // palette gives success/warning/error contrastText #fff — a status a
          // bank operator scans a column for must not be a pastel whisper.
          root: { fontWeight: 600, borderRadius: 6 },
          sizeSmall: { height: 22, fontSize: '0.75rem', letterSpacing: '0.01em' },
        },
      },

      // Ruled, tinted, hoverable tables — the single biggest "bank-grade"
      // signal. A data table with a fill behind the header and lines between
      // rows reads as a ledger; borderless rows read as a marketing list.
      MuiTableContainer: {
        styleOverrides: { root: { borderRadius: 0 } },
      },

      MuiTableHead: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.mode === 'dark'
              ? alpha(theme.palette.common.white, 0.03)
              : alpha(theme.palette.text.primary, 0.025),
          }),
        },
      },

      MuiTableRow: {
        styleOverrides: {
          root: ({ theme }) => ({
            transition: 'background-color 0.12s',
            '&:hover': {
              backgroundColor: alpha(theme.palette.primary.main, 0.045),
            },
            '&:last-of-type td': { borderBottom: 'none' },
          }),
          head: { '&:hover': { backgroundColor: 'transparent' } },
        },
      },

      MuiTableCell: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderBottom: `1px solid ${theme.palette.divider}`,
            padding: '12px 20px',
          }),
          head: ({ theme }) => ({
            fontSize: '0.75rem',
            fontWeight: 700,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
            color: theme.palette.text.secondary,
            borderBottom: `2px solid ${theme.palette.divider}`,
            paddingTop: '13px',
            paddingBottom: '13px',
          }),
        },
      },

      MuiLinearProgress: {
        styleOverrides: {
          root: ({ theme }) => ({
            height: 7,
            borderRadius: 4,
            backgroundColor: alpha(theme.palette.text.primary, 0.08),
          }),
        },
      },

      MuiTextField: { defaultProps: { size: 'small' } },

      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: 8,
            '&:hover .MuiOutlinedInput-notchedOutline': {
              borderColor: alpha(theme.palette.primary.main, 0.5),
            },
          }),
        },
      },

      MuiDialog: {
        styleOverrides: {
          paper: ({ theme }) => ({
            borderRadius: 14,
            border: `1px solid ${theme.palette.divider}`,
            boxShadow: shadow(12, 48, 0.20),
          }),
        },
      },

      MuiDialogTitle: {
        styleOverrides: { root: { fontWeight: 700, fontSize: '1.15rem' } },
      },

      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },

      MuiTooltip: { defaultProps: { arrow: true } },
    },
  });
}
