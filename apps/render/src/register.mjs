// ============================================================================
//  How the render service loads the editor's schema
// ============================================================================
//
//  The schema is TypeScript in apps/web/components/docs (schema.ts and
//  extensions.ts) — the SAME files the editor imports; there is no copy.
//  Node 24 strips the types itself. Two things a bundler does that Node does
//  not, done here and nothing else:
//
//    1. "./extensions" (no extension) is tried as "./extensions.ts".
//    2. A package the schema imports ("@tiptap/starter-kit") is found in THIS
//       package's node_modules when the schema's own folder has none — which
//       is the case in the container, where only apps/render's dependencies
//       are installed (all pinned to the web app's exact versions).
// ============================================================================

import { registerHooks } from 'node:module';

const here = new URL('../package.json', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try { return next(`${specifier}.ts`, context); } catch { /* fall through */ }
    }
    try {
      return next(specifier, context);
    } catch (e) {
      const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':');
      if (bare && context.parentURL !== here) return next(specifier, { ...context, parentURL: here });
      throw e;
    }
  },
});
