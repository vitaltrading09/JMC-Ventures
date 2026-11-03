# PowerGuard Platform ⚡

Enterprise-grade Energy Management & Trading Platform.

## 🚀 Getting Started on a New Machine

Follow these steps to set up the development environment from scratch.

### 1. Prerequisites
Ensure the following tools are installed:
-   **Node.js (v18+)**: [Download](https://nodejs.org/)
-   **Docker Desktop**: [Download](https://www.docker.com/products/docker-desktop/) (Must be running!)
-   **Git**: [Download](https://git-scm.com/downloads)
-   **VS Code**: [Download](https://code.visualstudio.com/) (Recommended)

### 2. Clone the Repository
Open your terminal (PowerShell or Command Prompt) and run:
```bash
git clone https://github.com/vitaltrading09/PowerGuard.git
cd PowerGuard
```

### 3. Install Dependencies
Install all project dependencies (Frontend + Backend services):
```bash
npm install
```

### 4. Setup Environment Variables
Every variable is documented in `.env.example` at the repo root. Copy it and
fill in real values (generate secrets with `openssl rand -hex 32`):
```bash
cp .env.example .env
cp .env.example services/auth-service/.env
cp .env.example services/ingestion-service/.env
cp .env.example services/api-gateway/.env
echo "NEXT_PUBLIC_API_URL=http://localhost:8081" > apps/web/.env.local
```
Services refuse to start without `DATABASE_URL` and a 32+ character `JWT_SECRET`.
`JWT_SECRET` must be identical in every service.

### 5. Start Infrastructure (Databases)
Make sure Docker Desktop is running, then start the database containers:
```bash
docker-compose up -d
```
*Wait ~10 seconds for the database to be ready.*

### 6. Seed the Database
Populate the database with initial users and meter data:
```bash
ALLOW_DEMO_SEED=true DEMO_USER_PASSWORD='<choose-a-local-password>' \
  DATABASE_URL="<your DATABASE_URL>" npx tsx services/auth-service/src/seed.ts
```
*(Local dev only. Creates `demo@grid-iq.co.za` with the password you chose.
The seed scripts refuse to run unless `ALLOW_DEMO_SEED=true`.)*

### 7. Run the Application
Start all services and the frontend in development mode:
```bash
npm run dev
```

### 8. Access the App
Open your browser and navigate to:
-   **Frontend**: [http://localhost:3000](http://localhost:3000)
-   **API Gateway**: [http://localhost:8081](http://localhost:8081)

## 📁 Project Structure
-   `apps/web`: Next.js Frontend (Dashboard UI)
-   `services/auth-service`: Authentication API (Express + Passport/JWT)
-   `services/ingestion-service`: Data Ingestion API (Express + BullMQ)
-   `services/api-gateway`: Central Entry Point (Express Proxy)
-   `scripts`: Database seeding and utility scripts
