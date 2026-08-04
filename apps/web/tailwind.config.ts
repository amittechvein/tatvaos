import type { Config } from 'tailwindcss';

// ============================================================================
//  Design tokens
// ============================================================================
//
//  The visual language follows the Spruha admin template the manager chose:
//  a dark navy rail with a curved active item, an indigo accent, a faintly
//  lavender canvas, and white cards with a barely-there shadow.
//
//  Rebuilt as our own tokens rather than importing the template. Spruha is a
//  commercial Bootstrap theme — its stylesheet, markup and images are licensed
//  and cannot simply be copied — and it targets Bootstrap 5, which does not
//  coexist happily with Tailwind and React 19. A layout convention is not
//  copyrightable; a stylesheet is. Same look, neither problem.
//
//  ---------------------------------------------------------------------------
//  Themeable colours are CSS variables, defined in styles/globals.css.
//  That is what lets the switcher recolour the entire product in one frame
//  with no rebuild and no flash. Do not replace them with hex values.
//  ---------------------------------------------------------------------------

const withAlpha = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

export default {
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

        // Status colours are NOT themeable. Red means danger regardless of
        // which accent the customer picked; letting it be recoloured would
        // eventually produce a green "delete" button.
        ok:     '#22c03c',
        warn:   '#f7b731',
        danger: '#ee335e',
        info:   '#00b0f0',
      },

      boxShadow: {
        // One card shadow, barely there. The reference separates cards with a
        // faint edge rather than depth; heavier shadows make a dense admin
        // screen look cluttered.
        card:   '0 1px 2px 0 rgba(40, 47, 83, 0.06)',
        raised: '0 4px 16px -2px rgba(40, 47, 83, 0.12)',
        rail:   '0 0 20px 0 rgba(0, 0, 0, 0.10)',
      },

      borderRadius: { card: '7px' },

      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },

      fontSize: {
        label: ['11px', { lineHeight: '16px', letterSpacing: '0.06em' }],
      },

      spacing: {
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
