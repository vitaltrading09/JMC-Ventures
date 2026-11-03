# syntax=docker/dockerfile:1
# Auth service. Build context is the repo root:
#   docker build -f services/auth-service/Dockerfile .
ARG NODE_IMAGE=node:22.21.1-bookworm-slim

# ── Workspace manifests only, so dependency layers cache across code edits ──
FROM ${NODE_IMAGE} AS manifests
# bcrypt is native: prebuilt binaries cover amd64/arm64, the toolchain is the
# fallback when a prebuild is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY services/auth-service/package.json services/auth-service/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/ingestion-service/package.json services/ingestion-service/

# ── Production dependencies ────────────────────────────────────────────────
FROM manifests AS deps
RUN npm ci -w services/auth-service --include-workspace-root=false --omit=dev --no-audit --no-fund \
    && mkdir -p services/auth-service/node_modules

# ── Compile TypeScript ─────────────────────────────────────────────────────
FROM manifests AS build
RUN npm ci -w services/auth-service --include-workspace-root=false --no-audit --no-fund
COPY services/auth-service/tsconfig.json services/auth-service/
COPY services/auth-service/src services/auth-service/src
RUN npm run build -w services/auth-service

# ── Runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/services/auth-service/node_modules ./services/auth-service/node_modules
COPY --chown=node:node services/auth-service/package.json ./services/auth-service/
COPY --from=build --chown=node:node /app/services/auth-service/dist ./services/auth-service/dist
USER node
WORKDIR /app/services/auth-service
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
