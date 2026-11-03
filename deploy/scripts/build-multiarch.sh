#!/usr/bin/env bash
# Build every Grid-IQ image for linux/arm64 (Oracle A1) and linux/amd64.
#
#   bash deploy/scripts/build-multiarch.sh                 # build only (verifies both platforms)
#   REGISTRY=ghcr.io/org PUSH=1 bash deploy/scripts/build-multiarch.sh   # build and push
#
# Uses a docker-container buildx builder (created once as "gridiq-multiarch"),
# which can build foreign platforms through QEMU. On the ARM server itself,
# plain `docker compose build` builds native arm64 images.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

PLATFORMS="${PLATFORMS:-linux/arm64,linux/amd64}"
TAG="${IMAGE_TAG:-local}"
PREFIX="${REGISTRY:+$REGISTRY/}gridiq"
BUILDER=gridiq-multiarch

env_value() {
    [ -f .env ] || return 0
    grep -E "^${1}=" .env | tail -n1 | cut -d= -f2-
}
APP_DOMAIN="${APP_DOMAIN:-$(env_value APP_DOMAIN)}"
APP_DOMAIN="${APP_DOMAIN:-localhost}"

docker buildx inspect "$BUILDER" >/dev/null 2>&1 \
    || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
docker buildx inspect "$BUILDER" --bootstrap >/dev/null

if [ -n "${PUSH:-}" ]; then
    [ -n "${REGISTRY:-}" ] || { echo "PUSH=1 needs REGISTRY" >&2; exit 1; }
    OUTPUT=(--push)
else
    # Build result stays in the builder cache; nothing is pushed or loaded.
    OUTPUT=(--output type=cacheonly)
fi

build() { # name dockerfile [extra args...]
    local name="$1" dockerfile="$2"; shift 2
    echo "==> $PREFIX/$name:$TAG  [$PLATFORMS]"
    docker buildx build --builder "$BUILDER" --platform "$PLATFORMS" \
        -f "$dockerfile" -t "$PREFIX/$name:$TAG" "${OUTPUT[@]}" "$@" .
}

build ingestion-service services/ingestion-service/Dockerfile
build auth-service      services/auth-service/Dockerfile
build api-gateway       services/api-gateway/Dockerfile
build web               apps/web/Dockerfile --build-arg "NEXT_PUBLIC_API_URL=https://$APP_DOMAIN/api"

echo "All images built for $PLATFORMS."
