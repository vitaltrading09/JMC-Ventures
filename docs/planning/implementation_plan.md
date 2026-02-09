# PowerGuard Implementation Plan

# Goal Description
Build a robust, scalable, enterprise-grade energy management platform (PowerGuard) with a highly aesthetic UI, secure backend, and AI-driven insights.

## User Review Required
> [!IMPORTANT]
> **AI Security**: The AI Chatbot will be designed with strict "Tenant Isolation". It will not be trained on user data but will function as a RAG (Retrieval-Augmented Generation) system, fetching *only* the specific user's data context at runtime to answer questions.

> [!NOTE]
> **Deployment**: To access the code from another laptop, we will use **GitHub**. To allow clients to access the app, we will use **Cloud Hosting** (Docker/VPS recommended for control).

## Proposed Changes

### Phase 2: Backend Integration & Verification
#### [MODIFY] User Management
- Implement `POST /users` endpoint in `auth-service` (Admin only).
- Verify database persistence and password hashing.
#### [MODIFY] Data Import
- Connect the frontend "Drag & Drop" CSV area to `POST /ingestion/upload`.
- Implement CSV parsing logic in `ingestion-service` (using `csv-parser` or `papaparse`).
- Store historical data in `meter_readings` table.

### Phase 2.5: AI Consultant (Chatbot)
#### [NEW] AI Service (`services/ai-service`)
- **Technology**: Node.js + LangChain or Vercel AI SDK.
- **Model**: OpenAI GPT-4o or Gemini Pro via API.
- **Architecture**:
    1.  **System Prompt**: "You are PowerGuard AI, an expert energy consultant..."
    2.  **Context Injection**: On every message, inject the User's Profile (Site Name, Tariff, Location).
    3.  **Tools**: Give the AI functions it can call:
        - `get_live_load(site_id)`
        - `get_daily_cost(site_id)`
        - `check_anomalies(site_id, date)`
- **Security**: The AI Service will require a valid JWT from the request to fetch data, ensuring it never sees data from other tenants.

### Phase 3: Deployment
#### [NEW] GitHub Repository
- Initialize git, create `.gitignore`, push to private repo.
- Clone on second laptop to continue development.
#### [NEW] Production Infrastructure
- **Database**: Managed PostgreSQL (e.g., AWS RDS, Supabase, or Neon).
- **Backend**: Docker Containers on a VPS (DigitalOcean/Hetzner) or Cloud Run (GCP).
- **Frontend**: Vercel or Netlify (for speed and global CDN).

## Verification Plan
### Automated Tests
- `npm run test` (Unit tests for parsing logic).
- API integration tests for `POST /users` and `POST /upload`.

### Manual Verification
- **User Flow**: Create a new user -> Log out -> Log in as new user -> Verify access.
- **Import Flow**: Upload "old_data.csv" -> Check Charts -> Verify history appears.
- **AI Flow**: Ask "What is my peak load today?" -> Verify AI answers correctly matching the chart.
