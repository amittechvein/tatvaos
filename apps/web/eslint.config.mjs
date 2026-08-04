// ============================================================================
//  ESLint — flat config
// ============================================================================
//
//  `next lint` is deprecated and disappears in Next 16, and ESLint itself was
//  never actually installed — so the CI lint job had been passing a command
//  that did nothing. This replaces it with the ESLint CLI directly.
//
//  FlatCompat is here because eslint-config-next still ships as a legacy
//  eslintrc-style config while ESLint 9 expects flat config. It is a shim, not
//  a preference; drop it when eslint-config-next ships flat natively.
// ============================================================================

import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'public/**'],
  },

  ...compat.extends('next/core-web-vitals', 'next/typescript'),

  {
    rules: {
      // An unused variable is usually a half-finished edit. Warn rather than
      // error so it does not block a deploy, but keep it visible. The leading
      // underscore is the escape hatch for a deliberately ignored argument.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // ------------------------------------------------------------------
    //  The one rule that is a security control rather than a style choice.
    //
    //  dangerouslySetInnerHTML on untrusted mail content is how a cross-site
    //  scripting bug reaches every tenant at once. SafeHtml.tsx is the single
    //  audited place that renders message bodies — sanitised, then put in a
    //  sandboxed iframe with no allow-scripts and no allow-same-origin.
    //
    //  If a second file ever needs this, that is a conversation, not a
    //  one-line addition to this array.
    // ------------------------------------------------------------------
    files: ['**/*.tsx'],
    ignores: ['components/mail/SafeHtml.tsx'],
    rules: {
      'react/no-danger': 'error',
    },
  },
];

export default config;
