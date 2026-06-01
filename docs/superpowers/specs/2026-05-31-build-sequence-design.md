# flytab-debrief — Build Sequence Design

**Date:** 2026-05-31
**Author:** Dana Nickerson / Claude
**Status:** Approved for implementation planning
**Full spec:** `docs/superpowers/specs/2026-05-31-flight-replay-design.md`

---

## Overview

23 tasks across 5 phases. Each phase is independently runnable. Phase 2 is the primary milestone: a working flight replay in the browser against real data from `~/engine_analysis`. Phases 3–5 layer in scoring, AI review, and traffic replay on top of that working foundation.

A parallel FlyTab integration agent is developing in `~/flytab`:
- `FlightRecorder.js` — ADS-B traffic recording to `_traffic.ndjson`
- `FlightUpload.js` — companion ndjson upload alongside CSV
- `logbook.js` — DEBRIEF button opening `http://<host>:8092/?file=...`

The debrief app is designed to be independent of that work completing. Traffic features degrade gracefully when `_traffic.ndjson` is absent. The `/api/health` endpoint (Phase 1) lets FlyTab ping debrief server reachability before that work is done.

---

## Integration Decisions

### Development data
`FLIGHTS_DIR` env var defaults to `~/engine_analysis` during development (120+ real CSV files). Production default: `~/flights`.

### Map tiles
Leaflet tile source: `http://192.168.1.77:8090/tiles/sectional/{z}/{x}/{y}` (FlyTab home server at port 8090 serving `~/fly-pipeline/data/tiles/sectional/`). OSM fallback (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) when home server unreachable.

### Weather (AWC winds + METARs)
Python server-side proxy calls `https://flywhere.app/api/weather?type=windtemp&...` first (same endpoint FlyTab uses), falls back to direct AWC (`https://aviationweather.gov/api/data/windtemp`) if flywhere unreachable. Results cached in `~/.flytab-debrief/cache.sqlite` by (station, date) key.

### Aircraft config
Thresholds and V-speeds pulled from FlyTab home server at `http://192.168.1.77:8090/api/aircraft-config`. Cached locally. If unreachable, hardcoded RV-9A N194JT defaults apply.

### Traffic file format
FlyTab agent produces `_traffic.ndjson` (NDJSON, one line per 5-second snapshot). Current `~/engine_analysis` files use `_traffic.csv` (raw Stratux WS log, different schema) — these are NOT compatible and will be skipped by the traffic parser until FlyTab agent work lands.

---

## Phase 1 — Foundation

**Deliverable:** Browser loads the app, populates a flight dropdown from real CSV files, header renders OOOI times.

| # | Task | File(s) |
|---|------|---------|
| 1 | Python server skeleton — static file serving, `GET /api/flights` (returns `[{name, hasTraffic}]` newest first), `GET /api/flights/{name}`, `GET /api/health` | `server/debrief-server.py` |
| 2 | CSV parser — 1Hz CSV → FlightData typed arrays; reads all 44 columns per spec §3 | `js/csv-parser.js` |
| 3 | OOOI detection — Out/Off/On/In from CSV; field elev from `:8090/api/airports/{icao}`, fallback to GPS cluster | `js/oooi.js` |
| 4 | HTML shell + flight selector — dropdown populated from `/api/flights`, two-column layout skeleton, empty panel placeholders | `index.html` |
| 5 | Cockpit styles — design tokens, two-column grid, header strip, panel placeholders, scrubber bar skeleton | `css/style.css` |
| 6 | Dev launch + systemd — `FLIGHTS_DIR=~/engine_analysis` dev config; production systemd unit | `start-debrief.sh`, `systemd/flytab-debrief.service` |

---

## Phase 2 — Map Replay

**Deliverable:** Select any flight → see colored track on sectional → scrub through it with a moving own-ship marker and playback controls.

| # | Task | File(s) |
|---|------|---------|
| 7 | Full layout — two-column (map left ~50%, scorecard+charts right), full-width scrubber bottom, header OOOI+METAR strip, chart tab bar placeholders | `index.html`, `css/style.css` |
| 8 | Leaflet map + track — sectional tiles (`:8090`) with OSM fallback; track polyline colored by `ml_phase`; own-ship triangle marker | `js/replay.js` |
| 9 | Scrubber + playback — timeline slider, play/pause, 1×/2×/5×/10× speed, Zulu time display, event tick placeholders on slider track | `js/replay.js` |
| 10 | Main controller — flight load flow: select → fetch CSV → parse → OOOI → render header → init replay; wires all Phase 1+2 modules | `js/app.js` |
| 11 | Phase dots + track coloring — phase boundary markers on track; color scale per `ml_phase` label | `js/replay.js` |

---

## Phase 3 — Physics, Scoring & Charts

**Deliverable:** Full scored debrief report with time-series charts and event list.

| # | Task | File(s) |
|---|------|---------|
| 12 | Server weather proxies — `POST /api/winds` + `POST /api/metar`; calls flywhere.app first, direct AWC fallback; SQLite cache | `server/debrief-server.py` |
| 13 | Flight physics — wind triangle → estimated TAS; density correction → estimated IAS; DMMS threshold; all values flagged "estimated" | `js/flight-physics.js` |
| 14 | Scoring engine — engine mgmt, airmanship, approach; all sub-scores per spec §6; reads thresholds from aircraft-config | `js/scorer.js` |
| 15 | Event detector — scans FlightData + TrafficData → Event array per spec §7; null-safe on TrafficData | `js/event-detector.js` |
| 16 | Charts — Chart.js Alt/Speed, EGT, CHT, ML, Fuel panels; vertical cursor synced to scrubber; reference lines (Vno, Vne, CHT caution/danger) | `js/charts.js` |
| 17 | Scorecard panel — overall + three category scores; expandable sub-scores; GRADES/DATA/EVENTS view toggles; event list panel | `index.html`, `css/style.css`, `js/app.js` |

---

## Phase 4 — AI Review + Export

**Deliverable:** AI narrative review, GPX export, pilot notes.

| # | Task | File(s) |
|---|------|---------|
| 18 | Server additions — `POST /api/claude` proxy (API key server-side); `GET/PUT /api/notes/{name}`; `GET/PUT /api/review/{name}` | `server/debrief-server.py` |
| 19 | Claude review — build condensed payload per spec §10; call `/api/claude`; render narrative; cache to `{filename}.review.json`; [REFRESH] button | `js/claude-review.js` |
| 20 | GPX export + notes + training log — client-side GPX 1.1 download; notes modal (save/load via `/api/notes`); training log append to `~/.flytab-debrief/training-log.jsonl` | `js/gpx-export.js`, `js/app.js` |

---

## Phase 5 — Traffic Replay

**Deliverable:** ADS-B traffic targets shown on map at correct positions, proximity events flagged.
**Dependency:** FlyTab agent must land `_traffic.ndjson` recording in FlightRecorder before real traffic data exists. Phase 5 can be built against a synthetic fixture in the meantime.

| # | Task | File(s) |
|---|------|---------|
| 21 | Traffic parser — parse `_traffic.ndjson` → TrafficData; compute proximity events (horizNm, vertFt) per spec §3; null-safe throughout | `js/traffic-parser.js` |
| 22 | Server traffic endpoint — `GET /api/flights/{name}_traffic.ndjson`; `hasTraffic` flag in `/api/flights` response | `server/debrief-server.py` |
| 23 | Traffic map overlay — amber/blue/grey markers by relative altitude at scrubber time; tap popup (callsign, alt, speed, squawk, separation); TRAFFIC ON/OFF toggle | `js/replay.js` |

---

## File Structure

```
flytab-debrief/
├── CLAUDE.md
├── index.html
├── js/
│   ├── app.js
│   ├── csv-parser.js
│   ├── oooi.js
│   ├── flight-physics.js
│   ├── scorer.js
│   ├── event-detector.js
│   ├── traffic-parser.js
│   ├── replay.js
│   ├── charts.js
│   ├── claude-review.js
│   └── gpx-export.js
├── css/
│   └── style.css
├── server/
│   └── debrief-server.py
├── systemd/
│   └── flytab-debrief.service
├── start-debrief.sh
└── docs/
    └── superpowers/
        └── specs/
            ├── 2026-05-31-flight-replay-design.md
            └── 2026-05-31-build-sequence-design.md
```
