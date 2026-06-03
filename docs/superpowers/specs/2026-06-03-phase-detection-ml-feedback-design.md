# Phase Detection, ML Display, and Pilot Feedback Design

**Date:** 2026-06-03
**Status:** Approved
**Scope:** Improved phase segmentation, ML label comparison, pilot correction UI, training data collection

---

## 1. Problem Statement

The FlyTab engine monitor ML model (`ml_phase` column in CSV) is biased toward "cruise" because cruise rows dominate the training dataset. This causes:

- Climb, descent, and ground sub-phases to be mis-labeled as cruise
- The anomaly detector to fire against cruise expectations during non-cruise phases
- False anomaly events in the debrief that don't represent real engine problems

The debrief app becomes a **data labeling tool** to fix this class imbalance. Physics-based detection provides a ground-truth reference; pilot corrections on disagreements generate balanced training examples for FlyTab model retraining.

---

## 2. Phase Taxonomy

### Ground sub-phases (each occurs once per flight, in sequence before takeoff)

| Phase | Detection |
|---|---|
| **startup** | First row where `rpm ≥ 500` sustained for 3 consecutive rows, through first RPM stabilization (~120s) |
| **warmup** | `rpm ≥ 500`, `speedKts < 3`, `rpm < 1800`, duration > 60s |
| **taxi** | `speedKts ≥ 3` on ground (altitude within 100 ft of departure field elevation), `rpm < 1800` |
| **runup** | `rpm ≥ 1800` while `speedKts < 3` (stationary high-power check) |

### Flight phases (multiple occurrences allowed)

| Phase | Detection |
|---|---|
| **climb** | Smoothed altitude rate > +200 fpm sustained ≥ 30 seconds |
| **cruise** | `|altRate| ≤ 200 fpm` |
| **descent** | Smoothed altitude rate < −200 fpm sustained ≥ 30 seconds |
| **approach** | `ml_phase = 'approach'` for ≥ 10 consecutive rows (ML is reliable for approach configuration detection even with cruise bias) |

### Post-landing

| Phase | Detection |
|---|---|
| **landing** | Ground rows after the OOOI On timestamp |

### Altitude smoothing and rate calculation

```
smoothAlt[i]  = rolling 30-second mean of altFt
altRate[i]    = (smoothAlt[i+15] - smoothAlt[i-15]) / 30 × 60   → ft/min
```

Short segments < 60 seconds are absorbed into their longer neighbor before returning the segment list.

---

## 3. Segment Data Shape

Each phase segment carries the existing fields plus ML comparison fields:

```javascript
{
  name:        string,   // computed label: 'startup'|'warmup'|'taxi'|'runup'|'climb'|'cruise'|'descent'|'approach'|'landing'
  startIdx:    number,   // first CSV row index
  endIdx:      number,   // last CSV row index (inclusive)
  durationSec: number,   // endIdx - startIdx + 1 (1Hz data)
  distNm:      number,   // haversine distance across segment
  score:       number,   // 0–100 from scorePhases()
  mlLabel:     string,   // dominant ml_phase value across segment rows
  mlAgreement: boolean,  // name === mlLabel
  pilotLabel:  string|null,  // null until pilot corrects; persisted to phases.json
}
```

`mlLabel` is computed as the mode (most frequent value) of `fd.mlPhase[startIdx..endIdx]`.

---

## 4. Phase Detection Module

**New file:** `js/phase-detector.js`

```
export function detectPhases(fd)
```

Replaces the call to `segmentPhases(fd.mlPhase)` in `csv-parser.js`. The existing `segmentPhases` function is retained for tests but no longer used in the main data flow.

### Algorithm outline

1. Identify `takeoffIdx` (first row where aircraft becomes airborne) and `landingIdx` (last row in flight, from OOOI On or altitude return to field elevation)
2. Scan ground rows before `takeoffIdx` → detect startup, warmup, taxi, runup in sequence using RPM + speed thresholds above
3. Scan airborne rows `takeoffIdx..landingIdx`:
   - Compute `smoothAlt` and `altRate` arrays
   - Walk rows, emitting phase transitions when rate crosses ±200 fpm threshold sustained ≥ 30 rows
   - Override with `approach` when `ml_phase='approach'` block ≥ 10 rows is detected within descent
4. Append landing segment after `landingIdx`
5. Merge segments shorter than 60 seconds into their neighbor
6. Compute `mlLabel` and `mlAgreement` for each segment
7. Return array of segment objects

---

## 5. Score Panel — AIRMANSHIP Additions

Three new rows added to the AIRMANSHIP section of `js/score-panel.js`, displayed as informational values (no pass/warn/fail threshold — displayed in muted text always):

| Row | Value | Unit |
|---|---|---|
| Ground speed | `fd.speedKts[rowIdx]` | kt |
| Rate of climb | `altRate[rowIdx]` when positive | ft/min |
| Rate of descent | `altRate[rowIdx]` when negative | ft/min |

`altRate` at the current row index is computed from the smoothed altitude array produced by `detectPhases`. The score panel receives the `altRate` Float32Array as part of `fd` (attached during phase detection: `fd.altRate = altRateArray`).

Only one of ROC/ROD is shown at a time depending on sign of `altRate[rowIdx]`. Both hidden when near zero (|altRate| < 50 fpm) to reduce clutter.

---

## 6. Phase Sidebar — ML Disagreement Display

### Disagreement badge

When `mlAgreement === false`, an amber badge appears below the score bar:

```
┌─────────────────────────┐
│ → Cruise 3              │
│    12.4 nm · 18m 22s    │
│    Score: [82] ██       │
│    ⚠ ML: climb          │  ← amber, only when labels differ
└─────────────────────────┘
```

Segments where `pilotLabel` is set show a green `✓ confirmed` badge instead (or `✓ corrected` if `pilotLabel !== name`).

### Disagreement counter

A compact header above the phase list:

```
PHASES  ·  3 disagreements  ·  2 confirmed
```

- "3 disagreements" shown in amber when > 0
- "2 confirmed" shown in green when > 0
- Both hidden when all segments agree and none are corrected

### Phase numbering

Phases that can repeat are numbered: "Climb 1", "Climb 2", "Cruise 1", "Cruise 2", etc. Single-occurrence phases (startup, warmup, taxi, runup, landing) have no number.

---

## 7. Correction UI

Clicking a phase row (or the `⚠ ML:` badge) expands an inline correction panel within the sidebar row — no modal:

```
┌─────────────────────────────────────┐
│ → Cruise 3    12.4 nm · 18m 22s     │
│    Score: [82] ██  ⚠ ML: climb      │
│ ┌─────────────────────────────────┐ │
│ │ Label this segment:             │ │
│ │ ○ startup  ○ warmup  ○ taxi     │ │
│ │ ○ runup    ● climb   ○ cruise   │ │
│ │ ○ descent  ○ approach ○ landing │ │
│ │                                 │ │
│ │ [Confirm ✓]       [Cancel]      │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

- Default selection is the computed label (`name`)
- Pilot can select any label including confirming the computed one (useful to mark "ML was wrong, computed is right")
- **Confirm** performs three atomic actions:
  1. Updates `segment.pilotLabel` in memory and re-renders the sidebar row
  2. `PUT /api/phases/{filename}` — saves all segments to `{flight}.phases.json`
  3. `POST /api/training-log` — appends a training entry (see Section 8)
- **Cancel** closes without saving
- Only one correction panel open at a time

---

## 8. Training Data Format

Each pilot correction appends one entry to `~/.flytab-debrief/training-log.jsonl`:

```json
{
  "type": "phase_correction",
  "flightDate": "2026-05-29",
  "flightFile": "20260529_KLKR-KLKR.csv",
  "segmentIdx": 2,
  "startIdx": 1840,
  "endIdx": 2950,
  "durationSec": 1110,
  "computedLabel": "cruise",
  "mlLabel": "climb",
  "pilotLabel": "cruise",
  "stats": {
    "avgAltFt": 3519,
    "avgAltRateFpm": 12,
    "avgSpeedKts": 118,
    "avgRpm": 2450,
    "avgPctPower": 65,
    "avgFuelFlow": 8.2,
    "maxChtF": 362,
    "avgBank": 1.4
  }
}
```

`pilotLabel` is the confirmed correct label. When pilot confirms the computed label (ML was wrong), `pilotLabel === computedLabel !== mlLabel` — this is the most valuable training example for reducing ML bias.

`stats` contains the mean values of key sensor fields across the segment. These are the numerical features the ML model uses for classification.

---

## 9. Server Endpoints

Two new endpoints in `server/debrief-server.py`:

### `GET /api/phases/{filename}`

- Reads `{flights_dir}/{filename}.phases.json`
- Returns `{"segments": [...]}` if found
- Returns `{"segments": null}` if not found (first open, no corrections yet)

### `PUT /api/phases/{filename}`

- Body: `{"segments": [...]}` — full segment array
- Writes to `{flights_dir}/{filename}.phases.json`
- Returns `{"ok": true}`

---

## 10. App.js Load Sequence

```
1. parseCSV(text) → fd  (csv-parser.js)
2. detectPhases(fd)     → fd.phases, fd.altRate attached to fd
3. GET /api/phases/{filename}
   → if segments returned: overlay pilotLabel onto fd.phases by segmentIdx
4. scorePhases(fd, thr) → phaseScores (uses fd.phases with corrected names if pilotLabel set)
5. detectEvents(fd, ...) → events
6. initPhaseSidebar(phaseScores, ...) → renders with ML badges
7. initScorePanel(fd, ...) → score panel now has fd.altRate for ROC/ROD
```

When `pilotLabel` is set on a segment, `scorePhases` uses `pilotLabel` as the effective phase name for scoring logic (approach stabilization scoring only applies when label is 'approach' or 'landing').

---

## 11. Files Changed

| File | Change |
|---|---|
| `js/phase-detector.js` | New — `detectPhases(fd)` with full algorithm |
| `js/csv-parser.js` | Replace `segmentPhases` call with `detectPhases`; attach `fd.altRate` |
| `js/score-panel.js` | Add GS, ROC, ROD rows to AIRMANSHIP section; use `fd.altRate` |
| `js/phase-sidebar.js` | ML disagreement badge, disagreement counter, phase numbering, correction panel |
| `js/app.js` | Load phase corrections from server; overlay on computed segments |
| `server/debrief-server.py` | Add `GET/PUT /api/phases/{filename}` endpoints |
| `tests/phase-detector.test.js` | New — unit tests for `detectPhases` ground sub-phases and altitude rate logic |
