# Running the GridIQ website on Cloudflare

What runs where:

```
Browser ── https://app.<domain> ──▶ Cloudflare Worker "gridiq-web"  (apps/web, built from GitHub on every push)
                                       └── /api/* passed through ──▶ https://api.<domain>  (Cloudflare Tunnel)
                                                                        └── Caddy :8080 → gateway → auth / ingestion api
Meters ── mqtts://mqtt.<domain>:8883 ──▶ the GridIQ server (Mosquitto → ingest → TimescaleDB, jobs)
Files (report PDFs, data packages, exports) ──▶ R2 bucket "gridiq-files" (FILE_STORE=r2), private
```

- **Cloudflare:** the website, served from the edge and rebuilt from GitHub; file storage in R2.
- **The GridIQ server (Oracle VM, or this PC for testing):** everything that holds state or a long
  connection:
  - the MQTT broker (meters keep a TLS connection open, which Workers cannot accept);
  - ingest and the jobs;
  - TimescaleDB.
- **D1 is not used.** One meter at one reading per second writes about 2.6 million rows per 30 days.
  GridIQ depends on TimescaleDB's compression, continuous aggregates and range deletes. D1 is a
  size-limited SQLite database without these. A second database for the same records would also
  split the source of truth.
- **The browser stays on one address** (`app.<domain>`). The Worker forwards `/api/*` to the server,
  so the sign-in cookie (HttpOnly, SameSite=Strict) works as before.

## One-time setup (owner)

You need:
- **a Cloudflare account** (the free plan is enough to start);
- **a domain on Cloudflare** (registration is paid);
- **the GitHub repository** `vitaltrading09/JMC-Ventures`.

### 1. The API address: a named Cloudflare Tunnel from the server

The free quick tunnel (`trycloudflare.com`) changes address on every restart, so it cannot be the
API address. Create a named tunnel instead:

1. Zero Trust → Networks → Tunnels → **Create a tunnel** (Cloudflared) → name `gridiq-api`.
2. Copy the **tunnel token**. In the server's `.env`, set `TUNNEL_TOKEN=<token>`; never commit it.
   The compose service `tunnel` then needs the command `tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}`
   instead of the quick-tunnel URL. That change is not made yet: say so when you are ready.
3. Public hostname: `api.<domain>` → service `http://caddy:8080`.
4. MQTT for real meters still needs the server's own `mqtt.<domain>:8883` with a public IP: Cloudflare
   Tunnels do not carry MQTT from meters. A local PC therefore suits testing, not real meters.

### 2. The website: a Worker built from GitHub

1. Workers & Pages → **Create** → **Import a repository** → GitHub → authorise Cloudflare for
   `vitaltrading09/JMC-Ventures`.
2. Project name: `gridiq-web` (must match `apps/web/wrangler.jsonc`).
3. Build settings:

| Setting | Value |
|---|---|
| Root directory | `/` (the repository root: the npm lockfile and workspaces live there) |
| Build command | `npm run cf:build -w apps/web` |
| Deploy command | `cd apps/web && npx opennextjs-cloudflare deploy` |
| Non-production branch deploy command | `cd apps/web && npx opennextjs-cloudflare upload` (preview URL per branch) |
| Production branch | `main` |

4. Build variables (Settings → Build → Variables):

| Variable | Value | Why |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `/api` | the browser calls the API on its own address |
| `NODE_VERSION` | `22` | same Node as the Docker images |
| `NEXT_PUBLIC_FEATURE_TOOLS` | `false` | sizing tools stay off |

5. Runtime variable (Worker → Settings → Variables and Secrets): `API_ORIGIN` = `https://api.<domain>`.
   `apps/web/worker.ts` forwards `/api/*` there; `keep_vars` in `wrangler.jsonc` keeps it across deploys.
6. Custom domain: Worker → Settings → Domains & Routes → add `app.<domain>`.
7. On the server, set `FRONTEND_URL` to `https://app.<domain>`. Email links and sign-in codes point
   there; compose currently derives it from `APP_DOMAIN`, so set `APP_DOMAIN=app.<domain>`.

### 3. Files in R2

1. R2 → **Create bucket** `gridiq-files`, location hint Africa if offered, **no public access**.
2. R2 → Manage API tokens → **Create API token**: Object Read & Write, this bucket only.
3. In the server's `.env`:
   ```
   FILE_STORE=r2
   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   R2_BUCKET=gridiq-files
   R2_ACCESS_KEY_ID=<from the token>
   R2_SECRET_ACCESS_KEY=<from the token>
   ```
4. `docker compose up -d api jobs`. New report PDFs, packages and exports go to R2 under `uploads/…`
   and `exports/…`. They are streamed through the API after its access checks; the bucket is never
   public. Retention purges delete the objects too.
5. Files written before the switch stay on disk. Copy them into the bucket with the same keys
   (`uploads/report-pdfs/…`, `exports/packages/…`, `exports/<id>.csv.gz`) using the `awscli` tools
   service, or keep `FILE_STORE=local` until the next clean start.

Backups already go to R2 (`deploy/scripts/backup.sh`); use a separate bucket and token for them.

## Local checks

```bash
# Build exactly as Cloudflare does (Linux; the adapter warns that Windows is not fully supported):
NEXT_PUBLIC_API_URL=/api npm run cf:build -w apps/web
# Run the built Worker locally (wrangler dev), proxying /api to API_ORIGIN:
cd apps/web && npx wrangler dev --var API_ORIGIN:https://api.example.co.za
```

## Versions and limits

- **Adapter version:** `@opennextjs/cloudflare` 1.12.0 with Next.js 14.2.35. Newer adapter versions
  require Next.js 15.5 or later. Upgrading Next (and React 19) is a separate task, needed before
  taking adapter updates.
- **Worker size:** the free plan allows 3 MiB compressed per Worker, the paid plan 10 MiB. Check the
  size `wrangler deploy` reports.
- **What costs money:**
  - the domain;
  - Workers above the free request allowance;
  - R2 storage above the free tier (10 GB-month at the time of writing; check current pricing);
  - the GridIQ server itself.

## Verified (11 Nov 2026, Linux container)

Build succeeds; upload 1.0 MiB gzip. Worker serves /login (200), redirects /portal without a session, and forwards /api/* to the real stack (gateway health 200, email-code request 202, protected route 401 without a session, sign-in errors pass through).
