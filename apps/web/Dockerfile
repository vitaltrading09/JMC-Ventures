# syntax=docker/dockerfile:1
# Next.js web app (standalone output). Build context is the repo root:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://app.example.com/api .
# NEXT_PUBLIC_API_URL is baked into the client bundle at build time, so it is
# a build arg, not a runtime env var. Changing it means rebuilding the image.
ARG NODE_IMAGE=node:22.21.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY services/auth-service/package.json services/auth-service/
COPY services/api-gateway/package.json services/api-gateway/
COPY services/ingestion-service/package.json services/ingestion-service/
COPY packages/db/package.json packages/db/
RUN npm ci -w apps/web --include-workspace-root=false --no-audit --no-fund
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL
# Shown on the Add Meter screen as the broker host meters connect to.
ARG NEXT_PUBLIC_MQTT_HOST
# The broker portfolio pages (/broker) are hidden unless "true".
ARG NEXT_PUBLIC_FEATURE_BROKER=false
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_MQTT_HOST=${NEXT_PUBLIC_MQTT_HOST} \
    NEXT_PUBLIC_FEATURE_BROKER=${NEXT_PUBLIC_FEATURE_BROKER} \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
