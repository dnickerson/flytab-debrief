# flytab-debrief UI Enhancements Design

**Date:** 2026-06-01  
**Status:** Approved  
**Reference:** ForeFlight Track Logs (screenshots 2026-06-01)  
**Scope:** Baked into initial build — not a Phase 2 layer

---

## 1. Design Philosophy

The ForeFlight Track Logs interface — designed by a professional UI/UX team — is the visual north star. The layout is adapted, not cloned, to accommodate flytab-debrief's unique content: engine management data (EGT, CHT, fuel flow, CHT rate of change) and an AI narrative review that ForeFlight does not have.

Three principles drive every layout decision:

1. **No dead space** — the score panel is always populated. Overall score dials when nothing is selected; live parameter rationale when the scrubber is moving.
2. **Time-synchronization** — the scrubber drives everything: map position, traffic markers, instrument cluster values, score panel content, and phase sidebar highlight.
3. **Density on demand** — traffic labels, chart overlays, and engine fields default to a clean readable state; sliders let the pilot surface more detail when needed.

---

## 2. Overall Page Structure

### 2.1 Tab Layout

Three top-level tabs in a single 48px header bar:

```
[KLKR → KPYG  2026-05-11]    [Flight Track | Engine | AI Review]   [V-speeds ⚙]
```

- Flight name and date on the left
- Tab navigation center-right
- V-speeds configuration button far right
- No secondary header row — all navigation lives in one bar

### 2.2 Three-Panel Shell (Flight Track and Engine tabs)

```
┌──────────┬──────────────────────────────┬──────────────────────────────┐
│ PHASE    │                              │                              │
│ SIDEBAR  │    MAIN PANEL                │   SCORE / RATIONALE PANEL    │
│ (220px)  │    (~55% remaining width)    │   (~45% remaining width)     │
│          │                              │                              │
├──────────┴──────────────────────────────┴──────────────────────────────┤
│ MULTI-OVERLAY CHART  (full width, ~30% viewport height)                │
└─────────────────────────────────────────────────────────────────────────┘
```

The chart sits full-width below both the main panel and the score panel. This gives the chart maximum horizontal resolution — more x-axis pixels than ForeFlight's layout, which constrains the chart to the center column only.

---

## 3. Phase Sidebar

Shared across Flight Track and Engine tabs. Always visible. Provides phase-level score index and scrubber navigation.

### 3.1 Phase Row Layout

```
┌────────────────────┐
│ ▶  Departure       │  phase icon + name
│    8.2 nm  12 min  │  distance + duration
│    Score: [74] ██  │  score badge + color bar
└────────────────────┘
```

### 3.2 Phase Icons

| Phase | Icon |
|-------|------|
| Departure / Climb | ▶ |
| Level / Cruise | → |
| Descent | ▼ |
| Turn to Final | ↙ |
| Final / Approach | → |
| Landing / Ground | ■ |

### 3.3 Score Badge Colors

| Score | Color | Design token |
|-------|-------|--------------|
| ≥ 80 | Green | `--color-success` `#1a8c35` |
| 60–79 | Amber | `--color-caution` `#b87000` |
| < 60 | Red | `--color-danger` `#cc2222` |

### 3.4 Behavior

- The phase whose time range contains the current scrubber position is highlighted with the accent border (`--accent #0066cc`)
- Clicking any phase jumps the scrubber to the first second of that phase and zooms the chart x-axis to that phase's time range
- Zoom resets to full flight view via the chart's `[Zoom ⟳]` reset button

---

## 4. Flight Track Tab — Main Panel (Sectional Map)

### 4.1 Map Base

Leaflet sectional tile map. Flight path rendered as a polyline color-coded by phase, using the same score-color scheme as the sidebar badges.

### 4.2 Own-Ship Marker

Animated aircraft icon tracking the scrubber position. Rotates to current course heading. No change from existing replay spec.

### 4.3 ADS-B Traffic Markers

Traffic markers are time-synchronized to the 5-second NDJSON snapshots. They appear, move, and disappear as the replay scrubber progresses.

**Marker anatomy:**

```
      ✈  AAL123         callsign label (N-number or flight number)
      8,500ft  240kt    altitude + ground speed subtitle
```

- Aircraft icon rotated to heading
- Altitude-relative color coding:
  - Amber — within 1,000 ft of own-ship (highest awareness)
  - Blue — more than 1,000 ft above own-ship
  - Grey — more than 1,000 ft below own-ship
- Tap/click expands a popup adding squawk code and ICAO hex
- When a target triggers `TRAFFIC_PROXIMITY` (horiz < 3 nm AND vert < 1,000 ft), the marker pulses amber and a `TRAFFIC_PROXIMITY` event surfaces in the score/rationale panel with bearing and closest approach distance

### 4.4 Traffic Display Menu

Accessible via a `✈ ⚙` icon button in the map panel corner. Opens a popover with toggle sliders:

| Field | Default |
|-------|---------|
| Callsign | On |
| Altitude | On |
| Ground speed | Off |
| Heading (numeric) | Off |
| Squawk | Off |
| Altitude band color | On |
| Proximity ring (pulse) | On |

- Icon always rotates to heading regardless of the heading toggle — the toggle controls the numeric degree label only
- Settings persist to `localStorage`

### 4.5 Absent Traffic File

When no `_traffic.ndjson` companion file is present, all traffic features are silently absent. No error state shown.

---

## 5. Score / Rationale Panel

Shared across Flight Track and Engine tabs. Updates continuously as the scrubber moves.

### 5.1 Header

```
DEPARTURE                    Score: [74]
12:34:07Z
```

Phase name and score update as the scrubber crosses phase boundaries. Zulu time shown at current scrubber position.

### 5.2 Parameter Rows

Three sections: AIRMANSHIP, ENGINE, APPROACH.

```
AIRMANSHIP
✓ IAS within Vno          95 kts
⚠ Bank discipline         34°    >30°     threshold shown inline
✗ DMMS margin             OK
✓ Altitude stable         ±80 ft

ENGINE
⚠ CHT caution             388°F
⚠ CHT3 rate of change     +38°/min   (limit 50°/min)
✓ EGT balance             42°F spread
✓ Mixture                 ROP
✓ Oil temp                182°F
✓ Fuel efficiency         nominal

APPROACH                   (n/a — grayed during non-approach phases)
```

**Display rules:**
- Passing parameters render in `--text-muted` (`#888888`) — they don't demand attention
- Caution parameters render in `--color-caution` (`#b87000`) with actual value + threshold
- Failing parameters render in `--color-danger` (`#cc2222`)
- Categories not relevant to the current phase are collapsed with a "(n/a)" label

### 5.3 Events Strip

Bottom of the panel — events within ±30 seconds of the current scrubber position:

```
EVENTS AT THIS MOMENT
⚠ 12:33:52Z  CHT3 caution 388°F
⚠ 12:31:14Z  CHT3 rate of change +62°/min
```

---

## 6. Engine Tab — Main Panel (Instrument Cluster)

The map is replaced by a live engine instrument cluster showing values at the current scrubber position.

### 6.1 Cylinder Grid

4-cylinder layout — EGT row above CHT row, cylinders left to right:

```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ EGT 1        │ │ EGT 2        │ │ EGT 3        │ │ EGT 4        │
│ 1340°F       │ │ 1380°F       │ │ 1290°F       │ │ 1360°F       │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ CHT 1        │ │ CHT 2        │ │ CHT 3        │ │ CHT 4        │
│ 340°F        │ │ 352°F        │ │ 388°F  ▲  ⚠ │ │ 344°F        │
│ +12°/min     │ │ +8°/min      │ │ +38°/min ⚠  │ │ +10°/min     │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

- Hottest EGT and hottest CHT tiles highlighted with amber/red border
- Each CHT tile shows: current temperature + rate of change (°F/min)
- Rate of change in amber when > 50°F/min at > 65% power

### 6.2 Engine Strip

Below the cylinder grid:

```
RPM 2450 · FF 8.2 gph · 65% pwr · Op: ROP · Volts 13.8 · Fuel rem: 28.4 gal
```

All values time-synchronized to scrubber.

### 6.3 CHT Rate of Change — Specification

- **Computation:** 10-second rolling average: `(CHT[t] - CHT[t-10]) × 6` → °F/min. Smooths 1Hz noise without amplifying transients.
- **Alert threshold:** > 50°F/min when power > 65%
- **Event:** Sustained violation > 30 seconds triggers `CHT_ROC_CAUTION` event
- **Scoring:** Each second of violation at > 65% power deducts from Engine Management score, proportional to excess rate
- **Chart overlay:** CHT ROC rendered as dashed lines per cylinder; horizontal 50°F/min reference line drawn when overlay is active. Violation periods are shaded red on the phase color band regardless of whether the CHT ROC overlay toggle is on — the shading is computed independently of the overlay display state.

---

## 7. Multi-Overlay Chart Panel

Full-width below the three-panel area. Shared across Flight Track and Engine tabs (different default overlays per tab).

### 7.1 Toggle Pills

```
Flight Track tab: [Alt MSL ✓] [Alt AGL ✓] [IAS ✓] [GS ✓] [Bank ✓] [Pitch ✓] [Zoom ⟳]
Engine tab:       [EGT 1-4 ✓] [CHT 1-4 ✓] [CHT ROC ○] [Fuel Flow ✓] [MP ✓] [RPM ○] [Zoom ⟳]
```

### 7.2 Dual Y-Axes

- Left axis: altitude (ft) and speed (kts) — shared scale
- Right axis: bank and pitch (±60°) — prevents attitude values from collapsing to a flat line against the altitude scale

### 7.3 AGL Altitude

- Derived from GPS MSL altitude minus terrain elevation at each GPS coordinate (SRTM data via server)
- Labeled *est.* on the toggle pill
- Useful for visualizing approach profile relative to terrain

### 7.4 IAS Label

- Labeled *est.* on the toggle pill — computed via wind triangle + density correction, not directly measured

### 7.5 Phase Color Band

- A colored band along the x-axis bottom edge segments the full flight into phases
- Each segment uses the phase's score color (green/amber/red)
- Problem phases are immediately visible before any phase is clicked

### 7.6 Scrubber

- Vertical needle draggable across the full timeline
- Dragging drives: map position, traffic markers, instrument cluster values, score panel content, phase sidebar highlight — simultaneously
- Clicking a phase in the sidebar zooms the chart x-axis to that phase's time range
- `[Zoom ⟳]` resets to full flight view

---

## 8. V-Speeds Configuration

Accessible via the `[V-speeds ⚙]` button in the header bar. Modal dialog.

Two columns per speed: **Default (from aircraft-config.json)** and **Override (user-editable)**:

| Speed | Description |
|-------|-------------|
| Vr | Rotation speed |
| Vs0 | Stall, flaps down |
| VS1 | Stall, flaps up |
| Vx | Best angle of climb |
| Vy | Best rate of climb |
| Vcm | Recommended touchdown speed |
| Vref | Landing reference speed |
| Vne | Never exceed speed |
| Vmax | Max ground speed |

- Overrides are saved to `localStorage` keyed by aircraft tail number
- Scoring engine uses override values when present, defaults otherwise

---

## 9. AI Review Tab

Full-width — no sidebar, no map. A reading experience.

### 9.1 Top Section (two columns)

**Left — Flight Summary:**
```
KLKR → KPYG
2026-05-11  12:22Z
Block: 91 min   Air: 77 min
Avg headwind: 12 kt
Dep METAR: ...
Dest METAR: ...
```

**Right — Score Breakdown:**
```
Engine Mgmt    [74]  ████████░░
Airmanship     [81]  █████████░
Approach       [62]  ███████░░░
Overall        [72]  ████████░░

Top Events
⚠ CHT3 caution 45s           12:33Z
⚠ CHT3 rate +62°/min         12:31Z
✗ Bank >30° on turn to final  13:44Z
```

Top Events shows the 3 highest-severity events only.

### 9.2 AI Narrative

- Triggered by `[Generate ▶]` button — not automatic on load
- If `{flightname}.review.json` exists, the cached narrative renders immediately without an API call
- Narrative structured by category: **Engine Management**, **Airmanship**, **Approach** — each collapsible independently
- Model: `claude-sonnet-4-6` with prompt caching on the system prompt
- Payload sent to Claude: condensed ~2–3 KB JSON (scores, events, phase stats, conditions) — never raw CSV

---

## 10. Summary of Enhancements vs Original Spec

| Enhancement | Where |
|-------------|-------|
| Three-panel shell (sidebar + main + score panel) | Both tabs |
| Phase sidebar with score badges, distance, duration | Both tabs |
| Score / rationale panel — time-synchronized to scrubber | Both tabs |
| Phase-color-coded flight path polyline on map | Flight Track |
| ADS-B traffic markers with callsign, altitude, speed, heading | Flight Track |
| Traffic display menu with per-field toggle sliders | Flight Track |
| Multi-overlay chart with dual y-axes and phase color band | Both tabs |
| AGL altitude overlay (estimated) | Flight Track chart |
| IAS overlay (estimated) | Flight Track chart |
| Engine instrument cluster (EGT/CHT grid, engine strip) | Engine tab |
| CHT rate of change per cylinder (°F/min, 50°/min threshold) | Engine tab |
| CHT ROC scoring, events, and chart overlay | Engine tab |
| V-speeds configuration modal with user overrides | Header |
| AI Review tab with summary, score breakdown, collapsible narrative | AI Review |
| Cached AI review (no regeneration on reopen) | AI Review |
| Traffic proximity pulse + score panel event | Flight Track |
| localStorage persistence for traffic display and V-speed overrides | Both |
