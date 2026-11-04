# @gridiq/db

Database migrations for Grid-IQ, plus what the services need from them at runtime.

| Path | What |
|---|---|
| `migrations/*.sql` | [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) migrations, plain SQL (`-- Up Migration` / `-- Down Migration`) |
| `bin/migrate.js` | The migrate step: `up` (default), `status`, `down N` |
| `bin/quarantine-duplicate-readings.js` | Explicit cleanup for pre-guard databases with duplicate readings (see below) |
| `index.js` | `MAX_BACKFILL_DAYS`, `COMPRESSION_AFTER_DAYS`, `assertSchemaCurrent()` |

## Rules

- **The baseline** (`*_baseline.sql`) consolidates the old `init.sql` and the
  startup `CREATE/ALTER ... IF NOT EXISTS` blocks that used to live in
  ingestion-service `main.ts` and `mqtt.ts`. It is safe on an empty database
  **and** on an existing one: IF NOT EXISTS and catalog-guarded DDL. It is the
  only idempotent migration.
- **Every later migration is normal**: plain DDL, no `IF NOT EXISTS`. It runs
  exactly once per database, in order (`--check-order`).
- No service changes the schema. auth-service and every ingestion-service
  role call `assertSchemaCurrent()` at startup and **exit** if a migration is
  pending, with the command to run. A database *ahead* of the code (newer
  migrations, e.g. after an image rollback) only logs a warning.
- Raw `meter_readings` rows are evidence: migrations never update or delete
  them. The one exception is the explicit quarantine step below.
- Compression must start strictly later than the MQTT backfill window, or
  backfilled readings could land in compressed chunks where the unique index
  isn't enforced. Both numbers live in `index.js`, and `test/constants.test.js`
  fails if `COMPRESSION_AFTER_DAYS <= MAX_BACKFILL_DAYS` or if a migration's
  `add_compression_policy` interval differs from `COMPRESSION_AFTER_DAYS`.

## Commands

```bash
# Docker (normal): deploy.sh does this before `up -d`
docker compose run --rm migrate                     # up
docker compose run --rm migrate node /app/packages/db/bin/migrate.js status

# Host (npm run dev), DATABASE_URL from your shell
npm run migrate -w packages/db
npm run migrate:status -w packages/db
npm run migrate:create -w packages/db -- add-something   # new SQL migration file
npm test -w packages/db
```

The migrate step runs every pending migration in **one transaction**: if any
fails, the schema is left exactly as it was. Before migrating it also runs
`ALTER EXTENSION timescaledb UPDATE` when the TimescaleDB image is newer than
the extension installed in the database.

## Duplicate readings in an old database

Databases from before the `ON CONFLICT (meter_id, time)` guard can hold
several readings for one meter and timestamp (seen in practice: the same CSV
imported twice with different unit scaling). The baseline then stops with
`meter_readings has duplicate (meter_id, time) rows ...` and changes nothing.

```bash
# 1. Report only: per meter, how many timestamps and rows
docker compose run --rm --no-deps migrate node /app/packages/db/bin/quarantine-duplicate-readings.js
# 2. Move every row of a duplicated (meter_id, time) to meter_readings_quarantine
docker compose run --rm --no-deps migrate node /app/packages/db/bin/quarantine-duplicate-readings.js --apply
# 3. Migrate again
docker compose run --rm migrate
```

`--apply` keeps **none** of a duplicated timestamp's rows in `meter_readings`,
because nothing can tell which one was right. Nothing is deleted for good:
the rows stay in `meter_readings_quarantine` (plus `quarantined_at`,
`quarantine_reason`) for review or manual restore.

## Restoring a dump

`deploy/scripts/restore-dump.sh <dump> <timescaledb-version-of-the-dump>`
restores into an empty compose database. It creates the extension at the dump's
version, restores, then reports duplicates; `migrate` then updates the
extension and applies the migrations.
