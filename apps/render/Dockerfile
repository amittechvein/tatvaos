# ============================================================================
#  The render service: builds a Docs file from what the server stored
# ============================================================================
#
#  Decision 0011 condition 1; docs/DOCS_SERVER_RENDER_DESIGN.md §§12-14.
#  Built from the REPO ROOT, because it runs the editor's OWN schema
#  (apps/web/components/docs/schema.ts + extensions.ts) — no copy of it:
#
#    docker build -f apps/render/Dockerfile .
#
#  Hardening lives in the compose service (read-only, non-root, no
#  capabilities, internal network only, limits — Mr. Singh, 29-30 Sept 2026)
#  and is PROVEN by tests/docs-render/container-test.sh, red first.
#
#  Node 24: the service loads the schema's TypeScript directly (Node strips
#  the types) and uses module.registerHooks — both Node 24 (the web image's
#  Node 22 has neither by default).
# ============================================================================

FROM node:24-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/render/package.json apps/render/
# Dependencies from the LOCKFILE, at build time, never at start (Mr. Singh,
# 29 Sept 2026). Frozen: an install that does not match the lockfile fails
# the build rather than quietly picking other versions (see apps/web/Dockerfile).
RUN pnpm install --frozen-lockfile --prod --filter @tatvaos/render

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/render/node_modules ./apps/render/node_modules
COPY apps/render/package.json ./apps/render/
COPY apps/render/src ./apps/render/src
COPY apps/web/components/docs/schema.ts apps/web/components/docs/extensions.ts ./apps/web/components/docs/
# Everything above is owned by root and the container runs as `node`
# (uid 1000) on a read-only filesystem: the service can read its code and
# write nothing but /tmp (a small tmpfs from compose).
USER node
WORKDIR /app/apps/render
EXPOSE 8080
CMD ["node", "--import", "./src/register.mjs", "src/server.mjs"]
