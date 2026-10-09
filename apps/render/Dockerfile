# ============================================================================
#  The render service: builds a Docs or Sheets file from what the server stored
# ============================================================================
#
#  Decision 0011 condition 1; docs/DOCS_SERVER_RENDER_DESIGN.md §§12-14 and
#  docs/SHEETS_SERVER_RENDER_DESIGN.md. Built from the REPO ROOT, because it
#  runs the editors' OWN code — no copy of it: the Docs schema
#  (apps/web/components/docs/schema.ts + extensions.ts) and the Sheets
#  library (apps/web/lib/sheets, which imports nothing but yjs):
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
#
#  THE BASE IMAGE IS PINNED BY DIGEST (Mr. Singh, 1 Oct 2026). `node:24-alpine`
#  is a moving tag: two builds a week apart can run different Node and Alpine
#  under the same Dockerfile, and nothing would say so. Both stages name the
#  same digest — the multi-platform index, so it resolves on any architecture.
#  Pinned 1 Oct 2026: node:24-alpine = Node v24.21.0.
#
#  To update it, in ONE commit that touches nothing else:
#    1. docker pull node:24-alpine
#    2. docker inspect --format '{{index .RepoDigests 0}}' node:24-alpine
#       and `docker run --rm node:24-alpine node --version` (still 24.x?)
#    3. replace the digest in BOTH FROM lines below, and the date and version
#       above
#    4. run tests/docs-render/container-test.sh (all checks pass, red first)
#       and apps/render's own tests before it merges
# ============================================================================

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/render/package.json apps/render/
# Dependencies from the LOCKFILE, at build time, never at start (Mr. Singh,
# 29 Sept 2026). Frozen: an install that does not match the lockfile fails
# the build rather than quietly picking other versions (see apps/web/Dockerfile).
RUN pnpm install --frozen-lockfile --prod --filter @tatvaos/render

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app
# TZ: TODAY() and NOW() in a spreadsheet read the process's time zone. India
# time (Amit, 2 Oct 2026), so a save at 00:30 in India stores that day, not the
# day before as UTC would. Node carries its own time-zone data (ICU), so
# Alpine needs no tzdata; tests/docs-render/container-test.sh proves it.
ENV NODE_ENV=production PORT=8080 TZ=Asia/Kolkata
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/render/node_modules ./apps/render/node_modules
# The PDF engine and its fonts (decision 0011 condition 2, docs/DOCS_PDF_DESIGN.md).
# From Alpine 3.24's own signed repository — the pinned base image's — at
# exact versions (Mr. Singh's condition 3, 1 Oct 2026: Alpine's package first,
# pinned with the image; nothing from GitHub). Fonts are OFL / open licences:
# Liberation is metric-compatible with Arial / Times / Courier (Amit's ruling);
# Noto covers the Indian scripts.
# vips-tools (vipsthumbnail): every picture is shrunk and stripped of ALL
# metadata before Typst sees it (Mr. Singh's ruling of 9 Oct 2026; render-
# pdf.mjs "PICTURES ARE SHRUNK"). From the same signed repository, pinned the
# same way. Only the core package: no vips-magick, vips-poppler or vips-heif,
# so libvips here cannot open anything but ordinary picture formats.
RUN apk add --no-cache \
      typst=0.14.2-r0 \
      vips-tools=8.18.2-r0 \
      font-liberation=2.1.5-r2 font-dejavu=2.37-r6 font-noto=2026.06.01-r0 \
      font-noto-devanagari=2026.06.01-r0 font-noto-bengali=2026.06.01-r0 \
      font-noto-tamil=2026.06.01-r0 font-noto-telugu=2026.06.01-r0 \
      font-noto-gujarati=2026.06.01-r0 font-noto-kannada=2026.06.01-r0 \
      font-noto-malayalam=2026.06.01-r0 font-noto-gurmukhi=2026.06.01-r0 \
      font-noto-oriya=2026.06.01-r0 font-noto-emoji=2.051-r0
COPY apps/render/package.json ./apps/render/
COPY apps/render/src ./apps/render/src
COPY apps/render/pdf ./apps/render/pdf
COPY apps/web/components/docs/schema.ts apps/web/components/docs/extensions.ts ./apps/web/components/docs/
COPY apps/web/lib/sheets ./apps/web/lib/sheets
# Everything above is owned by root and the container runs as `node`
# (uid 1000) on a read-only filesystem: the service can read its code and
# write nothing but /tmp (a small tmpfs from compose).
USER node
WORKDIR /app/apps/render
EXPOSE 8080
CMD ["node", "--import", "./src/register.mjs", "src/server.mjs"]
