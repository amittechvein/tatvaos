import type { NextConfig } from 'next';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The commit this bundle was built from.
 *
 * Read straight out of .git rather than by shelling out to `git` — the Alpine
 * build image in apps/web/Dockerfile has no git binary, and there is no
 * .dockerignore, so the .git directory IS present in the build context. HEAD
 * points at a branch ref; the loose ref file holds the SHA, with packed-refs as
 * the fallback for a freshly cloned checkout.
 *
 * Every failure path falls through to 'unknown': a missing version stamp must
 * never be the thing that fails a production build.
 */
function resolveSha(): string {
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA.slice(0, 7);
  let dir = process.cwd();
  for (let i = 0; i < 4; i += 1) {
    const gitDir = join(dir, '.git');
    if (existsSync(gitDir)) {
      try {
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref:')) return head.slice(0, 7);
        const ref = head.slice(4).trim();
        const loose = join(gitDir, ref);
        if (existsSync(loose)) return readFileSync(loose, 'utf8').trim().slice(0, 7);
        const packed = join(gitDir, 'packed-refs');
        if (existsSync(packed)) {
          for (const line of readFileSync(packed, 'utf8').split('\n')) {
            if (line.endsWith(` ${ref}`)) return line.slice(0, 7);
          }
        }
      } catch {
        // Unreadable .git — fall through to 'unknown' rather than fail the build.
      }
      break;
    }
    dir = join(dir, '..');
  }
  return 'unknown';
}

const BUILD_SHA = resolveSha();
const BUILD_TIME = new Date().toISOString();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server bundle so the runtime image needs no
  // node_modules. Required by apps/web/Dockerfile.
  output: 'standalone',
  // Shared packages ship TypeScript source rather than a build step
  transpilePackages: ['@tatvaos/core', '@tatvaos/types'],
  // Inlined into both the server and client bundles at build time, so the
  // running app can state which commit it came from (see components/BuildBadge).
  env: {
    NEXT_PUBLIC_BUILD_SHA: BUILD_SHA,
    NEXT_PUBLIC_BUILD_TIME: BUILD_TIME,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
