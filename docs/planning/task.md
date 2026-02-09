# PowerGuard Project Tasks

- [x] **Phase 0: Planning & Architecture**
    - [x] Design System Architecture (Microservices, Tech Stack)
    - [x] Design Database Schema (Multi-tenant, Time-series, Relational)
    - [x] Define API Contracts (OpenAPI/Swagger)
- [x] **Phase 1: Environment Setup & MVP Core**
    - [x] **[CRITICAL] Install Prerequisites (Node.js, Docker, Git)** <!-- id: 18 -->
    - [x] Setup Monorepo Structure
    - [x] Implement User/Tentant Management Service (Auth, RBAC)
    - [x] Implement Data Ingestion Service (Acuvim Cloud API)
    - [x] Setup Databases (PostgreSQL + TimescaleDB/InfluxDB)
    - [x] **Build Enterprise Dashboard (Client View)**
        - [x] Create App Layout (Sidebar, Header, Dark Mode)
        - [x] Implement Overview Dashboard (Widgets, Charts)
        - [x] Implement Sites List & Map View
        - [x] Implement Site Details Drill-down
        - [x] Implement Settings & Analytics Pages
- [x] **Phase 1.5: Enterprise UI & Tools (MVP Polished)**
    - [x] **Implement Login Page** (Professional, Secure feel)
    - [x] **Implement Savings Dashboard** (10% Model Visualization, Counterfactuals)
    - [x] **Implement PV Sizer Tool** (Calculator & ROI)
    - [x] **Implement Data Import UI** (CSV Upload)
    - [x] **Refine Settings** (Profile, Notifications, Data Management)

- [/] **Phase 2: Backend Integration & Verification**
    - [x] **Harden API Gateway** (Rate Limiting, Helmet, Security Headers)
    - [x] **Implement Scalable Ingestion** (Redis Queues/BullMQ)
    - [x] **Expose Data API** (GET /meters endpoints via Ingestion Svc)
    - [x] **Connect Live Data** (Sites List & Detail Views)
    - [ ] **Verify User Management** 
        - [ ] Test "Create User" flow (Admin/Signup) & persist to DB.
        - [ ] Verify Login for new users.
    - [ ] **Verify Data Import**
        - [ ] Connect CSV Upload UI to Backend.
        - [ ] Parse and store CSV data in `meter_readings`.
        - [ ] Visualize imported data.
    - [ ] **Chart Polish (Business Value)**
        - [ ] Refine "Power Profile" for actionable insights (peaks, costs).
        - [ ] Add interactive tooltips and zoom.

- [ ] **Phase 2.5: AI Consultant (Secure Chatbot)**
    - [ ] **Setup AI Service** (OpenAI/Gemini API integration).
    - [ ] **Context-Aware Security** 
        - [ ] Ensure AI only accesses data for the logged-in Tenant.
    - [ ] **Implement Chat Interface**
        - [ ] Chat window/widget in Dashboard.
    - [ ] **Smart Capabilities (RAG/Tool Use)**
        - [ ] Ability to query: "What is my current load?"
        - [ ] Ability to analyze: "Any abnormalities today?"
        - [ ] Ability to suggest: "How can I save money right now?"

- [ ] **Phase 3: Deployment & Cloud Access**
    - [x] **Source Control**: Push code to GitHub (for cross-laptop access).
    - [ ] **Cloud Hosting**: Deploy App & Database (e.g., VPS or Vercel+Neon).
    - [ ] **CI/CD**: Automate updates.

- [ ] **Phase 4: Energy Wheeling & Marketplace (Future)**
    - [ ] Implement Wheeling Engine (Transfers, Tariffs, Losses)
    - [ ] Implement Marketplace Engine (Bidding, Matching)
