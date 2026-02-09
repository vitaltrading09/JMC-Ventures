# PowerGuard Project Walkthrough

## 1. Project Overview
PowerGuard is an enterprise energy management platform designed to help businesses monitor, analyze, and optimize their energy usage. It is built as a highly scalable microservices architecture.

## 2. Architecture
-   **Frontend**: Next.js (React) + Tailwind CSS (`apps/web`)
-   **Backend Services**:
    -   **Auth Service**: Handles user authentication (JWT) and tenant management (`services/auth-service`).
    -   **Ingestion Service**: Manages data collection from meters, processes it via Redis queues, and exposes a Data API (`services/ingestion-service`).
    -   **API Gateway**: Central entry point that routes requests and handles security (`services/api-gateway`).
-   **Infrastructure**:
    -   **PostgreSQL**: Primary database for users and relational data.
    -   **TimescaleDB** (or standard Postgres for MVP): Stores time-series meter readings.
    -   **Redis**: Message broker for the ingestion queue.
    -   **Docker**: Containerizes all services for easy deployment.

## 3. Key Features Implemented

### A. Authentication & User Management
-   **Secure Login**: `/login` page with JWT authentication and bcrypt password hashing.
-   **Tenant Isolation**: Data is logically separated by tenant ID.

### B. Real-Time Dashboard
-   **Overview**: High-level metrics (Total Load, Cost, Active Sites).
-   **Sites List**: Live view of all connected sites with real-time "Current Usage" (kW).
-   **Site Details**: Drill-down into specific meters to see:
    -   **Live Power**: Instantaneous power reading updates every 5s.
    -   **Power Profile**: Interactive chart of the last 24h/50 readings.
    -   **Technical Specs**: Live Voltage, Current, Frequency.

### C. Advanced Tools
-   **Savings Dashboard**: "Trust Center" showing verified savings vs. counterfactual baseline.
-   **PV Sizer**: Calculator for solar system sizing and ROI estimation.
-   **Data Import**: Drag-and-drop UI for uploading historical CSV data (Backend connection pending).

## 4. How to Resume Work (New Laptop)
1.  **Clone**: `git clone https://github.com/vitaltrading09/PowerGuard.git`
2.  **Install**: `npm install`
3.  **Start DB**: `docker-compose up -d`
4.  **Seed**: `npx ts-node scripts/seed.ts`
5.  **Run**: `npm run dev`

## 5. Next Steps (Roadmap)
-   **Phase 2**: Verify User Creation & Data Import.
-   **Phase 2.5**: Implement AI Consultant (Chatbot) for context-aware insights.
-   **Phase 3**: deploy to cloud.
