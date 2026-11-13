# GridIQ implementation: plan, status and validation

Branch `gridiq-assessments` (local; not pushed). Product direction: *GridIQ implementation prompt*, 11 November 2026.
Audit of what existed and what each requirement maps to: [AUDIT.md](AUDIT.md). Operations: [RUNBOOK-assessments.md](RUNBOOK-assessments.md).

## Stages and gates

| Phase | Scope | Gate (measurable) | Status |
|---|---|---|---|
| 1. Assessment and fleet foundation | assessments, packages (cents, draft until VAT set), grants, maintenance, device states, capability profile, site context; entitlement in SQL; boundary-correct attribution; ops API | 7 × 24 h end exact and half-open; access stops at `end_at` with no job; A's expiry leaves B; tenant scan clean; move at 10:00:30 splits buckets | **Met** (tests below) |
| 2. One coherent website | ops home (clients, fleet map, status, ending soon, reviews, exceptions, maintenance), assessments and packages pages, asset history with split health, portal banner / expired states, GridIQ branding on new pages | pages build and render; no client sees internal fields (scoping test) | **Met**, with the gaps in AUDIT rows 18, 19, 36 |
| 3. Reports and close-out | frozen datasets, overview / adaptive PQ / handover PDFs, data package with manifest, close-out job, outbox email, delivery links, revisions, retention purge, tombstones | close-out idempotent across restart; frozen dataset refused by DB; revision supersedes; files-only access after end; purge removes this assessment only; restore re-applies deletions | **Met** (tests and drill below) |
| 4. Consultant and integrations | scoped consultant with budgets and adapters, deterministic fallback; `/v1/assessments`, package endpoint; email-code login; staff TOTP | cross-tenant prompts cannot reach data (path-scoped retrieval; scoping scan); model outage still answers from data | **Met** except AI digest job and WhatsApp (not started) |
| 5. Measured pilot | real Acuvim II + module, one real assessment | channel cadence, buffering, replay, coverage, delivery, operator effort | **Not started**: needs hardware |

## Validation results (this branch, local stack, 11 Nov 2026)

| Acceptance area (prompt §18) | Evidence | Result |
|---|---|---|
| Asset lifecycle | `test/db/assessments.test.js` "asset's history…"; `fleet-move.test.js` | pass |
| Tenant isolation | `test/db/scoping.test.js` (every route incl. assessments, deliverables, consultant, v1) | pass |
| Boundary attribution | `assessments.test.js`: 10:00:30 move, 1m/10m/30m/1h/1d split, out-of-order sample | pass |
| Package timing | `test/assessments.test.js` (unit) and scoping test (API start → 7 × 24 h) | pass |
| Access expiry | scoping test: `end_at` passed, status still active, valid session → 403 | pass |
| Multi-assessment user | scoping test: A ends, B still 200 | pass |
| Login | `deliverables.test.js`: no enumeration, wrong code, reuse, 5-attempt burn, codes absent from logs | pass |
| Collection | `assessments.test.js`: 86,400 rows for a 1 Hz day, replay inserts 0 | pass (storage boundary; the broker/worker outage drill was run in Phase 3 load test, not re-run here) |
| Outage/replay | `services/ingestion-service/test/load/simulate.ts` (Phase 3) | not re-run in this branch |
| Honest health | device health endpoint separates five dimensions | implemented; no automated test |
| Energy correctness | golden 100 kW × 1 h = 100 kWh ± 0.1 | pass |
| Calculation edges | existing energy/demand unit tests (resets, gaps, sign, scale) + boundary test | pass |
| Harmonic report | THD-only data → THD section, "orders not recorded", no spectrum | pass (individual orders not ingested: cannot test the spectrum path) |
| PQ limits | no Class A profile → "screening only" verdict | pass |
| Report consistency | package CSV max kVA = dataset = consultant answer | pass |
| Report revision | revision 2 supersedes; revision 1 PDF byte-identical; DB refuses edits | pass |
| Expiry delivery | close-out once; restart/re-run send no duplicates | pass |
| Delivery exception | after end: files 200, preview 403, other tenant 403, revoked link 410 | pass |
| Retention | purge: this assessment's rows gone, other client's intact, fleet history kept, receipt + tombstones | pass |
| Backup restoration | `apply-tombstones.sh` drill: 10 resurrected rows → 0; assessment back to purged | pass (manual drill on a test DB) |
| AI authorisation | retrieval keyed by path + live grant; not callable with API keys; scoping scan | pass |
| AI outage | provider error or none → deterministic answer from the dataset | implemented; covered for `none` |
| UI / reporting performance | | **not measured**: needs a pilot environment and a 30-day 1 Hz dataset |
| Real hardware | | **not possible here** |

Commands: `npm test` (unit), `TEST_DATABASE_URL=… node --test --test-concurrency=1 services/ingestion-service/test/db/*.test.js` (70 DB tests), `npm run build`.

## Launch decisions still needed (business input)

1. **Tax and inclusions**: are the example prices VAT-inclusive; is GridIQ VAT-registered; what each package includes (installation/removal, travel, deposit, extra meters, review). Packages stay unpublished until set.
2. **Pricing**: the four example prices are placeholders, not market-validated.
3. **Exact hardware**: Acuvim II variant, web module, firmware, enabled channels, harmonic orders, event/waveform capture, IEC 61000-4-30 class. Fill in each box's capability profile.
4. **Email provider**: choose and verify an SMTP provider and sender domain (SPF/DKIM). Until then emails are written to files (dev) or fail visibly.
5. **Retention wording and backups**: 3 / 6 months is a business default, not a legal conclusion. Backups currently keep monthly dumps for 6 months: shorten them, or disclose the longer residual period (RUNBOOK §3).
6. **AI provider and budget**: Anthropic or OpenAI key, and a per-assessment budget (default US$50 of provider cost).
7. **Final-delivery window**: 7 days by default, capped by retention.
8. **Staff MFA**: enrol staff, then set `STAFF_MFA_REQUIRED=true`.
