// ============================================================================
//  Lets Node run the Sheets engine's TypeScript directly.
//
//  Node 24 strips types from .ts files on its own, but the engine's imports
//  are written the way Next.js wants them — './parser', not './parser.ts'.
//  This hook tries the specifier as written, then with '.ts', then as a
//  folder's index.ts. Nothing else is changed.
//
//    node --import ./tests/sheets/register.mjs --test tests/sheets/
// ============================================================================

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (!specifier.startsWith('.')) throw e;
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return next(specifier + suffix, context);
        } catch {
          // try the next form
        }
      }
      throw e;
    }
  },
});
