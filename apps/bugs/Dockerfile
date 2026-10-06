# TatvaOS Bugs — no npm install, no build step: Node 24's built-ins only.
FROM node:24-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
