# CLAUDE.md — flytab-debrief

## What This Is

`flytab-debrief` is a standalone post-flight debrief web application for experimental aircraft. It reads 1Hz CSV flight recordings produced by FlyTab, parses them into a rich data model, and presents a pilot performance review covering engine management, airmanship, and approach quality — with an optional AI-generated narrative via Claude API.

This is a **separate repo** from FlyTab. It shares no code with FlyTab but references FlyTab's `aircraft-config.json` and `cockpit-config.json` for aircraft performance data and thresholds.

## Architecture

### Stack
- **Frontend**: Vanilla JS + Chart.js + Leaflet — no bundler, no framework. `index.html` loads all modules via `<script>` tags. Load order matters.
- **Server**: Python HTTP server (`server/debrief-server.py`) on port **8092**, bound to `0.0.0.0` (accessible via both home WiFi and Tailscale IP).
- **Process manager**: systemd service (`systemd/flytab-debrief.service`) — starts automatically on boot, no manual `bash start-debrief.sh` required.

### Data Flow
```
FlyTab (Android tablet)
  └─ FlightUpload (SFTP) ──▶ ~/flights/YYYYMMDD_DEP-DEST.csv             (home machine)
                         ──▶ ~/flights/YYYYMMDD_DEP-DEST_traffic.ndjson  (companion, when present)
                                  │
debrief-server.py (:8092) ──reads─┘
  │  GET /api/flights          list {name, hasTraffic} objects from ~/flights, newest first
  │  GET /api/flights/{name}   stream a specific CSV or _traffic.ndjson
  │  POST /api/claude          proxy to Claude API (API key server-side)
  │  POST /api/winds           fetch + cache winds aloft from AWC
  │  POST /api/metar           fetch + cache historical METARs from AWC
  └─ serves static index.html / js / css
```

### Access
- Home WiFi: `http://192.168.1.77:8092`
- Tailscale: `http://<tailscale-ip>:8092`
- URL with flight pre-selected: `http://<host>:8092/?file=YYYYMMDD_DEP-DEST.csv`

### FlyTab Integration

**Logbook DEBRIEF button** (`web/cockpit/logbook.js`): Opens debrief URL in the system browser with `?file=` parameter. Base URL from new `debriefServer.base` key in `web/cockpit-config.json`. Button grayed out if server unreachable.

**ADS-B Traffic Recording** (`web/cockpit/flight-recorder.js`): New 5-second interval snapshots `stratuxClient.traffic` and appends one NDJSON line to a companion file `YYYYMMDD_DEP-DEST_traffic.ndjson` in `/flights/` via NanoHTTPD PUT+append. Fields per target: `icao`, `callsign`, `lat`, `lon`, `altFt`, `speedKts`, `heading`, `squawk`. File renamed in sync with CSV on stop.

**FlightUpload** (`web/cockpit/flight-upload.js`): Uploads `_traffic.ndjson` alongside each CSV. If traffic file is absent (older recordings), CSV-only upload proceeds normally.

## Key Files

| Path | Purpose |
|------|---------|
| `index.html` | Single-page entry point |
| `js/app.js` | Main controller — wires all modules |
| `js/csv-parser.js` | Parses 1Hz CSV → FlightData typed arrays |
| `js/traffic-parser.js` | Parses `_traffic.ndjson` → TrafficData, computes proximity events |
| `js/flight-physics.js` | Wind triangle TAS, density correction IAS, DMMS calculation |
| `js/scorer.js` | Rule-based scoring engine — engine mgmt + airmanship + approach |
| `js/event-detector.js` | Scans FlightData + TrafficData → Event array |
| `js/replay.js` | Map replay — Leaflet own-ship marker, traffic markers, scrubber, playback |
| `js/charts.js` | Chart.js time-series panels (altitude/speed, EGT, CHT, ML, fuel) |
| `js/claude-review.js` | Builds condensed payload, calls /api/claude, renders narrative |
| `js/oooi.js` | Derives Out/Off/On/In timestamps from CSV data |
| `css/style.css` | All styles — cockpit design tokens (see below) |
| `server/debrief-server.py` | Python HTTP server with file API + proxies |
| `systemd/flytab-debrief.service` | systemd unit file |
| `start-debrief.sh` | Manual start script (development use) |

## CSV Format

Flight recordings are 1Hz CSV files from FlyTab's `FlightRecorder`. The header is:

```
Zulu_Time,MP,Oil Temp,Oil Pressure,Fuel Pressure,Volts,Amps,RPM,Fuel Flow,
Gallons Remaining,Fuel Level 1,Fuel Level 2,Carb Temp,GP 2,GP 3,Thermalcouple,
EGT 1,EGT 2,EGT 3,EGT 4,CHT 1,CHT 2,CHT 3,CHT 4,date,time_z,longitude,
latitude,altitude_ft,speed_kts,bank,pitch,acc_vert,course,EGT Spread,CHT Spread,
Max EGT,Final_Percent_Power,Operating_Condition,Percent,SFC,ml_phase,ml_score,
ml_anomaly,ml_latency_ms
```

Column index references (0-based):
- `speed_kts` = 29 (GPS ground speed — NOT airspeed)
- `altitude_ft` = 28 (GPS MSL altitude)
- `bank` = 30, `pitch` = 31, `course` = 33
- `Operating_Condition` = 38 (ROP / LOP / empty)
- `ml_phase` = 41 (ground / climb / cruise / descent / approach / landing)
- `ml_score` = 42, `ml_anomaly` = 43

## Traffic NDJSON Format

Companion file `YYYYMMDD_DEP-DEST_traffic.ndjson` in `~/flights/`. One line per 5-second snapshot. `t` = seconds from flight start.

```
{"t":0,"targets":[{"icao":"A12345","cs":"AAL123","lat":35.12,"lon":-80.23,"altFt":8500,"spdKts":240,"hdg":185,"squawk":"3421"}]}
{"t":5,"targets":[...]}
```

**Size estimate:** 2h flight × 720 snapshots × 25 targets × ~90 bytes ≈ 1.6 MB.

**Absent for older recordings** — all code paths that consume TrafficData must handle `null` gracefully. Traffic features are silently hidden when the file is not present.

### Proximity Analysis (js/traffic-parser.js)

For each traffic snapshot, compute separation from own-ship at the nearest matching CSV row (round `tSec` to nearest integer → CSV row index):

```javascript
horizNm = haversineNm(ownLat, ownLon, target.lat, target.lon)
vertFt  = Math.abs(ownAltFt - target.altFt)
```

Flag `TRAFFIC_PROXIMITY` event when `horizNm < 3 && vertFt < 1000`. Record the closest approach across the entire flight as a single `closestTraffic` scalar for the AI review payload.

Traffic marker altitude coloring on map:
- `vertFt < 1000`: **amber** (same altitude band — highest awareness)
- `target.altFt > ownAltFt + 1000`: **blue** (above)
- `target.altFt < ownAltFt - 1000`: **grey** (below)

## Aircraft Data

Pull aircraft performance data from FlyTab's `aircraft-config.json` (read once at startup if the FlyTab home server is reachable, or from a local cached copy):

- `vs1Kias` — clean stall speed (used for DMMS = 1.404 × VS1)
- `vnoKias`, `vneKias` — speed limits for IAS discipline scoring
- `vrefKias` — approach reference speed (used in approach stability scoring)
- `vxKias`, `vyKias` — climb performance reference
- `maxChtCaution`, `maxChtDanger` — CHT thresholds
- `maxEgtCaution`, `maxEgtDanger` — EGT thresholds
- `typicalSfc` — expected SFC at cruise for fuel efficiency scoring

## Key Algorithms

### OOOI Detection (js/oooi.js)
Derived from CSV data:
- **Out**: first row index where RPM ≥ 500 sustained for 3 consecutive rows (engine start)
- **Off**: first row after Out where `altitude_ft > departure_field_elev + 200` AND `speed_kts > 40`
- **On**: last row where `altitude_ft` transitions from above `arrival_field_elev + 200` back below it while `speed_kts < 100`
- **In**: last row where RPM > 0 (final shutdown)
- Departure/arrival field elevations: looked up from NASR via FlyTab home server at startup, or estimated from first/last GPS cluster in CSV

### Wind Triangle → TAS (js/flight-physics.js)
```
GS_north = GS × cos(true_course_rad)
GS_east  = GS × sin(true_course_rad)
W_north  = WS × cos((WD + 180°) × π/180)   // wind vector direction of travel
W_east   = WS × sin((WD + 180°) × π/180)
TAS_north = GS_north − W_north
TAS_east  = GS_east  − W_east
TAS = √(TAS_north² + TAS_east²)
```
Wind data: AWC `windtemp` endpoint for forecast cycle valid at flight Off time. Interpolate linearly between the two bracketing pressure altitude levels. Label all TAS values as *estimated*.

### Density Correction → IAS (js/flight-physics.js)
```
pressure_alt = gps_alt_ft − (29.92 − altimeter_inHg) × 1000
OAT_K        = winds_aloft_temp_C + 273.15   // interpolated to aircraft altitude
σ            = [(1 − 6.8755e-6 × pressure_alt)^5.2559] × [288.15 / OAT_K]
IAS          = TAS × √σ
```
Altimeter setting: linearly interpolated between departure and arrival METAR QNH across the flight. Label all IAS values as *estimated*.

### DMMS (js/scorer.js)
```
DMMS = 1.404 × VS1
```
Flag `DMMS_VIOLATION` when estimated IAS < (DMMS + 5 kt safety margin) AND |bank| > 15°. The +5 kt margin accounts for IAS estimation uncertainty. Always a red-level safety event.

### Phase Segmentation
Use the `ml_phase` column directly — the engine monitor has already classified each row as `ground / climb / cruise / descent / approach / landing`. Group consecutive rows with the same phase label into segments. Each approach segment gets its own score.

## Scoring System

All scores 0–100. Sub-scores averaged (unweighted) within each category. Overall score is the average of the three category scores.

### Engine Management Category
| Sub-score | Logic |
|---|---|
| CHT discipline | Deduct per second above caution threshold; heavy deduct per second above danger |
| EGT balance | Mean EGT spread during cruise; >50°F = caution, >100°F = danger |
| DMMS discipline | Covered under Airmanship — NOT this category |
| Mixture (Operating_Condition) | % cruise time with defined ROP or LOP condition; red box operation (>65% power within ±50°F peak EGT) = hard penalty |
| Oil temperature | % flight time within normal range |
| Carb ice exposure | Cumulative seconds in icing range (carbTemp 32–50°F) during at-risk power settings |
| Fuel efficiency | Actual avg SFC vs. aircraft-config expected SFC at recorded power setting |

### Airmanship Category
| Sub-score | Logic |
|---|---|
| Altitude discipline | Std deviation of altFt during cruise phase vs. ±200 ft tolerance |
| Bank discipline | % cruise time with \|bank\| > 30°; hard flag at > 45° |
| Speed discipline | % flight time with estimated IAS within Vno; flag any proximity to Vne |
| DMMS discipline | Any DMMS_VIOLATION = major deduction; violations in pattern/approach = near-failing |
| Descent management | Sustained sink rate > 1,500 fpm in descent phase |

### Approach Category (per approach segment, averaged)
| Sub-score | Logic |
|---|---|
| Stabilization | Last 500 ft AGL: \|bank\| < 5°, IAS within Vref ±10 kt, sink rate < 1,000 fpm |
| Centerline deviation | RMS lateral deviation from runway centerline (NASR runway heading + GPS) |
| Sink rate | Avg fpm from FAF to threshold vs. 3° glidepath expectation |
| Crosswind management | Crosswind component from METAR + NASR runway heading (context, not scored) |

## External Data Sources

| Source | What | How |
|---|---|---|
| AWC `windtemp` | Winds aloft forecast (speed, direction, temp per level) | Server proxies `https://aviationweather.gov/api/data/windtemp` |
| AWC `metar` | Historical METARs at dep/dest at Off/On times | Server proxies AWC dataserver |
| FlyTab home server (:8090) | Airport elevations, runway headings from NASR | Optional — used for OOOI refinement and centerline scoring |
| Claude API | AI narrative review | Server proxies with API key from environment variable |

Server-side caching: winds aloft and METARs are cached per (station, date) in a local SQLite file to avoid re-fetching on every debrief open.

## Claude API Integration

Model: `claude-sonnet-4-6` with prompt caching on the system prompt.

System prompt (cached): Establishes Claude as an experienced CFI and A&P mechanic reviewing post-flight data for an IFR-rated experimental aircraft pilot.

Payload sent (condensed, ~2–3 KB — never raw CSV):
```json
{
  "flight": "KLKR→KGSP",
  "date": "2026-05-11",
  "aircraft": "RV-9A N194JT, Lycoming O-360 A1A",
  "oooi": { "out": "...", "off": "...", "on": "...", "in": "..." },
  "duration": { "blockMinutes": 91, "airMinutes": 77 },
  "scores": { "engineMgmt": 68, "airmanship": 81, "approach": 62 },
  "conditions": { "depMetar": "...", "destMetar": "...", "avgHeadwindKt": 12 },
  "events": [ { "time": "0:32:10", "type": "CHT_CAUTION", "detail": "CHT3 392°F for 45s" } ],
  "phaseStats": { "climb": {...}, "cruise": {...}, "descent": {...}, "approach": {...} },
  "dmmViolations": 0,
  "redBoxSeconds": 0
}
```

AI review is saved to a `{flightname}.review.json` file alongside the CSV so it is not regenerated on every open.

## Design Token Standards

Use the same cockpit design system as FlyTab — sunlight-readable, high contrast:

```css
--bg-primary:     #ffffff
--bg-surface:     #f5f5f5
--text-primary:   #1a1a2e
--text-secondary: #444444
--text-label:     #666666
--text-muted:     #888888
--accent:         #0066cc
--border:         #e0e0e0
--color-success:  #1a8c35
--color-caution:  #b87000
--color-danger:   #cc2222
--color-info:     #0055bb
--font-instrument: (monospace/instrument font)
--font-ui:         (system UI font)
--touch-min:      56px
```

Chart.js cannot read CSS custom properties. Use hex values directly:
- Success: `#1a8c35`, Danger: `#cc2222`, Accent: `#0066cc`, Grid: `#b0b0b0`

## Development Notes

- No build step. Edit JS/HTML/CSS and reload the browser.
- Python server requires: `python3`, `sqlite3` (stdlib), `requests` (`pip install requests`)
- Claude API key: set `ANTHROPIC_API_KEY` environment variable on the home machine
- Flights directory: configurable via `FLIGHTS_DIR` env var, defaults to `~/flights`
- AWC calls are made server-side (no CORS constraint) — do NOT make AWC calls from the browser JS
- The server must handle CORS headers for `localhost` and Tailscale IP origins

## Relationship to Other Repos

| Repo | Relationship |
|------|-------------|
| `~/flytab` | Produces the CSV input files; gets a thin DEBRIEF button in logbook.js |
| `~/fly-pipeline` | Provides home server (port 8090) for NASR/runway data lookups |
| `flywhere/app` | Independent — no dependency; future: could host a cloud version |
