# PowerGuard Environment Setup Guide

To run the PowerGuard platform locally, you must install the following tools.

## 1. Node.js (Runtime)
-   **Why**: Runs the Backend services and Frontend application.
-   **Action**: You mentioned you just installed this.
-   **Verification**:
    1.  Restart your terminal (or Computer).
    2.  Run `node -v` (Should be v18+ or v20+).
    3.  Run `npm -v` (Should be v9+ or v10+).

## 2. Docker Desktop (Database in Containers)
-   **Why**: We use **Docker** to run the databases (PostgreSQL/TimescaleDB) and Redis without complicated Windows installation steps. It keeps your system clean and matches production.
-   **Action**:
    1.  Download **Docker Desktop for Windows** from [docker.com](https://www.docker.com/products/docker-desktop/).
    2.  Install it.
    3.  **Important**: Start "Docker Desktop" application and let it run in the background.
-   **Verification**:
    -   Run `docker -v` in terminal (Should show version, e.g., `Docker version 24...`).

## 3. Git (Version Control)
-   **Why**: Required to manage source code and (optionally) for some npm packages.
-   **Action**: Download from [git-scm.com](https://git-scm.com/download/win) if not already installed.
-   **Verification**:
    -   Run `git --version`.

---

## Next Steps (Once Installed)

1.  **Restart Terminal**: Close and reopen your terminal/VS Code to refresh PATH variables.
2.  **Verify**: Run `node -v` and `docker -v`.
3.  **Install Dependencies**: I will then run `npm install` to set up the project.
4.  **Start Databases**: I will run `docker-compose up -d` to start the database systems.
