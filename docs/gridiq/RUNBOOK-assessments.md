# GridIQ assessments: operations runbook

Covers the assessment lifecycle, expiry, report delivery, retention and deletion,
and restoring a backup safely. Deployment, MQTT users and backups in general are
in `docs/RUNBOOK.md`.

## 1. Lifecycle of one assessment

1. **Site and point.** Ops → Projects: the client's site with an incomer point
   (nominal voltage, CT primary, contracted MDI). Fill in **Site context**
   (operating hours, supply, major loads, generation, symptoms): reports rely on it.
2. **Meter.** Ops → Fleet → the box: confirm its **capability profile**
   (channels, harmonic orders, events, cadence, IEC 61000-4-30 class). Reports
   never claim a channel the profile and the data do not show.
3. **Draft.** Ops → Assessments → New assessment: site, package (or custom
   duration), agreed price, retention 3 or 6 months. Every metered point of the
   site is included; the quote is snapshotted.
4. **Payment.** On the assessment page record *paid* with the invoice reference,
   or an *approved exception* with a reason. The clock cannot start before this.
5. **Install** the box (Ops → Install) and wait for the commissioning checklist.
6. **Start.** Confirm the start (now, or the commissioning time up to 24 h back).
   `end_at = start_at + days × 24 h`; windows are half-open `[start_at, end_at)`.
   The named recipients get an activation email.
7. **Invite** recipients (Named access). Each signs in with an email code; no
   password is ever sent.
8. **While live:** clients see readings, findings, provisional previews and the
   consultant, all clamped to the assessment window. Staff can issue an interim
   snapshot (Reports and delivery → reason → Issue now).
9. **Extend** (days + reason) or **close early** (reason). Missing telemetry never
   pauses or extends the clock by itself.
10. **End.** Access stops exactly at `end_at` (checked in SQL on every request;
    the expiry job only sets the status). Recipients got a 24-hour notice.
11. **Close-out** (jobs, every 5 min) runs `ASSESSMENT_LATE_DATA_HOURS` (2) after
    the end: overview and feasibility handover are issued (factual templates), the
    power-quality report is drafted for engineering review, the data package is
    written, and each recipient gets one email with a personal delivery link
    valid for `delivery_days` (7) capped by retention.
12. **Review** the PQ draft: Assessments → Reports and delivery → *Approve & issue*.
    Recipients receive it automatically.
13. **Retention.** At `retention_until` access to the deliverables stops; the
    hourly purge deletes the content (section 4).

## 2. When something goes wrong

| Symptom | Where | Action |
|---|---|---|
| Close-out `failed` | assessment page, Reports and delivery | Read the error; it retries every 30 min. Fix the cause (e.g. disk), or re-run by setting `closeout_status = 'pending'`. |
| Email `failed` | Reports and delivery → Emails | `EMAIL_PROVIDER not set` → configure SMTP. Provider errors retry with back-off (1, 5, 30, 120, 360 min). Re-send: *Re-send deliverables* (new link, new email). |
| Late data after issue | Reports and delivery shows "late data" | Decide whether it matters; if yes, issue a new revision with a reason. The issued revision never changes. |
| Client cannot see data | assessment page | Check: status active, inside the window, grant not revoked, payment recorded. |
| Recipient lost the link | Re-send deliverables | Old links stay valid until they expire; revoke a grant to cut its links. |

## 3. Retention promise and backups

- Default retention: 3 calendar months after the effective end (6 optional),
  end-of-month clamped in the site time zone (31 Aug + 6 months = 28/29 Feb).
- Exceptions: a later deletion date with a documented reason (assessment page,
  PATCH `retention_exception_until` + reason).
- **Backups:** encrypted daily dumps are kept 7 daily / 4 weekly / 6 monthly
  (`deploy/scripts/backup.sh`). A purged assessment therefore remains in backups
  for up to **6 months** after its deletion date unless backup retention is
  shortened. State this in client terms (prompt section 14 asks for a bounded
  residual expiry, initially ≤ 30 days: **decision needed**: shorten the monthly
  backups to 1 or accept the longer residual and disclose it).

## 4. Deletion (the explicit retention step for raw readings)

This is the documented step that may delete `meter_readings` rows (master rule 5).
`src/assessments/retention.ts` → `purgeAssessment`:

- deletes, per device that served the assessment's points, the raw readings from
  the install to the end + late window, **minus** any time another still-retained
  assessment of the same point covers; plus `pq_events`, alerts and findings in
  those ranges; refreshes the aggregates over the ranges;
- clears every report revision's dataset and PDF, the data package, exports of
  those points in the range, delivery links and consultant conversations; clears
  email bodies (the send record stays);
- keeps the device, its deployments and maintenance (fleet record), the
  assessment row (financial record), the audit log, and writes a **receipt**
  (`assessment_purges`, counts only) and **tombstones** (`deletion_tombstones`);
- a failure sets `purge_failed` (visible on the assessment) and retries hourly.
  Access is already blocked at the deadline regardless.

## 5. Restoring a backup without resurrecting deleted data

```bash
# 1. Before restoring, save the tombstones from the current database:
bash deploy/scripts/apply-tombstones.sh export > /root/tombstones.csv
# 2. Restore (docs/RUNBOOK.md → Restore), keeping api/jobs/web stopped.
# 3. Re-apply the deletions, then start the services:
bash deploy/scripts/apply-tombstones.sh apply /root/tombstones.csv
```

If the current database is lost too, the tombstones in the restored dump cover
deletions up to that dump; anything purged after it must be re-purged from the
assessment list (assessments whose `retention_until` has passed are purged on the
next hourly run, since their status in the old dump is still `retained`).

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ASSESSMENT_LATE_DATA_HOURS` | 2 | Wait after the end before freezing reports |
| `EMAIL_PROVIDER` | unset | `smtp` (with `SMTP_URL`, `EMAIL_FROM`), `file` (dev), unset = not configured |
| `AI_PROVIDER`, `AI_MODEL` | by key present | `anthropic` (default model `claude-opus-5-5`), `openai`, `none` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | | Provider keys (cost per use) |
| `AI_MESSAGES_PER_HOUR` | 30 | Per user |
| `assessments.ai_budget_cents` | 5000 | Per assessment, US cents of provider cost; over budget the consultant answers from the data only |
| `STAFF_MFA_REQUIRED` | false | Staff must pass TOTP (enrol first: `POST /api/auth/mfa/setup` then `/mfa/enable`) |
| `FEATURE_TOOLS` | false | PV/BESS sizing in the metering report (outside the product) |
