# syntax=docker/dockerfile:1
# API gateway. Build context is the repo root:
#   docker build -f services/api-gateway/Dockerfile .
ARG NODE_IMAGE=node:22.21.1-bookworm-slim

# ── Workspace manifests only, so dependency layers cache across code edits ──
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY services/auth-service/package.json services/auth-service/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/ingestion-service/package.json services/ingestion-service/
COPY packages/db/package.json packages/db/

# ── Production dependencies ────────────────────────────────────────────────
FROM manifests AS deps
RUN npm ci -w services/api-gateway --include-workspace-root=false --omit=dev --no-audit --no-fund \
    && mkdir -p services/api-gateway/node_modules

# ── Compile TypeScript ─────────────────────────────────────────────────────
FROM manifests AS build
RUN npm ci -w services/api-gateway --include-workspace-root=false --no-audit --no-fund
COPY services/api-gateway/tsconfig.json services/api-gateway/
COPY services/api-gateway/src services/api-gateway/src
RUN npm run build -w services/api-gateway

# ── Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8081
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/services/api-gateway/node_modules ./services/api-gateway/node_modules
COPY --chown=node:node services/api-gateway/package.json ./services/api-gateway/
COPY --from=build --chown=node:node /app/services/api-gateway/dist ./services/api-gateway/dist
USER node
WORKDIR /app/services/api-gateway
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
