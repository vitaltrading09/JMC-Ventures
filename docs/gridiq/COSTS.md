# What is free and what costs money

| Part | Software | Running cost |
|---|---|---|
| Web app, API, ingest, jobs, MQTT broker, PostgreSQL/TimescaleDB, Caddy | open source, in this repository | the server they run on |
| Hosting | any Linux VM with Docker (an Oracle free-tier A1 can carry a pilot if benchmarked first) | VM, disk, bandwidth; free tiers change, do not depend on one |
| Storage | 1 meter at 1 Hz ≈ 86,400 rows/day, 2.6 M per 30 days; compressed after 15 days | disk grows with meters × retention; measure on the pilot |
| Backups | `deploy/scripts/backup.sh` → Cloudflare R2 (age-encrypted) | R2 storage and operations |
| Domain and TLS | Caddy obtains certificates (Let's Encrypt, free) | domain registration |
| Fleet map | schematic SVG from recorded coordinates; no map provider | none |
| Email | SMTP to a provider of your choice | per-message or monthly plan; sender-domain setup |
| AI consultant | Anthropic or OpenAI API | per token (estimate per assessment shown in `ai_messages.cost_cents`; capped by `ai_budget_cents`) |
| WhatsApp | not implemented | business messaging is paid per conversation; verify current rules first |
| Meters | Acuvim II + web module | hardware, SIM/mobile data per meter, calibration |

Without an email provider or AI key the platform still works: emails fail visibly
in the ops console, and the consultant answers from the assessment data only.
