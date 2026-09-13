# Built from the REPO ROOT so the shared packages/ are available:
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/
COPY packages ./packages
# No `|| pnpm install` fallback. Falling back to an unfrozen install when the
# lockfile does not match means the image can be built with dependency
# versions CI never tested - and it does so silently, which is the worst part.
# If this line fails, the lockfile is genuinely out of date and needs
# committing, not working around.
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY . .
# The commit this image is built from. .git is (rightly) excluded from the
# build context by the root .dockerignore, so next.config.ts cannot read it;
# the deploy hands the SHA in. Empty means the page badge says "unknown" -
# a missing stamp must never be the thing that fails a production build.
ARG BUILD_SHA=
ENV BUILD_SHA=$BUILD_SHA
RUN pnpm --filter @tatvaos/web build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 10001 nodejs && adduser -u 10001 -G nodejs -D nextjs

COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# ---------------------------------------------------------------------------
#  THE BUILD STAMP, IN THE RUNTIME STAGE TOO.
#
#  The ARG/ENV pair above sits in the `build` stage, which is where Next needs
#  the value. Environment does not cross a FROM boundary, so until 13 Sept 2026
#  this runtime image never carried BUILD_SHA at all: the commit was inlined
#  into the page and the server bundle, but absent from `docker inspect`.
#
#  infra/scripts/deploy.sh reads the container environment twice - the
#  rollback printer at the top, and the "Confirming the running build" check
#  before the verdict. So the printer never printed, and the check went red on
#  its FIRST EVER RUN (deploy of 6f0ded8, 12 Sept 2026, run 34716535090) over a
#  deploy that had in fact landed: containers recreated thirty seconds after
#  the pre-deploy backup, production serving 6f0ded8, the new migration in the
#  database. The red was read as "containers not replaced" and written into a
#  review. The cause was this stage boundary, not a stale container.
#
#  Declared again here so the value the deploy passed is the value the running
#  container answers with. Empty stays empty: a missing stamp is still never a
#  build failure.
# ---------------------------------------------------------------------------
ARG BUILD_SHA=
ENV BUILD_SHA=$BUILD_SHA
CMD ["node", "apps/web/server.js"]
