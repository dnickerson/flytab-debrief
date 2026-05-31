# Flight Replay & Pilot Performance Review — Design Spec

**Date:** 2026-05-31
**Project:** flytab-debrief (new standalone repo)
**Author:** Dana Nickerson / Claude
**Status:** Approved for implementation planning

---

## 1. Overview

A standalone post-flight debrief web application that reads 1Hz CSV flight recordings from FlyTab, computes a holistic pilot performance review, and presents it as an interactive map replay with synchronized charts and a scored performance report. An optional AI-generated narrative review is available via Claude API.

### Goals
- Give the pilot objective performance feedback on both engine management and airmanship after every flight
- Replace the mental overhead of manually reviewing EDM CSV files with a structured, visual debrief
- Accumulate per-flight scored metrics as a training dataset for future ML analysis
- Provide richer post-flight insight than ForeFlight (which has no engine data)

### Non-goals
- In-flight use (this is a post-flight ground tool only)
- Cloud hosting in this phase (local-only, Tailscale for remote access)
- ADS-B traffic replay (traffic not recorded in CSV)
- 3D synthetic vision replay

---

## 2. Architecture

### Repository
Standalone repo: `~/flytab-debrief`. No shared code with FlyTab or fly-pipeline. References FlyTab `aircraft-config.json` and `cockpit-config.json` for thresholds and V-speeds.

### Stack
- **Frontend:** Vanilla JS + Chart.js + Leaflet. Single `index.html`, modules via `<script>` tags, no bundler.
- **Backend:** Python HTTP server on port `8092`, bound to `0.0.0.0` (accessible on home WiFi and Tailscale).
- **Process:** systemd service — starts on boot, no manual launch needed.

### Data Flow
```
FlyTab tablet
  └─ FlightUpload (SFTP) ──▶ ~/flights/YYYYMMDD_DEP-DEST.csv
                                   │
debrief-server.py (:8092) ──reads──┘
  ├─ GET  /api/flights              list CSV files
  ├─ GET  /api/flights/{name}       stream CSV
  ├─ POST /api/claude               Claude API proxy (API key server-side)
  ├─ POST /api/winds                AWC windtemp fetch + SQLite cache
  ├─ POST /api/metar                AWC historical METAR fetch + SQLite cache
  └─ static: index.html, js/, css/
```

### Access
- Home WiFi: `http://192.168.1.77:8092`
- Tailscale: `http://<tailscale-ip>:8092`
- Pre-loaded flight: `http://<host>:8092/?file=YYYYMMDD_DEP-DEST.csv`

### FlyTab Integration (only change to FlyTab repo)
- New `DEBRIEF` button per logbook entry in `web/cockpit/logbook.js`
- Opens debrief URL in system browser with `?file=` parameter
- Base URL from new `debriefServer.base` key in `web/cockpit-config.json`
- Button grayed out if server unreachable (timeout on `GET /api/flights`)

---

## 3. Data Model

### CSV Input
44-column, 1Hz recordings. Key column indices (0-based):

| Column | Index | Notes |
|--------|-------|-------|
| RPM | 7 | Engine speed |
| EGT 1–4 | 16–19 | Exhaust gas temps °F |
| CHT 1–4 | 20–23 | Cylinder head temps °F |
| Oil Temp | 2 | °F |
| Oil Pressure | 3 | PSI |
| Carb Temp | 12 | °F |
| Fuel Flow | 8 | GPH |
| Gallons Remaining | 9 | Gal |
| Final_Percent_Power | 37 | % |
| Operating_Condition | 38 | "ROP" / "LOP" / "" |
| Percent | 39 | °F from peak EGT |
| SFC | 40 | Specific fuel consumption |
| latitude | 27 | Decimal degrees |
| longitude | 26 | Decimal degrees |
| altitude_ft | 28 | GPS MSL |
| speed_kts | 29 | GPS ground speed |
| bank | 30 | Degrees, + = right |
| pitch | 31 | Degrees, + = nose up |
| course | 33 | True course degrees |
| ml_phase | 41 | ground/climb/cruise/descent/approach/landing |
| ml_score | 42 | 0.0–1.0 anomaly score |
| ml_anomaly | 43 | 0 or 1 |

### FlightData Object (parsed once, held in memory)
```javascript
{
  rows: number,            // total row count
  sampleHz: 1,

  // Raw channels — Float32Array per channel for memory efficiency (~1.3 MB for 2h flight)
  time: Float32Array,      // seconds from start
  rpm: Float32Array,
  egt: [Float32Array × 4],
  cht: [Float32Array × 4],
  oilTemp: Float32Array,
  oilPress: Float32Array,
  carbTemp: Float32Array,
  fuelFlow: Float32Array,
  gallonsRem: Float32Array,
  pctPower: Float32Array,
  opCondition: string[],   // ROP / LOP / ""
  pctFromPeak: Float32Array,
  sfc: Float32Array,
  lat: Float32Array,
  lon: Float32Array,
  altFt: Float32Array,
  speedKts: Float32Array,  // ground speed
  bank: Float32Array,
  pitch: Float32Array,
  course: Float32Array,
  mlPhase: string[],
  mlScore: Float32Array,
  mlAnomaly: Uint8Array,

  // Derived channels (computed after winds/METAR fetch)
  tasKts: Float32Array,    // estimated TAS via wind triangle
  iasKts: Float32Array,    // estimated IAS via density correction

  // Metadata
  filename: string,
  depIcao: string,
  destIcao: string,
  startUtc: Date,

  // Computed scalars
  oooi: { out: Date, off: Date, on: Date, in: Date },
  blockMinutes: number,
  airMinutes: number,
  totalDistanceNm: number,
  phases: [{ name, startIdx, endIdx }],
  approaches: [{ startIdx, endIdx, fafIdx, runwayHeading }],

  // Summary stats
  maxCht: number, maxEgt: number,
  avgFuelFlow: number, totalFuelBurned: number,
  avgTas: number, avgIas: number,
  avgHeadwindKt: number,

  // Weather
  depMetar: string,
  destMetar: string,
  windsAloft: object,       // raw AWC response, cached
}
```

---

## 4. OOOI Detection

Derived entirely from CSV data.

| Time | Detection Logic |
|------|----------------|
| **Out** (engine start) | First row where RPM ≥ 500, sustained 3 consecutive rows |
| **Off** (wheels up) | First row after Out where `altFt > dep_field_elev + 200` AND `speedKts > 40` |
| **On** (touchdown) | Last row where `altFt` drops back through `arr_field_elev + 200` while `speedKts < 100` |
| **In** (engine stop) | Last row where RPM > 0 |

Field elevations: looked up from FlyTab home server NASR data (`:8090/api/airports/{icao}`). If home server unavailable, estimated from the GPS altitude cluster in the first/last 30 rows of CSV.

**Block time** = In − Out (logbook total time).
**Air time** = On − Off (wheels-up to wheels-down).

---

## 5. Physics Calculations

### Wind Triangle → Estimated TAS

```
GS_north  = speedKts × cos(course_rad)
GS_east   = speedKts × sin(course_rad)
W_north   = windSpeed × cos((windDir + 180°) × π/180)
W_east    = windSpeed × sin((windDir + 180°) × π/180)
TAS_north = GS_north − W_north
TAS_east  = GS_east  − W_east
TAS       = √(TAS_north² + TAS_east²)
```

Wind data: AWC `windtemp` forecast cycle valid at flight Off time. Linearly interpolate between the two bracketing pressure altitude levels at the station nearest to the flight centroid. Applied row-by-row using GPS altitude.

All TAS values labeled *"estimated"* in the UI.

### Density Correction → Estimated IAS

```
pressure_alt = altFt − (29.92 − altimeter_inHg) × 1000
OAT_K        = winds_aloft_temp_C_at_altitude + 273.15
σ            = [(1 − 6.8755e-6 × pressure_alt)^5.2559] × [288.15 / OAT_K]
IAS          = TAS × √σ
```

Altimeter setting: linearly interpolated between departure METAR QNH and arrival METAR QNH across the flight. Temperature: from winds aloft report, interpolated to GPS altitude.

All IAS values labeled *"estimated"* in the UI.

### DMMS (Defined Minimum Maneuvering Speed)

```
DMMS = 1.404 × VS1
```

Where VS1 = clean stall speed from `aircraft-config.json`. For the RV-9A N194JT, VS1 ≈ 50 KIAS → DMMS ≈ 70 KIAS.

Flag `DMMS_VIOLATION` when:
```
estimated_IAS < (DMMS + 5)   AND   |bank| > 15°
```
The +5 kt margin accounts for IAS estimation uncertainty. Every DMMS violation is a red-level safety event.

---

## 6. Scoring System

All sub-scores 0–100. Sub-scores averaged within each category. Overall score = average of three category scores. Color coding: 0–59 = red, 60–79 = yellow, 80–100 = green.

Thresholds sourced from `aircraft-config.json` and `cockpit-config.json` where available. Pilot-configurable overrides in a debrief settings panel.

### 6.1 Engine Management

| Sub-score | Scoring Logic |
|-----------|--------------|
| **CHT discipline** | Start at 100. Deduct 0.5/s above caution threshold, 2.0/s above danger threshold |
| **EGT balance** | Mean EGT spread during cruise. ≤50°F = 100, 51–100°F = linear 100→50, >100°F = 0 |
| **Mixture discipline** | % cruise rows with defined Operating_Condition (ROP or LOP). Red box exposure (>65% power with EGT within 50°F of peak on either side — not clearly ROP or LOP) = hard floor of 20 regardless of other scores |
| **Oil temperature** | % flight rows within normal oil temp range (from cockpit-config thresholds) |
| **Carb ice exposure** | 100 − (seconds_in_icing_range × 0.5), floor 0. Icing range: carbTemp 32–50°F at power < 75% |
| **Fuel efficiency** | Actual mean SFC vs. expected SFC from aircraft-config at recorded power setting. Within 5% = 100, each additional % = −5 pts |

### 6.2 Airmanship

| Sub-score | Scoring Logic |
|-----------|--------------|
| **Altitude discipline** | Std deviation of altFt during cruise. ≤100 ft = 100, 101–300 ft = linear 100→60, >300 ft = linear 60→0 |
| **Bank discipline** | % cruise rows with \|bank\| ≤ 30°. Each second > 45° in cruise = additional −2 pts |
| **Speed discipline** | % flight rows with estimated IAS < Vno. Each second within 10 kt of Vne = −5 pts |
| **DMMS discipline** | 0 violations = 100. Each violation: −20 pts. Violation during approach/pattern phase: −40 pts. Floor = 0 |
| **Descent management** | % descent rows with sink rate < 1,500 fpm. Sustained >1,500 fpm (>10s) = −10 pts each |

### 6.3 Approach (per segment, averaged across all approach segments)

| Sub-score | Scoring Logic |
|-----------|--------------|
| **Stabilization** | Last 500 ft AGL: each second with \|bank\| > 5° OR IAS outside Vref ±10 kt OR sink rate > 1,000 fpm = −3 pts |
| **Centerline deviation** | RMS lateral deviation from runway centerline during rollout (GPS vs. NASR runway heading). ≤25 ft = 100, linear to 0 at 150 ft |
| **Sink rate** | Mean fpm from FAF to threshold vs. expected for 3° glidepath at approach speed. Within 10% = 100 |

---

## 7. Event Detection

Events appear as colored ticks on the scrubber bar and as rows in the event list panel.

| Event Type | Level | Trigger |
|-----------|-------|---------|
| `DMMS_VIOLATION` | 🔴 Red | IAS < DMMS+5 AND \|bank\| > 15° |
| `CHT_DANGER` | 🔴 Red | Any CHT > danger threshold |
| `CHT_CAUTION` | 🟠 Orange | Any CHT > caution threshold |
| `RED_BOX` | 🔴 Red | pctPower > 65% AND \|pctFromPeak\| < 50°F |
| `ML_ANOMALY` | 🟣 Purple | ml_anomaly = 1 (engine ML flag) |
| `ML_SCORE_HIGH` | 🟣 Purple | ml_score > 0.8 sustained 10s |
| `CARB_ICE_RISK` | 🟠 Orange | carbTemp in 32–50°F range sustained 30s |
| `NO_DMMS_CONDITION` | 🟠 Orange | Operating_Condition empty during cruise > 60s |
| `UNSTABILIZED_APPROACH` | 🟠 Orange | Any stabilization criterion broken inside 500 ft AGL |
| `BANK_EXCEEDANCE` | 🟠 Orange | \|bank\| > 45° in cruise |
| `SPEED_EXCEEDANCE` | 🔴 Red | Estimated IAS > Vno |
| `SINK_RATE_HIGH` | 🟠 Orange | Sink rate > 1,500 fpm sustained 10s in descent |

---

## 8. UI Layout

### Overall Structure (landscape orientation)

```
┌─────────────────────────────────────────────────────────────────────┐
│ HEADER                                                               │
│ KLKR → KGSP · 2026-05-11 · Block 1h22m · Air 1h17m · 142 nm       │
│ OUT 13:42Z  OFF 13:51Z  ON 15:08Z  IN 15:13Z                        │
│ KLKR @13:51Z: 30012KT 10SM FEW045 22/14 A3002                       │
│ KGSP @15:08Z: 27008KT 10SM SCT035 BKN080 21/13 A2998               │
│                           [AI REVIEW]  [EXPORT GPX]  [NOTES]        │
├─────────────────────────────┬───────────────────────────────────────┤
│                             │ SCORECARD (collapsible)               │
│                             │ Overall ████████░░ 74                 │
│                             │ Engine Mgmt  ██████░░ 68  [▶]         │
│                             │ Airmanship   ████████  81  [▶]        │
│         MAP                 │ Approach     ██████░░ 62  [▶]         │
│  (Leaflet, color-coded      │ View: [GRADES] [DATA] [EVENTS]        │
│   track, aircraft marker)   ├───────────────────────────────────────┤
│                             │ CHARTS (tabbed)                       │
│                             │ [Alt/Speed] [EGT] [CHT] [ML] [Fuel]  │
│                             │ ┌─────────────────────────────────┐  │
│                             │ │  time-series with cursor line   │  │
│                             │ └─────────────────────────────────┘  │
├─────────────────────────────┴───────────────────────────────────────┤
│ ◀ ▶  ──────────●────────────────────────  [1×][2×][5×][10×]        │
│ ▲▼ event ticks                TIME: 14:32:10Z      [EVENT LIST]     │
└─────────────────────────────────────────────────────────────────────┘
```

### Map Panel (left ~50%)
- Track colored by selectable parameter: `[ML SCORE] [CHT] [ALT] [SPEED]`
- Color scale: green→yellow→red for the selected channel
- Aircraft marker (triangle) moves with scrubber
- Phase boundary dots on track (colored by phase type)
- Tap any track point to jump scrubber to that time

### Scorecard Panel (top-right, collapsible)
- Overall score with color-coded bar
- Three category rows, each expandable to show sub-scores
- View toggles: GRADES / DATA / EVENTS — all independent checkboxes

### Charts Panel (bottom-right, tabbed)
- **Alt/Speed**: GPS altitude (solid), GS (solid), estimated TAS (dashed), estimated IAS (dotted). Vno and Vne reference lines.
- **EGT**: All 4 cylinders + spread. Peak EGT reference line.
- **CHT**: All 4 cylinders. Caution and danger reference lines.
- **ML**: ml_score line + ml_anomaly markers.
- **Fuel**: Fuel flow (GPH) + Gallons remaining.
- Vertical cursor line synced to scrubber. Scrubbing moves cursor.

### Scrubber / Playback Bar (full-width bottom)
- Timeline slider (full flight duration)
- Play / pause button
- Speed selector: 1× / 2× / 5× / 10×
- Zulu time display at cursor position
- Colored event ticks on slider track (red/orange/purple)
- EVENT LIST button opens a scrollable chronological event panel

### Notes Panel (modal)
- Free-text textarea, saved to `{filename}.notes.txt` on the server
- Loaded automatically on next open

### AI Review Panel (collapsible, below scorecard)
- Shown after [AI REVIEW] tap
- 3–5 paragraph natural-language narrative from Claude
- Cached to `{filename}.review.json` — not regenerated unless pilot taps [REFRESH]

---

## 9. External Data & Caching

All external fetches are made server-side (Python). Results cached in `~/.flytab-debrief/cache.sqlite` by (station, date) key.

| Source | Endpoint | Cache TTL |
|--------|----------|-----------|
| AWC winds aloft | `aviationweather.gov/api/data/windtemp` | 6 hours (tied to forecast cycle) |
| AWC METAR | `aviationweather.gov/api/data/metar` | 1 hour |
| FlyTab NASR (airport elev, runway hdg) | `192.168.1.77:8090/api/airports/{icao}` | 24 hours |

If AWC is unreachable or returns no data for the flight time, TAS/IAS are omitted from the display with a note: *"Wind data unavailable — airspeed estimates not shown."* All other scoring proceeds without TAS/IAS-dependent checks (speed discipline and DMMS are flagged as *"unscored — airspeed data required"*).

---

## 10. Claude API Integration

### Endpoint
`POST /api/claude` on the debrief server. API key stored in `ANTHROPIC_API_KEY` environment variable on the home machine — never exposed to the browser.

### Model
`claude-sonnet-4-6` with prompt caching (`cache_control: {"type": "ephemeral"}`) on the system prompt.

### System Prompt (cached)
> You are an experienced CFI and A&P mechanic reviewing a post-flight data debrief for an IFR-rated pilot flying an experimental RV-9A with a Lycoming O-360 A1A engine. Provide honest, specific, actionable feedback in 3–5 paragraphs. Cover: what went well, what to watch, specific engine management observations, and any safety items. Reference specific times and values from the data. Be direct — this pilot has 1000+ hours and doesn't need hand-holding.

### Payload (condensed, ~2–3 KB)
```json
{
  "flight": "KLKR→KGSP",
  "date": "2026-05-11",
  "aircraft": "RV-9A N194JT, Lycoming O-360 A1A",
  "oooi": { "outZ": "13:42", "offZ": "13:51", "onZ": "15:08", "inZ": "15:13" },
  "duration": { "blockMin": 91, "airMin": 77, "distNm": 142 },
  "conditions": {
    "depMetar": "KLKR 301351Z 30012KT 10SM FEW045 22/14 A3002",
    "destMetar": "KGSP 301451Z 27008KT 10SM SCT035 BKN080 21/13 A2998",
    "avgHeadwindKt": 12,
    "avgTasKt": 147,
    "avgIasKt": 131
  },
  "scores": { "overall": 74, "engineMgmt": 68, "airmanship": 81, "approach": 62 },
  "events": [
    { "timeMin": 32, "type": "CHT_CAUTION", "detail": "CHT3 reached 392°F for 45s" }
  ],
  "phaseStats": {
    "climb":   { "durationMin": 9,  "avgCht": 340, "avgEgt": 1420, "climbFpm": 850 },
    "cruise":  { "durationMin": 58, "avgCht": 355, "avgEgt": 1380, "avgPctPower": 68, "avgFuelFlow": 8.4, "dmmsMaintained": true },
    "descent": { "durationMin": 8,  "avgSinkFpm": 620 },
    "approach":{ "durationMin": 4,  "stabilizedPct": 78, "centerlineFt": 42 }
  },
  "dmmsViolations": 0,
  "redBoxSeconds": 0,
  "carbIceSeconds": 0
}
```

### Output
Natural-language narrative displayed in the AI Review panel. Saved to `{filename}.review.json` alongside the CSV. Not regenerated unless pilot explicitly taps [REFRESH AI REVIEW].

---

## 11. Export

### GPX Export
`[EXPORT GPX]` button generates a GPX 1.1 file containing the flight track with altitude and speed extensions. Triggers browser download. Produced client-side from the FlightData object.

### Future: Training Dataset Export
Each scored flight automatically appends a compact JSON record to `~/.flytab-debrief/training-log.jsonl`:
```json
{ "date": "2026-05-11", "route": "KLKR-KGSP", "scores": {...}, "phaseStats": {...}, "eventCounts": {...} }
```
This accumulates over time as a training dataset for future model development.

---

## 12. Server API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/flights` | JSON array of filenames in `~/flights`, newest first |
| GET | `/api/flights/{name}` | Stream CSV file content |
| GET | `/api/health` | `{"ok": true}` — used by FlyTab for reachability check |
| POST | `/api/claude` | Body: `{payload: object}`. Proxies to Claude API. Returns `{narrative: string}` |
| POST | `/api/winds` | Body: `{lat, lon, altFt, utc}`. Returns interpolated wind vector + temp |
| POST | `/api/metar` | Body: `{icao, utc}`. Returns closest METAR observation to given time |
| GET | `/api/notes/{name}` | Read notes for a flight |
| PUT | `/api/notes/{name}` | Save notes for a flight |
| GET | `/api/review/{name}` | Read cached AI review JSON |
| PUT | `/api/review/{name}` | Save AI review JSON |

---

## 13. File Structure

```
flytab-debrief/
├── CLAUDE.md
├── index.html                   Single-page entry point
├── js/
│   ├── app.js                   Main controller — wires all modules
│   ├── csv-parser.js            Parse 1Hz CSV → FlightData typed arrays
│   ├── oooi.js                  Derive Out/Off/On/In from CSV + field elevations
│   ├── flight-physics.js        Wind triangle TAS, density IAS, DMMS
│   ├── scorer.js                Rule-based scoring — all three categories
│   ├── event-detector.js        Scan FlightData → array of Event objects
│   ├── replay.js                Leaflet map replay, scrubber, playback
│   ├── charts.js                Chart.js time-series panels
│   ├── claude-review.js         Build payload, call /api/claude, render
│   └── gpx-export.js            GPX 1.1 export from FlightData
├── css/
│   └── style.css                Cockpit design tokens + all component styles
├── server/
│   └── debrief-server.py        Python HTTP server
├── systemd/
│   └── flytab-debrief.service   systemd unit (install to /etc/systemd/system/)
├── start-debrief.sh             Manual start (development)
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-05-31-flight-replay-design.md   (this file)
```

---

## 14. Open Questions / Future Work

- **Crosswind scoring**: Current spec contextualizes crosswind but doesn't score it — data is available (METAR + NASR runway heading). Could be added as an Approach sub-score in a future iteration.
- **IFR approach FAF scoring**: Requires CIFP approach plate data (runway + FAF altitude per approach type). Data exists in fly-pipeline; integration adds complexity. Deferred to Phase 2.
- **Mobile debrief**: If the pilot wants to review flights away from home WiFi, the natural upgrade path is hosting on `flywhere.app` with CSV upload. No architectural changes to this spec required — just a new deployment target.
- **Training dataset / future ML**: The `training-log.jsonl` accumulates per-flight scores from day one. When enough data exists, a personalized performance trend model can be trained. No action required now.
- **Debrief sharing**: Share a debrief with a CFI — could be implemented as a static HTML export or a `flywhere.app` upload. Deferred.
