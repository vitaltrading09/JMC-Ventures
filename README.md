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
Create a `.env` file in the root directory:
```bash
# Database Configuration
DATABASE_URL="postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db"
POSTGRES_USER="powerguard_user"
POSTGRES_PASSWORD="powerguard_password"
POSTGRES_DB="powerguard_db"

# JWT Secrets
JWT_SECRET="powerguard-super-secret-key-change-in-prod"

# Service Ports
PORT_API_GATEWAY=8081
PORT_AUTH_SERVICE=3001
PORT_INGESTION_SERVICE=3002

# Redis
REDIS_HOST="localhost"
REDIS_PORT=6379
```

### 5. Start Infrastructure (Databases)
Make sure Docker Desktop is running, then start the database containers:
```bash
docker-compose up -d
```
*Wait ~10 seconds for the database to be ready.*

### 6. Seed the Database
Populate the database with initial users and meter data:
```bash
npx ts-node scripts/seed.ts
```
*(User: `demo@powerguard.com` / Password: `demo123`)*

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
