# GridIQ data for an external feasibility tool

GridIQ supplies measured data; the feasibility engineer models systems and money.
Two ways in: the **data package** (files, emailed at close-out) or the **API**
(`/api/v1`, OpenAPI at `/api/v1/openapi.json`, browsable at `/api/docs/`).

## The data package

| File | Content |
|---|---|
| `manifest.json` | assessment/site/point/deployment IDs, period, conventions, units per column, SHA-256 per file |
| `load_profile_30min.csv` | per point: 30-minute kW and kVA averages, billed-demand kVA/kW, samples, minutes, coverage |
| `readings_1min.csv` | per point: 1-minute averages of V, I, P/Q/S, PF, frequency, THD, energy registers |
| `daily_energy.csv` | SAST daily peaks and an energy estimate |
| `findings.csv` | rule findings with review state |
| `overview-rN.pdf`, `power_quality-rN.pdf`, `handover-rN.pdf` | frozen report revisions |

Conventions (also at the top of every CSV, as `#` lines): UTC timestamps; rows are
period-ending `[period_start, period_end)`; empty cell = not measured (never zero);
import positive with the deployment's sign and scale corrections applied; raw
readings are never modified.

### Import example (Python, standard library only)

```python
import csv, hashlib, json, pathlib

pkg = pathlib.Path("GQ-A-0007")                      # the downloaded files
manifest = json.loads((pkg / "manifest.json").read_text())
for f in manifest["files"]:                          # verify every file first
    digest = hashlib.sha256((pkg / f["name"]).read_bytes()).hexdigest()
    assert digest == f["sha256"], f"{f['name']} is not the file GridIQ issued"

rows = [r for r in csv.reader(l for l in (pkg / "load_profile_30min.csv").open() if not l.startswith("#"))]
head, data = rows[0], rows[1:]
i_end, i_kw, i_cov = head.index("period_end"), head.index("kw_avg"), head.index("coverage")
profile = [(r[i_end], float(r[i_kw]) if r[i_kw] else None, float(r[i_cov])) for r in data]
usable = [p for p in profile if p[1] is not None and p[2] >= 0.8]   # skip gaps; never fill with 0
print(f"{len(usable)} of {len(profile)} half-hours usable; period {manifest['assessment']['period_from']} → {manifest['assessment']['period_to']}")
```

## The API

A client admin creates a key in Portal → Settings → API keys (scopes default to
everything except raw readings). A key works only while the project has a live
assessment, and reads only inside that assessment's window.

```bash
KEY=gq_live_...
curl -s -H "Authorization: Bearer $KEY" https://app.example.co.za/api/v1/assessments
curl -s -H "Authorization: Bearer $KEY" \
  "https://app.example.co.za/api/v1/points/$POINT/readings?interval=30m&from=2026-11-02T08:00:00Z&to=2026-11-09T08:00:00Z&format=csv" -o load.csv
# Longer ranges as a background export (signed download link, 1 hour):
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"point_id":"'$POINT'","interval":"1m","from":"2026-11-02T08:00:00Z","to":"2026-11-09T08:00:00Z"}' \
  https://app.example.co.za/api/v1/exports
# After close-out, the package manifest (during the delivery window):
curl -s -H "Authorization: Bearer $KEY" https://app.example.co.za/api/v1/assessments/$ASSESSMENT/package
```

No shared database, no proprietary format, and no sizing results: the receiving
tool applies its own tariffs and assumptions.
