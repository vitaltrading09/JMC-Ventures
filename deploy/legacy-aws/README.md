# Legacy AWS runtime (old box only)

These files run Grid-IQ on the old AWS EC2 box: systemd units plus
`npx tsx`, with only the database and Mosquitto in Docker. They are kept
**only until that box is decommissioned** (plan Part D11). Nothing new
should use them; the new run model is the root `docker-compose.yml` and
`deploy/deploy.sh`.

| File | Was |
|---|---|
| `start.sh` | `start.sh` (nohup mode) |
| `systemd/*.service` | `deploy/systemd/` |
| `scripts/{install,uninstall,healthcheck,status,logs,redeploy}.sh` | `deploy/scripts/` |
| `docker-compose.legacy.yml` | the pre-Phase-1 root `docker-compose.yml` |
| `mosquitto.conf` | the pre-Phase-1 `mosquitto/config/mosquitto.conf` (plain 1883 + websockets 9001) |

## Before pulling a newer `main` onto the AWS box

Prefer not to: the box is being retired, so leave it on the commit it runs.
If you must pull:

1. The root `docker-compose.yml` and `mosquitto/config/mosquitto.conf` are now
   the new TLS stack. **Do not run plain `docker compose up` on this box.** Use
   the legacy file, from the repo root, so the project name and `db_data`
   volume stay the same:
   ```bash
   sudo docker compose --project-directory . -f deploy/legacy-aws/docker-compose.legacy.yml up -d
   ```
   This also recreates `powerguard-mqtt` with the pinned legacy
   `mosquitto.conf`. Without it, the next restart of the existing container
   reads the new TLS-only config and fails, so the meters stop reporting.
2. The ingestion service now stores uploads in `UPLOAD_DIR` (default
   `/data/uploads`). Add this line to `services/ingestion-service/.env`, or uploads
   fail and startup can crash:
   ```
   UPLOAD_DIR=<repo checkout>/services/ingestion-service/uploads
   ```
3. Scripts were moved: use `deploy/legacy-aws/scripts/*.sh` instead of
   `deploy/scripts/*.sh`. The installed systemd units are unchanged copies.
