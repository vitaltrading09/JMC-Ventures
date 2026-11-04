# Grid-IQ runbook

The production server is the Oracle VM. The repo is at `/opt/gridiq`, and data lives in `/data` (`DATA_DIR`). Run every command from `/opt/gridiq` unless noted. `docker compose` reads `.env` from there.

| Where | What |
|---|---|
| `bash deploy/status.sh` | state and health of every service |
| `curl -H "x-health-token: $HEALTH_TOKEN" https://app.<domain>/api/health/deep` | the external monitor's view |
| `/var/log/gridiq/*.log` | backup, restore drill, cert sync, prune (from cron) |
| `${DATA_DIR}/backups/backup.log`, `last-success`, `last-drill` | backup status |

## Deploy
```bash
bash deploy/deploy.sh
```
- **Steps:** `git pull --ff-only`, then build images tagged with the commit (`IMAGE_TAG` in `.env`; the previous tag is saved to `.deploy/previous-tag`), then the `migrate` one-shot, then `up -d`, MQTT cert sync, and the health summary.
- **What migrate does:** applies pending migrations in one transaction, updates the TimescaleDB extension if the image is newer, and applies `MAX_BACKFILL_DAYS` / `COMPRESS_AFTER_DAYS` to the database policies. Services refuse to start while either is out of date.
- **Before a deploy that carries a migration,** take a backup first: `bash deploy/scripts/backup.sh`. It's your rollback for the schema.
- **Check afterwards:** `bash deploy/status.sh` shows everything healthy, and `/api/health/deep` returns 200.

## Roll back
```bash
bash deploy/rollback.sh            # to the previous image tag
bash deploy/rollback.sh <tag>      # or a specific one: docker images gridiq/web
```
- This swaps only the app containers, with no rebuild and no migrate.
- Migrations are forward-only. Older code tolerates a newer schema: it logs "Database has N migration(s) newer than this build" and runs.
- If the release you're leaving made a change the old code cannot live with, restore the pre-deploy backup (below) instead.

## Backups and restore
- **Schedule:** daily at 02:00 SAST (`deploy/scripts/backup.sh`).
- **Where:** Cloudflare R2, bucket `BACKUP_S3_BUCKET`, endpoint `https://<account_id>.r2.cloudflarestorage.com`, region `auto`. The R2 API token has Object Read & Write on that bucket only.
- **What happens:** pg_dump, then a `pg_restore --list` check, then encryption with age to `BACKUP_AGE_RECIPIENT`, then the upload of `gridiq-<time>.dump.age` to `s3://$BACKUP_S3_BUCKET/$BACKUP_PREFIX/daily/`. Sunday's backup is also copied to `weekly/`, and the 1st's to `monthly/`. Nothing unencrypted leaves the server; `backup.sh` refuses to run without a recipient.
- **Retention:** 7 daily, 4 weekly, 6 monthly.
- **Drill:** every Sunday at 04:00, `deploy/scripts/restore-drill.sh` decrypts the newest backup with `BACKUP_AGE_IDENTITY_FILE`, restores it into a throwaway container and compares row counts and policy jobs with live. A drill failure exits non-zero and is logged.

### Backup key (once per server)
The private key lives in two places: on the server (root only, for the drill) and offline. **Without it no backup can be restored.** Losing the server does not lose the key, as long as the offline copy exists.
```bash
sudo install -d -m 700 /etc/gridiq
docker compose --profile tools build age
docker compose run --rm --no-deps --entrypoint age-keygen age > /tmp/backup-age.key   # prints the public key on stderr
sudo install -m 600 -o root /tmp/backup-age.key /etc/gridiq/backup-age.key && shred -u /tmp/backup-age.key
sudo grep '^# public key:' /etc/gridiq/backup-age.key   # → BACKUP_AGE_RECIPIENT=age1... in .env
```
Offline copy: print `/etc/gridiq/backup-age.key` (or copy it to two USB keys) and store it away from the server, e.g. a safe at the office plus a password manager entry. Check it once by decrypting a backup on another machine (`age -d -i <key> -o test.dump <file>.dump.age`).

Rotating the key: generate a new one as above and change `BACKUP_AGE_RECIPIENT`. Keep the old private key (server and offline) until the last backup made with it has aged out of the monthly tier (6 months).

**Restore for real** (e.g. new server, or a bad migration):
```bash
# 1. Stop the app (keep the DB running)
docker compose stop api ingest jobs auth gateway web
# 2. Fetch the backup you want
docker compose run --rm --no-deps awscli --endpoint-url "$BACKUP_S3_ENDPOINT" s3 ls "s3://$BACKUP_S3_BUCKET/$BACKUP_PREFIX/daily/"
docker compose run --rm --no-deps awscli --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp "s3://$BACKUP_S3_BUCKET/$BACKUP_PREFIX/daily/<file>.dump.age" /backups/restore.dump.age
#    and decrypt it (on a new server: put the offline key at /etc/gridiq/backup-age.key first)
sudo docker compose run --rm --no-deps -v /etc/gridiq:/keys:ro age -d -i /keys/backup-age.key -o /backups/restore.dump /backups/restore.dump.age
# 3. Restore into an EMPTY database. Move the current data aside first, never delete it:
docker compose stop timescaledb && sudo mv /data/pg /data/pg.before-restore-$(date +%F)
docker compose up -d --wait timescaledb
bash deploy/scripts/restore-dump.sh /data/backups/restore.dump <timescaledb version of the dump>
#    (the version is in `SELECT extversion FROM pg_extension WHERE extname='timescaledb'` on the source;
#     for our own backups it is the version the stack was running)
# 4. Migrate and start
docker compose run --rm migrate && docker compose up -d && bash deploy/status.sh
```
Readings received while the database was down are still queued at the broker (persistent session, QoS 1) and arrive once `ingest` is back.

## MQTT credentials

**Rotate the ingest user's password:**
```bash
NEW=$(openssl rand -hex 24)
docker compose exec mosquitto mosquitto_passwd -b /mosquitto/config/passwd gridiq-ingest "$NEW"
sed -i "s#^MQTT_PASSWORD=.*#MQTT_PASSWORD=$NEW#" .env
docker compose kill -s HUP mosquitto       # reload the password file
docker compose up -d ingest                # picks up the new .env value
```

**Add a meter box:** its username must be the segment in its topic, because the ACL only allows `acuvim/<username>/telemetry`. A fleet device (created with `POST /devices`, below) uses its code in lower case, e.g. `gq-m01`; a meter added through the old Add Meter screen uses its UUID.
```bash
PW=$(openssl rand -hex 24)
docker compose exec mosquitto mosquitto_passwd -b /mosquitto/config/passwd <username> "$PW"
docker compose kill -s HUP mosquitto
```
Then set on the AXM-WEB2:
- host `mqtt.<domain>`, port 8883, TLS on;
- username `<username>` and the password above;
- topic `acuvim/<username>/telemetry`;
- QoS 1, store-and-forward on, NTP on.

Then watch `bash deploy/logs.sh ingest` for the meter's first rows.

**Remove or rotate a meter user:** `mosquitto_passwd -D /mosquitto/config/passwd <user>` (or `-b` with a new password), then the `kill -s HUP mosquitto` reload.

## Fleet: devices, points and deployments
Until the ops console (Phase 8), the fleet is managed through the API as a `super_admin` (`https://app.<domain>/api/ingestion/...`, `Authorization: Bearer <token>`). Readings stay keyed by the device; which project and point they belong to is decided by the deployment windows, so moving a box never copies or rewrites data.

| Step | Call |
|---|---|
| New box | `POST /devices {"code":"GQ-M01","serial_number":"...","model":"Acuvim II","comms_module":"AXM-WEB2"}`, then add the broker user `gq-m01` (above) |
| Project | `POST /projects {"tenant_id":"...","name":"...","end_client_name":"..."}` |
| Point | `POST /projects/<id>/points {"name":"Main incomer","role":"incomer","nominal_voltage_v":230,"ct_primary_a":400}` |
| Install | `POST /deployments {"device_id":"...","measurement_point_id":"...","installed_at":"<when it was connected>"}` |
| Commissioning | `GET /deployments/<id>`: `commissioning` is re-evaluated every minute for 15 minutes after `installed_at`, then final |
| Fix a reversed CT or a wrong ratio | `PATCH /deployments/<id>/corrections {"power_sign":-1,"reason":"CT installed backwards"}` (or `scale_correction`); audit-logged, raw data untouched |
| Remove | `POST /deployments/<id>/remove {"removed_at":"...","device_status":"in_stock"}` |
| Overview | `GET /fleet` (last seen, 24 h coverage, clock drift, payload/day); `GET /devices/<id>` for the deployment history |
| Energy balance | `GET /projects/<id>/energy-balance?from=...&to=...` |

- A device cannot be in two deployments at the same time, and a point cannot have two devices at once: the database rejects the overlap (409).
- Enter `installed_at` and `removed_at` as the times the box was actually connected and disconnected. Readings outside every deployment window still exist but belong to no project.
- Meters added through the old Add Meter screen get a point (role incomer) and an open deployment automatically. Set the right role on the point with `PATCH /points/<id> {"role":"pv"}` where needed.

## Archived meters and sites
In the app, "delete" **archives**: the meter or site leaves the lists and stops ingesting (its messages are dead-lettered as unknown meter), while its readings, reports and alerts are kept.

- **Restore** (an admin of the tenant, or super_admin): `POST /api/ingestion/meters/<id>/restore` or `POST /api/ingestion/sites/<id>/restore`. A site restore brings back the meters archived with it. List archived ones with `GET /api/ingestion/meters?archived=1` / `sites?archived=1`.
- **Purge permanently** (rare: e.g. a client's written request, or test data):
  ```bash
  bash deploy/scripts/purge-archived-meter.sh <meter-id> --confirm "<exact meter name>"
  ```
  It only works on an archived meter, takes a fresh backup first (and stops if the backup fails), deletes the readings and the meter (with its alerts, events, assessments and share links) in one transaction, then refreshes the rollups. Every purge is logged in `${DATA_DIR}/backups/purge.log`. This is the only path that deletes raw readings.

## Reading logs
```bash
bash deploy/logs.sh ingest 200     # follow one service (caddy web gateway auth api ingest jobs migrate mosquitto timescaledb)
docker compose logs --since 1h jobs | grep '\[alerts\]'
docker compose logs ingest | grep 'last 60 s'      # per-minute rows / conflicts / dead letters / p95
sudo tail -f /var/log/gridiq/backup.log
```
What to look for:

| Service | Lines |
|---|---|
| ingest | `Flush of N row(s) failed; nothing acked` (DB trouble, retrying); `unknown meter` (dead letters); `sends N unmapped parameter(s)` (firmware names to add to `channels.ts`) |
| jobs | `[alerts] <check> check failed` |
| any service | `FATAL: Database schema is behind` / `retention policies do not match`: run `docker compose run --rm migrate` |

## Certificates
Caddy renews the certificates for `APP_DOMAIN` and `MQTT_DOMAIN` itself. The daily `sync-mqtt-certs.sh` copies the MQTT one to Mosquitto and restarts it only if it changed.

To force a sync: `sudo bash deploy/scripts/sync-mqtt-certs.sh`.

## Cron
`sudo bash deploy/scripts/install-cron.sh` (re)installs `/etc/cron.d/gridiq`. It holds the backup, cert sync, restore drill and a safe weekly Docker prune, which never removes previous image tags or volumes.
