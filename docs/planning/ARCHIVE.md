# Raw-data archive (design note, not implemented)

Plan Phase 4 keeps every raw reading in TimescaleDB, with chunks compressed after `COMPRESS_AFTER_DAYS` (default 15; measured ~93 % saving). This note is for when the database passes about **100 GB**, or the VM's block volume gets tight.

## What stays in the database
- The continuous aggregates (`readings_1m` … `readings_1d`) are kept forever. They serve every chart, report, demand and energy query.
- Raw `meter_readings` stays online for a rolling window, e.g. 13 months, so a year-on-year compliance comparison can still be re-run from source. Readings are evidence: nothing is dropped before it is verifiably archived.

## Archive format
- Parquet files, one per meter per month: `s3://<bucket>/raw/meter_id=<uuid>/year=2026/month=11/part-0.parquet`.
- Columns exactly as `meter_readings`, including the provenance columns (`device_time`, `ingested_at`, `time_source`), with the column list written in the file metadata.
- Compression ZSTD, row groups of about 1 million rows, sorted by `time`.
- Stored on the same S3-compatible store as backups (R2 / OCI Object Storage), in a separate bucket with object lock or versioning, so archive files cannot be silently rewritten.

## Archive job (jobs role, monthly)
1. For each month older than the online window, export every meter's month with `COPY (SELECT ... ORDER BY time) TO STDOUT` through a Parquet writer (e.g. DuckDB `COPY ... TO 'file.parquet'`).
2. Verify before deleting anything:
   - the row count per meter/month matches the database;
   - first/last timestamps and a checksum (sum of `extract(epoch FROM time)` and of `energy_import_total`) match;
   - the file reads back.
3. Record it in a new `archive_manifest` table (`meter_id, month, rows, checksum, object_key, archived_at, verified_at`).
4. Only then run `drop_chunks('meter_readings', older_than => <online window>)`. This is the documented retention step that rule 5 ("raw readings are immutable") requires; nothing else deletes raw rows.

## Reading archived data
- **Ad hoc:** DuckDB or Polars directly on the bucket (`read_parquet('s3://.../meter_id=<id>/**/*.parquet')`).
- **Restore a month for re-assessment:** load the Parquet back into a scratch table, never into `meter_readings`, so live data and evidence stay separate.

## Open questions
- Online window length (13 months suggested) and whether clients on a lower tier get a shorter one.
- Whether the aggregates also need a cold copy, or the database backups are enough.
- Retention obligations, if any, from POPIA or client contracts for metering data.
