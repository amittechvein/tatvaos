// The editor's schema is TypeScript in apps/web, written for a bundler: its
// relative imports have no extension ("./extensions"). Node strips the types
// itself (24+); this only adds ".ts" to an extension-less relative import.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return next(`${specifier}.ts`, context); } catch { /* fall through */ }
    }
    return next(specifier, context);
  },
});
