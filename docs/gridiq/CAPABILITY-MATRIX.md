# Meter-to-platform capability matrix

Engineering UI brief, section 8. A channel is usable in an analysis only when every column to its left is
**Yes** for the installed unit. A meter's feature list does not prove the platform collects the feature.

Status of this document (12 Nov 2026): columns 4–6 are from the code (`services/ingestion-service/src/ingest/channels.ts`,
the continuous aggregates and `src/reports/dataset.ts`). Columns 1–3 are **unverified**: no real Acuvim II unit,
module, firmware or AXM-WEB2 configuration has been audited yet (the Phase 5 pilot). Record the result per unit in
`devices.capability_profile` (ops → Fleet → device → Capability profile); reports read that profile and never claim
a channel the unit does not record.

Columns:
1. Supported by the exact meter variant (Acuvim II / IIR / IIE / IIW).
2. Supported by its module, firmware or interface (AXM-WEB2 MQTT publishing).
3. Enabled in the collection configuration (the AXM-WEB2 publish list and interval).
4. Received by ingestion (mapped in `channels.ts`; unmapped names appear in the "unknown parameter" log).
5. Stored with units and timestamps (raw `meter_readings`; aggregates for the core channels).
6. Suitable for the intended analysis.

| Channel | 1 Variant | 2 Module | 3 Enabled | 4 Received | 5 Stored | 6 Suitable for |
|---|---|---|---|---|---|---|
| V L-N per phase | verify | verify | verify | Yes (`voltage_a/b/c`) | Yes, raw + all aggregates (avg/min/max, mean square) | Voltage trend, NRS 048-2 screening on 10-min values |
| V L-L | verify | verify | verify | Yes (`voltage_ab/bc/ca`) | Raw only | Not used in reports yet |
| I per phase | verify | verify | verify | Yes (`current_a/b/c`) | Raw + aggregates | Phase loading, unbalance context |
| Neutral current | verify | verify | verify | Yes (`current_n`) | Raw only | Not analysed yet. Never inferred by adding phase RMS currents |
| P, Q, S, PF totals | verify | verify | verify | Yes | Raw + aggregates | Demand, energy fallback, loaded PF |
| P, Q, S, PF per phase | verify | verify | verify | Yes | Raw only | Not analysed yet |
| kWh import/export registers | verify | verify | verify | Yes | Raw (first/last per bucket) | Register energy (primary method) |
| kvarh import/export | verify | verify | verify | Yes | Raw only | Not analysed yet |
| Demand registers (meter's own) | verify | verify | verify | Yes (`demand_*`) | Raw only | Not used; GridIQ computes 30-min demand from P/S |
| Frequency | verify | verify | verify | Yes | Raw + aggregates (min/max) | Frequency screening |
| THD-V per phase | verify | verify | verify | Yes | Raw + aggregates | THD-V screening and trend |
| THD-I per phase | verify | verify | verify | Yes | Raw + aggregates | Trend only. THD-I is not TDD; no IEEE 519 conclusion without demand current and fault level |
| Voltage / current unbalance | verify | verify | verify | Yes | Raw + aggregates | As computed by the meter; not stated to be negative-sequence |
| Individual harmonic orders (2–63) | Documented for the series; verify | verify | **No** | **No** | **No** | **Not collected.** No spectrum is shown or inferred from THD |
| Phase angles, sequence components | verify | verify | **No** | **No** | **No** | Not collected: no phasor view |
| Crest factor, K-factor | verify | verify | **No** | **No** | **No** | Not collected |
| Device events (dips/swells), waveform capture | Variant-dependent (IIW); verify | verify | **No** | **No** | **No** | Not collected. Events in reports are inferred from the 1-s RMS trend (`pq_events`) and say so |
| Flicker Pst/Plt, interharmonics, rapid voltage change, transients | Not assumed | — | **No** | **No** | **No** | Not measured; never shown |

Rules applied everywhere (dataset, PDFs, website, consultant):
- Total THD cannot reconstruct individual orders; magnitude-only spectra cannot reconstruct waveforms.
- 1-second RMS samples cannot establish the absence of sub-second events.
- Formal NRS 048-2 verdicts only for a confirmed IEC 61000-4-30 Class A unit, ≥ 7 days and ≥ 95 % valid
  10-minute values (`verdictFor`); otherwise "screening only".
- Primary versus secondary scaling must be checked at commissioning (`scale_correction`, the CT check) so values
  are never double-scaled.
- Distinct states: "not measured" (the unit cannot), "not collected" (the unit may, the platform does not),
  "insufficient coverage", "not applicable".

## Next steps to enable more channels

1. Audit one installed unit: variant label, module, firmware, AXM-WEB2 publish list; fill `capability_profile`.
2. If the unit publishes harmonic orders, add them as a separate table at their own cadence (not repeated as fresh
   1-second samples), with tests from a real payload fixture, before any spectrum chart is enabled.
3. Same for device event logs and waveform records, keyed to their own timestamps.
