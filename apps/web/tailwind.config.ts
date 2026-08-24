import type { Config } from 'tailwindcss';

// ============================================================================
//  Design tokens
// ============================================================================
//
//  The visual language is YZEN's (licensed to Techvein): green primary, cool
//  near-white canvas, white cards, dark rail. These tokens exist for the
//  Tailwind-built surfaces (the Mail client) and mirror the values YZEN's
//  stylesheet ships, so both styling systems render one product.
//
//  ---------------------------------------------------------------------------
//  Colours are CSS variables, defined in styles/globals.css. They are static
//  (the runtime accent switcher is gone); the variables remain so light/dark
//  can swap the neutral set with one class.
//  ---------------------------------------------------------------------------

const withAlpha = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  // ---------------------------------------------------------------------------
  //  Preflight OFF.
  //
  //  Two CSS resets in one page fight each other. MUI's CssBaseline already
  //  normalises the document, and Tailwind's preflight is more aggressive —
  //  it zeroes every border width, which is exactly how MUI's outlined inputs
  //  lost their outline and its buttons lost their fill.
  //
  //  Tailwind's utilities still work; only the reset is gone, and MUI is
  //  doing that job.
  // ---------------------------------------------------------------------------
  corePlugins: { preflight: false },

  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/*/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: withAlpha('--brand-50'),   100: withAlpha('--brand-100'),
          200: withAlpha('--brand-200'), 300: withAlpha('--brand-300'),
          400: withAlpha('--brand-400'), 500: withAlpha('--brand-500'),
          600: withAlpha('--brand-600'), 700: withAlpha('--brand-700'),
          800: withAlpha('--brand-800'), 900: withAlpha('--brand-900'),
        },

        rail: {
          DEFAULT: withAlpha('--rail'),
          soft:    withAlpha('--rail-soft'),
          text:    withAlpha('--rail-text'),
          heading: withAlpha('--rail-heading'),
        },

        canvas:  withAlpha('--canvas'),
        surface: withAlpha('--surface'),

        ink: {
          DEFAULT: withAlpha('--ink'),
          muted:   withAlpha('--ink-muted'),
          faint:   withAlpha('--ink-faint'),
        },

        line: withAlpha('--line'),

        // Status colours are NOT themeable, and they are YZEN's own values
        // (--success/--warning/--danger/--info-rgb in their stylesheet) so a
        // Tailwind badge and a YZEN badge signalling the same state are the
        // same colour.
        ok:     '#53c405',
        warn:   '#ffa909',
        danger: '#fd4963',
        info:   '#0fbcf9',
      },

      boxShadow: {
        // Calm-premium pass, 24 Aug 2026 (Amit's brief: "hero product, not a
        // copy of Gmail"). Two layers instead of one: a hairline for the edge
        // and a soft low wash for lift. Individually invisible, together a
        // card that sits ON the canvas rather than being drawn on it. The
        // raised shadow got deeper and softer — popovers should feel like
        // they float, not like they have a border smeared under them.
        card:   '0 1px 2px 0 rgba(40, 47, 83, 0.04), 0 2px 8px -2px rgba(40, 47, 83, 0.06)',
        raised: '0 12px 32px -8px rgba(40, 47, 83, 0.18)',
        rail:   '0 0 20px 0 rgba(0, 0, 0, 0.10)',
      },

      // 12px, up from 7. The single cheapest "premium" signal there is:
      // tight radii read as dense utility software, roomy ones as product.
      borderRadius: { card: '12px' },

      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },

      fontSize: {
        label: ['11px', { lineHeight: '16px', letterSpacing: '0.06em' }],
      },

      spacing: {
        // 18px icons — the mail list uses h-4.5 in several places, and
        // without this token Tailwind generates nothing for that class.
        '4.5': '1.125rem',
        rail: '240px',
        'rail-sm': '70px',
        topbar: '64px',
      },

      transitionProperty: {
        rail: 'width, transform, margin-left',
      },
    },
  },
  plugins: [],
} satisfies Config;
