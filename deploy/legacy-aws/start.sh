#!/bin/bash
# ============================================================
# Grid-IQ Production Startup Script
# LEGACY AWS BOX ONLY. Run from the repo root: bash deploy/legacy-aws/start.sh
# ============================================================

echo "🔄 Stopping any existing Node processes..."
pkill -f "tsx" 2>/dev/null || true
pkill -f "next" 2>/dev/null || true
sleep 2

echo "🗄️  Making sure Docker services are running (TimescaleDB, Redis, Mosquitto)..."
sudo docker compose --project-directory . -f deploy/legacy-aws/docker-compose.legacy.yml up -d
sleep 5

echo "🚀 Starting Auth Service on port 3001..."
nohup npx tsx services/auth-service/src/main.ts > /tmp/auth.log 2>&1 &
sleep 2
echo "Auth Service PID: $!"

echo "🚀 Starting Ingestion Service on port 3002..."
nohup npx tsx services/ingestion-service/src/main.ts > /tmp/ingestion.log 2>&1 &
sleep 2
echo "Ingestion Service PID: $!"

echo "🚀 Starting API Gateway on port 8081..."
FRONTEND_URL="http://35.179.107.189:3000" \
  AUTH_SERVICE_URL="http://localhost:3001" \
  INGESTION_SERVICE_URL="http://localhost:3002" \
  nohup npx tsx services/api-gateway/src/main.ts > /tmp/gateway.log 2>&1 &
sleep 3
echo "API Gateway PID: $!"

echo "📦 Building Next.js frontend..."
cd apps/web
npm run build

echo "🌐 Starting Next.js on port 3000..."
nohup npm run start > /tmp/web.log 2>&1 &
echo "Frontend PID: $!"

cd ../..

echo ""
echo "============================================================"
echo "✅ Grid-IQ is LIVE!"
echo "   Dashboard:  http://35.179.107.189:3000"
echo "   API:        http://35.179.107.189:8081/health"
echo "============================================================"
echo ""
echo "Tip: Run 'cat /tmp/auth.log' to check the auth service logs."
