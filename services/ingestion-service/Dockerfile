# syntax=docker/dockerfile:1
# Ingestion service: one image, three roles (ROLES=api | ingest | jobs) plus
# the one-shot migrate step. Build context is the repo root:
#   docker build -f services/ingestion-service/Dockerfile .
ARG NODE_IMAGE=node:22.21.1-bookworm-slim

# ── Workspace manifests only, so dependency layers cache across code edits ──
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY services/auth-service/package.json services/auth-service/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/ingestion-service/package.json services/ingestion-service/

# ── Production dependencies ────────────────────────────────────────────────
FROM manifests AS deps
RUN npm ci -w services/ingestion-service --include-workspace-root=false --omit=dev --no-audit --no-fund \
    && mkdir -p services/ingestion-service/node_modules

# ── Compile TypeScript ─────────────────────────────────────────────────────
FROM manifests AS build
RUN npm ci -w services/ingestion-service --include-workspace-root=false --no-audit --no-fund
COPY services/ingestion-service/tsconfig.json services/ingestion-service/
COPY services/ingestion-service/src services/ingestion-service/src
RUN npm run build -w services/ingestion-service

# ── Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    UPLOAD_DIR=/data/uploads \
    PORT=3002 \
    HEALTH_PORT=9090
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/services/ingestion-service/node_modules ./services/ingestion-service/node_modules
COPY --chown=node:node services/ingestion-service/package.json ./services/ingestion-service/
COPY --from=build --chown=node:node /app/services/ingestion-service/dist ./services/ingestion-service/dist
# Base schema for the interim migrate step (dist/migrate.js resolves ../../../init.sql)
COPY --chown=node:node init.sql ./init.sql
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
WORKDIR /app/services/ingestion-service
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
    CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
