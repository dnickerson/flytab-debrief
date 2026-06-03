# UI Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform flytab-debrief from a 2-panel layout into a ForeFlight-inspired 3-panel, 3-tab interface with phase sidebar, time-synchronized score/rationale panel, multi-overlay chart, engine instrument cluster, traffic display controls, V-speeds modal, and AI Review tab.

**Architecture:** All changes land in the existing worktree at `.claude/worktrees/feat+core` on branch `worktree-feat+core`. The app is vanilla JS + Chart.js + Leaflet — no build step. A Python server at port 8092 serves static files and proxies APIs. The scrubber drives all panels simultaneously via `window._replay.seek(idx)`, `window._scorePanel.seek(idx)`, `window._phaseSidebar.seek(idx)`, and `window._engineCluster.seek(idx)`.

**Tech Stack:** Vanilla ES modules, Chart.js (UMD global), Leaflet (global), Python 3 + sqlite3 + requests

**Working directory for all tasks:** `/home/dananickerson/flytab-debrief/.claude/worktrees/feat+core`

---

### Task 1: CHT ROC — compute and attach to FlightData

**Files:**
- Modify: `js/scorer.js`

- [ ] **Step 1: Add `computeChtRoc` to scorer.js**

Add at the top of `js/scorer.js`, before the existing functions:

```javascript
// Computes CHT rate of change (°F/min) per cylinder using a 10-second rolling window.
// Returns array of 4 Float32Arrays, one per cylinder.
export function computeChtRoc(fd) {
    const n = fd.rows;
    const roc = [
        new Float32Array(n), new Float32Array(n),
        new Float32Array(n), new Float32Array(n),
    ];
    for (let c = 0; c < 4; c++) {
        for (let i = 0; i < n; i++) {
            const lookback = Math.min(i, 10);
            if (lookback < 2) { roc[c][i] = 0; continue; }
            roc[c][i] = (fd.cht[c][i] - fd.cht[c][i - lookback]) / lookback * 60;
        }
    }
    return roc;
}
```

- [ ] **Step 2: Add CHT ROC scoring sub-score inside `scoreEngineMgmt`**

In `js/scorer.js`, inside `scoreEngineMgmt(fd, thr)`, add after the `carbIceScore` block and before the final `subs` array:

```javascript
    // CHT ROC: deduct when any cylinder exceeds 50°F/min at >65% power
    let chtRocScore = 100;
    if (fd.chtRoc) {
        for (let i = 0; i < n; i++) {
            if (fd.pctPower[i] <= 65) continue;
            for (let c = 0; c < 4; c++) {
                const excess = Math.abs(fd.chtRoc[c][i]) - 50;
                if (excess > 0) chtRocScore -= excess * 0.05;
            }
        }
        chtRocScore = clamp(chtRocScore);
    }
```

Replace the existing `subs` line:
```javascript
    const subs = [chtScore, egtScore, mixtureScore, oilScore, carbIceScore, ffScore];
    return {
        overall: clamp(Math.round(avg(subs))),
        cht: chtScore, egtBalance: egtScore, mixture: mixtureScore,
        oilTemp: oilScore, carbIce: carbIceScore, fuelEfficiency: ffScore,
    };
```
With:
```javascript
    const subs = [chtScore, egtScore, mixtureScore, oilScore, carbIceScore, ffScore, chtRocScore];
    return {
        overall: clamp(Math.round(avg(subs))),
        cht: chtScore, egtBalance: egtScore, mixture: mixtureScore,
        oilTemp: oilScore, carbIce: carbIceScore, fuelEfficiency: ffScore,
        chtRoc: chtRocScore,
    };
```

- [ ] **Step 3: Verify in browser console**

Start server: `python3 server/debrief-server.py`
Load a flight, then in the browser console:
```javascript
// After flight loads, app.js attaches chtRoc to fd
console.log(window._fd?.chtRoc?.[2]?.slice(100, 110));
// Expected: Float32Array of ~10 values, small numbers near 0 or moderate positive/negative
```

- [ ] **Step 4: Commit**
```bash
git add js/scorer.js
git commit -m "feat(scorer): add CHT ROC computation and scoring sub-score"
```

---

### Task 2: CHT_ROC_CAUTION event detection

**Files:**
- Modify: `js/event-detector.js`

- [ ] **Step 1: Add CHT ROC event detection at the end of `detectEvents`, before the final sort**

In `js/event-detector.js`, add after the `// High sink rate` block and before `events.sort(...)`:

```javascript
    // CHT ROC caution: sustained >50°F/min at >65% power for 30s
    if (fd.chtRoc) {
        for (let cyl = 0; cyl < 4; cyl++) {
            let streak = 0;
            for (let i = 0; i < n; i++) {
                if (fd.pctPower[i] > 65 && Math.abs(fd.chtRoc[cyl][i]) > 50) {
                    streak++;
                    if (streak === 30) {
                        events.push(_ev(i, 'CHT_ROC_CAUTION', 'orange',
                            `CHT${cyl + 1} ${fd.chtRoc[cyl][i].toFixed(0)}°F/min`));
                    }
                } else {
                    streak = 0;
                }
            }
        }
    }
```

- [ ] **Step 2: Verify**

In browser console after loading a flight:
```javascript
window._events?.filter(e => e.type === 'CHT_ROC_CAUTION')
// Expected: [] if no violations, or array of event objects if CHT rose fast
```

- [ ] **Step 3: Commit**
```bash
git add js/event-detector.js
git commit -m "feat(events): add CHT_ROC_CAUTION detection (50°F/min at >65% pwr)"
```

---

### Task 3: Per-phase scoring

**Files:**
- Modify: `js/scorer.js`

- [ ] **Step 1: Add `scorePhases` function to scorer.js**

Add at the bottom of `js/scorer.js`:

```javascript
// Returns array of {name, startIdx, endIdx, durationSec, distNm, score}
// for each phase segment in fd.phases.
export function scorePhases(fd, thr, trafficData) {
    return fd.phases.map(seg => {
        const n = seg.endIdx - seg.startIdx + 1;
        if (n < 2) return { ...seg, score: 100, durationSec: n, distNm: 0 };

        // Distance for this segment
        let distNm = 0;
        for (let i = seg.startIdx + 1; i <= seg.endIdx; i++) {
            if (fd.lat[i] && fd.lon[i] && fd.lat[i-1] && fd.lon[i-1]) {
                const dLat = (fd.lat[i] - fd.lat[i-1]) * Math.PI / 180;
                const dLon = (fd.lon[i] - fd.lon[i-1]) * Math.PI / 180;
                const a = Math.sin(dLat/2)**2 +
                    Math.cos(fd.lat[i-1]*Math.PI/180)*Math.cos(fd.lat[i]*Math.PI/180)*Math.sin(dLon/2)**2;
                distNm += 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            }
        }

        // CHT violations in this phase
        let chtOk = 0;
        for (let i = seg.startIdx; i <= seg.endIdx; i++) {
            const maxCht = Math.max(fd.cht[0][i], fd.cht[1][i], fd.cht[2][i], fd.cht[3][i]);
            if (maxCht <= (thr.chtCaution || 380)) chtOk++;
        }
        const chtScore = clamp((chtOk / n) * 100);

        // CHT ROC violations
        let rocOk = n;
        if (fd.chtRoc) {
            rocOk = 0;
            for (let i = seg.startIdx; i <= seg.endIdx; i++) {
                const maxRoc = Math.max(...[0,1,2,3].map(c => Math.abs(fd.chtRoc[c][i])));
                if (fd.pctPower[i] <= 65 || maxRoc <= 50) rocOk++;
            }
        }
        const rocScore = clamp((rocOk / n) * 100);

        // Bank exceedance
        let bankOk = 0;
        for (let i = seg.startIdx; i <= seg.endIdx; i++) {
            if (Math.abs(fd.bank[i]) <= 30) bankOk++;
        }
        const bankScore = clamp((bankOk / n) * 100);

        // Speed discipline (IAS vs Vno) — skip if IAS not available
        let speedScore = 100;
        if (fd.iasKts && thr.vnoKias) {
            let speedOk = 0;
            for (let i = seg.startIdx; i <= seg.endIdx; i++) {
                if (fd.iasKts[i] <= thr.vnoKias) speedOk++;
            }
            speedScore = clamp((speedOk / n) * 100);
        }

        // Approach stabilization — only for approach/landing phases
        let approachScore = 100;
        if (seg.name === 'approach' || seg.name === 'landing') {
            const vref = thr.vrefKias || 65;
            const stabStart = Math.max(seg.startIdx, seg.endIdx - 30);
            let stabOk = 0, stabTotal = 0;
            for (let i = stabStart; i <= seg.endIdx; i++) {
                stabTotal++;
                const bankOkA  = Math.abs(fd.bank[i]) <= 5;
                const sinkFpm  = i > 0 ? (fd.altFt[i-1] - fd.altFt[i]) * 60 : 0;
                const sinkOkA  = sinkFpm < 1000;
                const speedOkA = !fd.iasKts || Math.abs(fd.iasKts[i] - vref) <= 10;
                if (bankOkA && sinkOkA && speedOkA) stabOk++;
            }
            approachScore = stabTotal > 0 ? clamp((stabOk / stabTotal) * 100) : 100;
        }

        const subs = seg.name === 'approach' || seg.name === 'landing'
            ? [chtScore, rocScore, bankScore, speedScore, approachScore]
            : [chtScore, rocScore, bankScore, speedScore];

        return {
            name: seg.name,
            startIdx: seg.startIdx,
            endIdx: seg.endIdx,
            durationSec: n,
            distNm: parseFloat(distNm.toFixed(1)),
            score: clamp(Math.round(avg(subs))),
        };
    });
}
```

- [ ] **Step 2: Verify in browser console**

```javascript
// After flight loads:
window._phaseScores
// Expected: array like [{name:"ground",score:95,...},{name:"climb",score:78,...},...]
```

- [ ] **Step 3: Commit**
```bash
git add js/scorer.js
git commit -m "feat(scorer): add scorePhases for per-segment scoring"
```

---

### Task 4: index.html — 3-panel shell + tab nav

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace the debrief-root contents**

Replace the entire content of `index.html` (keep the `<head>` and script tags at the bottom unchanged) with this body:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FlyTab Debrief</title>
  <link rel="stylesheet" href="lib/leaflet.css">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <!-- Flight selector overlay -->
  <div id="flight-selector" class="selector-overlay">
    <div class="selector-panel">
      <h1 class="selector-title">FlyTab Debrief</h1>
      <div id="flight-list" class="flight-list">Loading…</div>
    </div>
  </div>

  <!-- Main debrief layout -->
  <div id="debrief-root" class="debrief-root hidden">

    <!-- Header: route + tabs + V-speeds -->
    <header class="debrief-header">
      <div class="hdr-left">
        <span class="hdr-route" id="hdr-route">— → —</span>
        <span class="hdr-stats" id="hdr-stats"></span>
      </div>
      <nav class="tab-nav">
        <button class="tab-btn active" data-tab="track">Flight Track</button>
        <button class="tab-btn" data-tab="engine">Engine</button>
        <button class="tab-btn" data-tab="review">AI Review</button>
      </nav>
      <div class="hdr-right">
        <button class="hdr-btn" id="vspeeds-btn">V-speeds ⚙</button>
        <button class="hdr-btn" id="back-btn">← Back</button>
      </div>
    </header>

    <!-- Three-panel shell (Flight Track + Engine tabs) -->
    <div id="three-panel" class="three-panel">

      <!-- Phase sidebar (shared) -->
      <div id="phase-sidebar" class="phase-sidebar"></div>

      <!-- Main panel: map (Flight Track) or instrument cluster (Engine) -->
      <div class="main-panel">
        <div id="map-panel" class="map-panel">
          <div id="map" class="leaflet-map"></div>
          <button id="traffic-menu-btn" class="traffic-menu-btn hidden">✈ ⚙</button>
          <div id="traffic-menu" class="traffic-menu hidden">
            <div class="tm-title">TRAFFIC DISPLAY</div>
            <label class="tm-row"><span>Callsign</span><input type="checkbox" data-field="callsign" checked></label>
            <label class="tm-row"><span>Altitude</span><input type="checkbox" data-field="altitude" checked></label>
            <label class="tm-row"><span>Ground speed</span><input type="checkbox" data-field="speed"></label>
            <label class="tm-row"><span>Heading (numeric)</span><input type="checkbox" data-field="heading"></label>
            <label class="tm-row"><span>Squawk</span><input type="checkbox" data-field="squawk"></label>
            <label class="tm-row"><span>Altitude band color</span><input type="checkbox" data-field="altColor" checked></label>
            <label class="tm-row"><span>Proximity ring</span><input type="checkbox" data-field="proxRing" checked></label>
          </div>
        </div>
        <div id="engine-cluster" class="engine-cluster hidden"></div>
      </div>

      <!-- Score / rationale panel (shared) -->
      <div id="score-panel" class="score-panel"></div>

    </div>

    <!-- Chart panel (full-width, Flight Track + Engine tabs) -->
    <div id="chart-panel" class="chart-panel">
      <div id="track-chart-wrap" class="chart-wrap">
        <div class="chart-toggles" id="track-toggles"></div>
        <div class="chart-canvas-wrap"><canvas id="track-chart"></canvas></div>
      </div>
      <div id="engine-chart-wrap" class="chart-wrap hidden">
        <div class="chart-toggles" id="engine-toggles"></div>
        <div class="chart-canvas-wrap"><canvas id="engine-chart"></canvas></div>
      </div>
    </div>

    <!-- AI Review panel (full-width, review tab only) -->
    <div id="review-panel" class="review-panel hidden"></div>

    <!-- Playback bar (always visible) -->
    <div class="playback-bar">
      <button id="play-btn" class="play-btn">▶</button>
      <div class="scrubber-wrap">
        <div id="phase-band" class="phase-band"></div>
        <div id="event-ticks" class="event-ticks"></div>
        <input id="scrubber" type="range" min="0" max="100" value="0" class="scrubber">
      </div>
      <div class="speed-btns">
        <button class="speed-btn active" data-speed="1">1×</button>
        <button class="speed-btn" data-speed="2">2×</button>
        <button class="speed-btn" data-speed="5">5×</button>
        <button class="speed-btn" data-speed="10">10×</button>
      </div>
      <span id="time-display" class="time-display">--:--:--Z</span>
    </div>

    <!-- V-speeds modal -->
    <div id="vspeeds-modal" class="vspeeds-modal hidden">
      <div class="vspeeds-inner">
        <h3>V-Speeds</h3>
        <div class="vspeeds-hint">Overrides saved per aircraft. Leave blank to use default.</div>
        <table class="vspeeds-table" id="vspeeds-table"></table>
        <div class="vspeeds-actions">
          <button id="vspeeds-save">SAVE</button>
          <button id="vspeeds-cancel">CANCEL</button>
        </div>
      </div>
    </div>

  </div><!-- /debrief-root -->

  <script src="lib/leaflet.js"></script>
  <script src="lib/chart.umd.min.js"></script>
  <script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Verify page loads without console errors**

Reload `http://192.168.1.77:8092` — should show the flight selector. Open browser console, confirm no JS errors.

- [ ] **Step 3: Commit**
```bash
git add index.html
git commit -m "feat(html): 3-panel shell with tab nav, traffic menu, V-speeds modal"
```

---

### Task 5: css/style.css — 3-panel layout + new component styles

**Files:**
- Modify: `css/style.css`

- [ ] **Step 1: Replace style.css with the full new stylesheet**

```css
/* ── Design tokens ───────────────────────────────────────────────── */
:root {
  --bg-primary:    #ffffff;
  --bg-surface:    #f5f5f5;
  --text-primary:  #1a1a2e;
  --text-secondary:#444444;
  --text-label:    #666666;
  --text-muted:    #888888;
  --accent:        #0066cc;
  --border:        #e0e0e0;
  --border-light:  #f0f0f0;
  --border-strong: #b0b0b0;
  --color-success: #1a8c35;
  --color-caution: #b87000;
  --color-danger:  #cc2222;
  --color-info:    #0055bb;
  --font-instrument: 'Courier New', monospace;
  --font-ui:       system-ui, sans-serif;
  --touch-min:     56px;
  --sidebar-w:     220px;
  --header-h:      48px;
  --chart-h:       220px;
  --playback-h:    52px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; font-family: var(--font-ui); background: var(--bg-primary); color: var(--text-primary); }
.hidden { display: none !important; }

/* ── Flight selector ──────────────────────────────────────────────── */
.selector-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--bg-primary); z-index: 1000; }
.selector-panel   { width: min(480px, 95vw); }
.selector-title   { font-size: 1.6rem; font-weight: 800; margin-bottom: 24px; text-align: center; }
.flight-list      { display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; }
.flight-item      { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; min-height: var(--touch-min); }
.flight-item:hover { background: var(--bg-surface); }
.flight-item-name { font-family: var(--font-instrument); font-weight: 700; font-size: 0.9rem; }
.flight-item-badge{ font-size: 0.7rem; color: var(--color-success); font-weight: 700; }

/* ── Root layout ─────────────────────────────────────────────────── */
.debrief-root {
  display: grid;
  grid-template-rows: var(--header-h) 1fr var(--chart-h) var(--playback-h);
  grid-template-columns: 1fr;
  height: 100vh;
  overflow: hidden;
}

/* ── Header ──────────────────────────────────────────────────────── */
.debrief-header {
  display: flex; align-items: center; gap: 12px;
  padding: 0 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  height: var(--header-h);
  overflow: hidden;
}
.hdr-left  { display: flex; align-items: baseline; gap: 10px; flex: 1; min-width: 0; overflow: hidden; }
.hdr-route { font-weight: 800; font-size: 1rem; white-space: nowrap; }
.hdr-stats { color: var(--text-secondary); font-size: 0.8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-nav   { display: flex; gap: 2px; }
.tab-btn   { padding: 6px 14px; border: 1px solid var(--border-strong); border-radius: 4px; font-size: 0.8rem; font-weight: 700; cursor: pointer; background: var(--bg-primary); color: var(--text-secondary); }
.tab-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.hdr-right { display: flex; gap: 6px; }
.hdr-btn   { padding: 0 14px; height: 32px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg-primary); font-weight: 700; font-size: 0.8rem; cursor: pointer; white-space: nowrap; }
.hdr-btn:hover { background: var(--accent); color: #fff; border-color: var(--accent); }

/* ── Three-panel shell ───────────────────────────────────────────── */
.three-panel {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr 340px;
  overflow: hidden;
}

/* ── Phase sidebar ───────────────────────────────────────────────── */
.phase-sidebar {
  border-right: 1px solid var(--border);
  overflow-y: auto;
  background: var(--bg-surface);
}
.ps-phase {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-light);
  cursor: pointer;
  transition: background 0.1s;
}
.ps-phase:hover { background: var(--bg-primary); }
.ps-phase.active { background: var(--bg-primary); border-left: 3px solid var(--accent); }
.ps-phase-name { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 0.82rem; }
.ps-phase-icon { font-size: 0.9rem; width: 16px; text-align: center; }
.ps-meta  { font-size: 0.72rem; color: var(--text-muted); margin-top: 2px; }
.ps-score { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.ps-score-badge {
  font-family: var(--font-instrument); font-weight: 900; font-size: 0.85rem;
  padding: 1px 6px; border-radius: 3px; color: #fff;
}
.ps-score-badge.green  { background: var(--color-success); }
.ps-score-badge.amber  { background: var(--color-caution); }
.ps-score-badge.red    { background: var(--color-danger); }
.ps-score-bar { flex: 1; height: 4px; background: var(--border-light); border-radius: 2px; overflow: hidden; }
.ps-score-fill { height: 100%; border-radius: 2px; }

/* ── Main panel ──────────────────────────────────────────────────── */
.main-panel { position: relative; overflow: hidden; border-right: 1px solid var(--border); }
.map-panel  { position: absolute; inset: 0; }
.leaflet-map { width: 100%; height: 100%; }
.traffic-menu-btn {
  position: absolute; top: 10px; right: 10px; z-index: 1001;
  padding: 5px 10px; border-radius: 12px; border: 1px solid var(--border-strong);
  background: var(--bg-primary); font-size: 0.75rem; font-weight: 700; cursor: pointer;
}
.traffic-menu {
  position: absolute; top: 42px; right: 10px; z-index: 1002;
  background: var(--bg-primary); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 10px; min-width: 200px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.tm-title { font-size: 0.72rem; font-weight: 800; color: var(--text-label); margin-bottom: 8px; letter-spacing: 0.05em; }
.tm-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 0.8rem; cursor: pointer; }
.engine-cluster { position: absolute; inset: 0; overflow-y: auto; padding: 16px; background: var(--bg-primary); }

/* ── Score / Rationale panel ─────────────────────────────────────── */
.score-panel { overflow-y: auto; padding: 12px; background: var(--bg-primary); }
.sp-header { margin-bottom: 10px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
.sp-phase-name { font-weight: 800; font-size: 0.9rem; }
.sp-score-val  { font-family: var(--font-instrument); font-weight: 900; font-size: 1.1rem; }
.sp-time { font-size: 0.78rem; color: var(--text-muted); font-family: var(--font-instrument); }
.sp-section-title { font-size: 0.7rem; font-weight: 800; color: var(--text-label); letter-spacing: 0.08em; margin: 10px 0 4px; }
.sp-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 0.8rem; }
.sp-row.pass { color: var(--text-muted); }
.sp-row.warn { color: var(--color-caution); }
.sp-row.fail { color: var(--color-danger); }
.sp-icon { width: 14px; text-align: center; }
.sp-label { flex: 1; }
.sp-val { font-family: var(--font-instrument); font-weight: 700; font-size: 0.78rem; }
.sp-thr { font-size: 0.72rem; color: inherit; opacity: 0.75; margin-left: 2px; }
.sp-na  { color: var(--text-muted); font-style: italic; font-size: 0.8rem; }
.sp-events-title { font-size: 0.7rem; font-weight: 800; color: var(--text-label); letter-spacing: 0.08em; margin: 12px 0 4px; }
.sp-event-row { font-size: 0.75rem; color: var(--text-secondary); padding: 2px 0; display: flex; gap: 6px; }
.sp-event-time { font-family: var(--font-instrument); color: var(--text-muted); }
.sp-event-type { font-weight: 700; }
.sp-event-type.orange { color: var(--color-caution); }
.sp-event-type.red    { color: var(--color-danger); }
.sp-event-type.purple { color: #7b2d8b; }

/* ── Chart panel ─────────────────────────────────────────────────── */
.chart-panel { border-top: 1px solid var(--border); overflow: hidden; }
.chart-wrap  { display: flex; flex-direction: column; height: 100%; }
.chart-toggles { flex: 0 0 auto; display: flex; gap: 4px; padding: 4px 8px; flex-wrap: wrap; background: var(--bg-surface); border-bottom: 1px solid var(--border-light); align-items: center; }
.toggle-pill {
  padding: 2px 10px; border-radius: 10px; border: 1px solid var(--border-strong);
  font-size: 0.72rem; font-weight: 700; cursor: pointer;
  background: var(--bg-primary); color: var(--text-secondary);
}
.toggle-pill.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.toggle-pill.zoom   { margin-left: auto; }
.chart-canvas-wrap { flex: 1 1 0; min-height: 0; position: relative; padding: 4px 8px; }
.chart-canvas-wrap canvas { width: 100% !important; height: 100% !important; }

/* ── Phase band in scrubber ──────────────────────────────────────── */
.phase-band { position: absolute; top: 0; left: 0; right: 0; height: 4px; pointer-events: none; border-radius: 2px; overflow: hidden; }

/* ── AI Review panel ─────────────────────────────────────────────── */
.review-panel { display: grid; grid-template-rows: auto 1fr; overflow: hidden; padding: 0; }
.review-top { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px; border-bottom: 1px solid var(--border); background: var(--bg-surface); }
.review-summary h4, .review-scores h4 { font-size: 0.72rem; font-weight: 800; color: var(--text-label); letter-spacing: 0.08em; margin-bottom: 8px; }
.review-flight-info { font-size: 0.85rem; line-height: 1.6; }
.review-score-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 0.82rem; }
.review-score-label { width: 100px; color: var(--text-secondary); font-weight: 700; }
.review-score-bar-wrap { flex: 1; height: 8px; background: var(--border-light); border-radius: 4px; overflow: hidden; }
.review-score-bar { height: 100%; border-radius: 4px; }
.review-score-bar.green  { background: var(--color-success); }
.review-score-bar.amber  { background: var(--color-caution); }
.review-score-bar.red    { background: var(--color-danger); }
.review-score-num { font-family: var(--font-instrument); font-weight: 900; width: 28px; }
.review-events-list { margin-top: 8px; }
.review-event-item { font-size: 0.78rem; color: var(--text-secondary); padding: 1px 0; }
.review-narrative { overflow-y: auto; padding: 16px; font-size: 0.85rem; line-height: 1.6; }
.review-generate-wrap { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.review-section { margin-bottom: 12px; }
.review-section-hdr { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 800; font-size: 0.85rem; margin-bottom: 4px; }
.review-section-body { white-space: pre-wrap; padding-left: 16px; border-left: 2px solid var(--border); font-size: 0.83rem; color: var(--text-secondary); }

/* ── Engine cluster ──────────────────────────────────────────────── */
.ec-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
.ec-tile {
  border: 1px solid var(--border); border-radius: 6px; padding: 10px 8px; text-align: center;
  background: var(--bg-surface);
}
.ec-tile.caution { border-color: var(--color-caution); background: #fff8ee; }
.ec-tile.danger  { border-color: var(--color-danger);  background: #fff0f0; }
.ec-tile-label { font-size: 0.7rem; font-weight: 800; color: var(--text-label); margin-bottom: 4px; letter-spacing: 0.05em; }
.ec-tile-value { font-family: var(--font-instrument); font-weight: 900; font-size: 1.2rem; }
.ec-tile-roc   { font-size: 0.75rem; font-family: var(--font-instrument); color: var(--text-muted); margin-top: 2px; }
.ec-tile-roc.warn { color: var(--color-caution); font-weight: 700; }
.ec-strip { font-size: 0.8rem; color: var(--text-secondary); padding: 8px 0; border-top: 1px solid var(--border); display: flex; gap: 16px; flex-wrap: wrap; }
.ec-strip span { white-space: nowrap; }
.ec-strip .label { color: var(--text-muted); font-size: 0.72rem; }

/* ── Playback bar ────────────────────────────────────────────────── */
.playback-bar  { display: flex; align-items: center; gap: 8px; padding: 0 12px; background: var(--bg-surface); border-top: 1px solid var(--border); height: var(--playback-h); }
.play-btn      { width: 32px; height: 32px; border-radius: 50%; border: 2px solid var(--border-strong); background: var(--bg-primary); font-size: 0.9rem; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.scrubber-wrap { flex: 1; position: relative; height: 20px; display: flex; align-items: center; }
.phase-band    { position: absolute; top: 0; left: 0; right: 0; height: 4px; pointer-events: none; }
.event-ticks   { position: absolute; top: 4px; left: 0; right: 0; height: 16px; pointer-events: none; }
.scrubber      { position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; margin: 0; }
.scrubber-track { position: absolute; top: 8px; left: 0; right: 0; height: 4px; background: var(--border); border-radius: 2px; pointer-events: none; }
.scrubber-fill  { height: 100%; background: var(--accent); border-radius: 2px; pointer-events: none; }
.speed-btns    { display: flex; gap: 2px; flex-shrink: 0; }
.speed-btn     { padding: 4px 8px; border: 1px solid var(--border-strong); border-radius: 3px; font-size: 0.75rem; font-weight: 700; cursor: pointer; background: var(--bg-primary); }
.speed-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.time-display  { font-family: var(--font-instrument); font-weight: 700; font-size: 0.85rem; width: 75px; flex-shrink: 0; }

/* ── V-speeds modal ──────────────────────────────────────────────── */
.vspeeds-modal { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); z-index: 2000; }
.vspeeds-inner { background: var(--bg-primary); border-radius: 8px; padding: 20px; width: min(480px, 90vw); max-height: 90vh; overflow-y: auto; }
.vspeeds-inner h3 { font-weight: 800; margin-bottom: 4px; }
.vspeeds-hint  { font-size: 0.78rem; color: var(--text-muted); margin-bottom: 12px; }
.vspeeds-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.vspeeds-table th { text-align: left; padding: 4px 8px; font-size: 0.72rem; font-weight: 800; color: var(--text-label); letter-spacing: 0.05em; border-bottom: 1px solid var(--border); }
.vspeeds-table td { padding: 6px 8px; border-bottom: 1px solid var(--border-light); }
.vspeeds-table input { width: 72px; padding: 3px 6px; border: 1px solid var(--border-strong); border-radius: 3px; font-family: var(--font-instrument); font-weight: 700; text-align: right; }
.vspeeds-actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
.vspeeds-actions button { padding: 8px 20px; border-radius: 4px; font-weight: 700; cursor: pointer; border: 1px solid var(--border-strong); }
```

- [ ] **Step 2: Verify layout renders**

Reload browser. Load any flight. The three-panel layout should be visible (sidebar on left, map center, score panel right). Chart panel below. Playback bar at bottom.

- [ ] **Step 3: Commit**
```bash
git add css/style.css
git commit -m "feat(css): 3-panel layout, phase sidebar, score panel, engine cluster, chart toggles"
```

---

### Task 6: js/phase-sidebar.js — new module

**Files:**
- Create: `js/phase-sidebar.js`

- [ ] **Step 1: Create the file**

```javascript
// js/phase-sidebar.js

const PHASE_ICONS = {
    ground: '■', climb: '▶', cruise: '→', descent: '▼',
    approach: '↙', landing: '→',
};

const PHASE_LABELS = {
    ground: 'Ground', climb: 'Climb', cruise: 'Cruise', descent: 'Descent',
    approach: 'Approach', landing: 'Landing',
};

function scoreColor(s) {
    return s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red';
}

function scoreHex(s) {
    return s >= 80 ? '#1a8c35' : s >= 60 ? '#b87000' : '#cc2222';
}

function fmtDuration(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function initPhaseSidebar(phaseScores, onSeekCb) {
    const el = document.getElementById('phase-sidebar');
    if (!el) return;

    el.innerHTML = phaseScores.map((ps, idx) => `
        <div class="ps-phase" data-idx="${idx}" data-start="${ps.startIdx}">
          <div class="ps-phase-name">
            <span class="ps-phase-icon">${PHASE_ICONS[ps.name] || '→'}</span>
            <span>${PHASE_LABELS[ps.name] || ps.name}</span>
          </div>
          <div class="ps-meta">${ps.distNm.toFixed(1)} nm · ${fmtDuration(ps.durationSec)}</div>
          <div class="ps-score">
            <span class="ps-score-badge ${scoreColor(ps.score)}">${ps.score}</span>
            <div class="ps-score-bar">
              <div class="ps-score-fill" style="width:${ps.score}%;background:${scoreHex(ps.score)}"></div>
            </div>
          </div>
        </div>
    `).join('');

    el.querySelectorAll('.ps-phase').forEach(row => {
        row.addEventListener('click', () => {
            const startIdx = parseInt(row.dataset.start);
            onSeekCb(startIdx, parseInt(row.dataset.idx));
        });
    });

    window._phaseSidebar = { seek: seekSidebar.bind(null, phaseScores) };
}

function seekSidebar(phaseScores, rowIdx) {
    const el = document.getElementById('phase-sidebar');
    if (!el) return;
    const activePhaseIdx = phaseScores.findIndex(
        ps => rowIdx >= ps.startIdx && rowIdx <= ps.endIdx
    );
    el.querySelectorAll('.ps-phase').forEach((row, i) => {
        row.classList.toggle('active', i === activePhaseIdx);
    });
}
```

- [ ] **Step 2: Verify (after app.js wiring in Task 14)**

After wiring, loading a flight should show phase rows in the sidebar. Clicking a phase row should jump the scrubber.

- [ ] **Step 3: Commit**
```bash
git add js/phase-sidebar.js
git commit -m "feat(phase-sidebar): phase navigation sidebar with score badges"
```

---

### Task 7: js/score-panel.js — new module

**Files:**
- Create: `js/score-panel.js`

- [ ] **Step 1: Create the file**

```javascript
// js/score-panel.js

let _fd = null, _phaseScores = null, _events = null, _thr = null;

export function initScorePanel(fd, phaseScores, events, thr) {
    _fd = fd;
    _phaseScores = phaseScores;
    _events = events;
    _thr = thr;
    const el = document.getElementById('score-panel');
    if (el) el.innerHTML = '<div class="sp-header"><span class="sp-phase-name">—</span></div>';
    window._scorePanel = { seek };
}

export function seek(rowIdx) {
    const el = document.getElementById('score-panel');
    if (!el || !_fd) return;

    const phase = _phaseScores?.find(ps => rowIdx >= ps.startIdx && rowIdx <= ps.endIdx);
    const phaseName = phase?.name || 'ground';
    const phaseScore = phase?.score ?? 0;

    const zuluTime = _fd.startUtc
        ? new Date(_fd.startUtc.getTime() + rowIdx * 1000).toISOString().slice(11, 19) + 'Z'
        : '--:--:--Z';

    const thr = _thr || {};
    const chtCaution = thr.chtCaution || 380;
    const chtDanger  = thr.chtDanger  || 435;
    const vno = thr.vnoKias || 165;
    const vne = thr.vneKias || 202;

    // Airmanship parameters
    const bank    = _fd.bank[rowIdx] ?? 0;
    const ias     = _fd.iasKts?.[rowIdx] ?? null;
    const altStd  = _altStdDevNear(rowIdx, 30);

    const bankStatus  = Math.abs(bank) > 45 ? 'fail' : Math.abs(bank) > 30 ? 'warn' : 'pass';
    const iasStatus   = ias !== null ? (ias > vne - 10 ? 'fail' : ias > vno ? 'warn' : 'pass') : null;
    const altStatus   = altStd > 300 ? 'warn' : 'pass';

    // Engine parameters
    const maxCht  = Math.max(_fd.cht[0][rowIdx], _fd.cht[1][rowIdx], _fd.cht[2][rowIdx], _fd.cht[3][rowIdx]);
    const hotCyl  = [0,1,2,3].reduce((best, c) => _fd.cht[c][rowIdx] > _fd.cht[best][rowIdx] ? c : best, 0);
    const chtStatus = maxCht > chtDanger ? 'fail' : maxCht > chtCaution ? 'warn' : 'pass';

    const maxRoc  = _fd.chtRoc
        ? Math.max(...[0,1,2,3].map(c => Math.abs(_fd.chtRoc[c][rowIdx])))
        : 0;
    const rocActive = _fd.pctPower[rowIdx] > 65;
    const rocStatus = (rocActive && maxRoc > 50) ? 'warn' : 'pass';

    const egtSpread = _egtSpread(rowIdx);
    const egtStatus = egtSpread > 100 ? 'fail' : egtSpread > 50 ? 'warn' : 'pass';

    const opCond   = _fd.opCondition[rowIdx] || '';
    const mixStatus = opCond ? 'pass' : (phaseName === 'cruise' ? 'warn' : 'pass');

    const oilTemp   = _fd.oilTemp[rowIdx];
    const oilMin    = thr.oilTempMin || 100;
    const oilMax    = thr.oilTempMax || 245;
    const oilStatus = oilTemp > 0 ? (oilTemp > oilMax ? 'fail' : oilTemp < oilMin ? 'warn' : 'pass') : 'pass';

    // Approach parameters
    const isApproach = phaseName === 'approach' || phaseName === 'landing';
    const sinkFpm = rowIdx > 0 ? ((_fd.altFt[rowIdx - 1] - _fd.altFt[rowIdx]) * 60) : 0;
    const sinkStatus = isApproach ? (sinkFpm > 1000 ? 'fail' : sinkFpm > 750 ? 'warn' : 'pass') : null;

    // Nearby events (±30s)
    const nearby = _events
        ? _events.filter(e => Math.abs(e.tSec - rowIdx) <= 30)
            .slice(0, 4)
        : [];

    const scoreColor = phaseScore >= 80 ? 'var(--color-success)' : phaseScore >= 60 ? 'var(--color-caution)' : 'var(--color-danger)';
    const phaseLabel = { ground:'Ground',climb:'Climb',cruise:'Cruise',descent:'Descent',approach:'Approach',landing:'Landing' }[phaseName] || phaseName;

    el.innerHTML = `
        <div class="sp-header">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span class="sp-phase-name">${phaseLabel.toUpperCase()}</span>
            <span class="sp-score-val" style="color:${scoreColor}">${phaseScore}</span>
          </div>
          <div class="sp-time">${zuluTime}</div>
        </div>

        <div class="sp-section-title">AIRMANSHIP</div>
        ${_row('Bank', `${Math.abs(bank).toFixed(0)}°`, bankStatus, bankStatus !== 'pass' ? '>30°' : '')}
        ${ias !== null ? _row('IAS', `${ias.toFixed(0)} kt`, iasStatus, iasStatus !== 'pass' ? `Vno ${vno}` : '') : ''}
        ${_row('Alt stability', `±${altStd.toFixed(0)} ft`, altStatus, '')}

        <div class="sp-section-title">ENGINE</div>
        ${_row(`CHT${hotCyl+1}`, `${maxCht.toFixed(0)}°F`, chtStatus, chtStatus !== 'pass' ? `>${chtCaution}` : '')}
        ${_fd.chtRoc ? _row('CHT ROC', `${maxRoc.toFixed(0)}°F/min`, rocStatus, rocActive && rocStatus !== 'pass' ? '>50°/min' : '') : ''}
        ${_row('EGT spread', `${egtSpread.toFixed(0)}°F`, egtStatus, egtStatus !== 'pass' ? '>50°F' : '')}
        ${_row('Mixture', opCond || '—', mixStatus, '')}
        ${oilTemp > 0 ? _row('Oil temp', `${oilTemp.toFixed(0)}°F`, oilStatus, '') : ''}

        ${isApproach ? `
        <div class="sp-section-title">APPROACH</div>
        ${sinkStatus ? _row('Sink rate', `${sinkFpm.toFixed(0)} fpm`, sinkStatus, sinkStatus !== 'pass' ? '<1000 fpm' : '') : ''}
        ${ias !== null ? _row('IAS vs Vref', `${(ias - (thr.vrefKias||65)).toFixed(0)} kt`, Math.abs(ias-(thr.vrefKias||65)) > 10 ? 'warn':'pass', '') : ''}
        ` : `<div class="sp-na" style="padding:6px 0">Approach: n/a</div>`}

        ${nearby.length ? `
        <div class="sp-events-title">EVENTS ±30s</div>
        ${nearby.map(e => `
          <div class="sp-event-row">
            <span class="sp-event-time">${_fmtSec(e.tSec)}</span>
            <span class="sp-event-type ${e.level}">${e.type}</span>
          </div>
        `).join('')}
        ` : ''}
    `;
}

function _row(label, val, status, thr) {
    const icon = status === 'fail' ? '✗' : status === 'warn' ? '⚠' : '✓';
    return `<div class="sp-row ${status}">
      <span class="sp-icon">${icon}</span>
      <span class="sp-label">${label}</span>
      <span class="sp-val">${val}</span>
      ${thr ? `<span class="sp-thr">${thr}</span>` : ''}
    </div>`;
}

function _egtSpread(idx) {
    const vals = [0,1,2,3].map(c => _fd.egt[c][idx]).filter(v => v > 0);
    if (vals.length < 2) return 0;
    return Math.max(...vals) - Math.min(...vals);
}

function _altStdDevNear(idx, halfWindow) {
    const start = Math.max(0, idx - halfWindow);
    const end   = Math.min(_fd.rows - 1, idx + halfWindow);
    const vals  = [];
    for (let i = start; i <= end; i++) vals.push(_fd.altFt[i]);
    if (vals.length < 2) return 0;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
}

function _fmtSec(s) {
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
```

- [ ] **Step 2: Commit**
```bash
git add js/score-panel.js
git commit -m "feat(score-panel): time-synchronized score/rationale panel"
```

---

### Task 8: js/charts.js — multi-overlay rewrite

**Files:**
- Modify: `js/charts.js`

- [ ] **Step 1: Replace charts.js entirely**

```javascript
// js/charts.js

const C = {
    alt:  '#0066cc', agl: '#7b2d8b', ias: '#b87000', gs: '#1a8c35',
    bank: '#cc2222', pitch: '#444444',
    egt:  ['#cc2222','#b87000','#0066cc','#1a8c35'],
    cht:  ['#ee4444','#cc6600','#2244cc','#228833'],
    roc:  ['#ff8888','#ffaa44','#8888ff','#44aa44'],
    ff:   '#0066cc', mp: '#1a8c35', rpm: '#b87000',
    grid: '#e0e0e0',
};

let _trackChart = null, _engineChart = null;
let _fd = null, _phaseScores = null;

const TRACK_OVERLAYS = [
    { key: 'altMsl', label: 'Alt MSL', default: true },
    { key: 'gs',     label: 'GS',      default: true },
    { key: 'ias',    label: 'IAS est', default: true },
    { key: 'bank',   label: 'Bank',    default: true },
    { key: 'pitch',  label: 'Pitch',   default: false },
];

const ENGINE_OVERLAYS = [
    { key: 'egt',    label: 'EGT 1-4', default: true },
    { key: 'cht',    label: 'CHT 1-4', default: true },
    { key: 'roc',    label: 'CHT ROC', default: false },
    { key: 'ff',     label: 'Fuel Flow', default: true },
    { key: 'mp',     label: 'MP',      default: false },
    { key: 'rpm',    label: 'RPM',     default: false },
];

let _trackActive = new Set(TRACK_OVERLAYS.filter(o => o.default).map(o => o.key));
let _engineActive = new Set(ENGINE_OVERLAYS.filter(o => o.default).map(o => o.key));
let _trackZoom = null;  // {min, max} row indices, null = full flight

export function initCharts(fd, phaseScores) {
    _fd = fd;
    _phaseScores = phaseScores;
    _buildToggles('track-toggles', TRACK_OVERLAYS, _trackActive, _onTrackToggle);
    _buildToggles('engine-toggles', ENGINE_OVERLAYS, _engineActive, _onEngineToggle);
    _renderTrackChart();
    _renderEngineChart();
    window._charts = { seek: seekCharts, zoomToPhase };
}

function _buildToggles(containerId, overlays, activeSet, onChange) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    wrap.innerHTML = overlays.map(o => `
        <button class="toggle-pill ${activeSet.has(o.key) ? 'active' : ''}" data-key="${o.key}">${o.label}</button>
    `).join('') + `<button class="toggle-pill zoom" data-zoom="1">⟳ Full</button>`;

    wrap.querySelectorAll('.toggle-pill[data-key]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            if (activeSet.has(key)) activeSet.delete(key);
            else activeSet.add(key);
            btn.classList.toggle('active', activeSet.has(key));
            onChange();
        });
    });
    wrap.querySelector('[data-zoom]')?.addEventListener('click', () => {
        _trackZoom = null;
        _renderTrackChart();
    });
}

function _onTrackToggle() { _renderTrackChart(); }
function _onEngineToggle() { _renderEngineChart(); }

export function zoomToPhase(phaseIdx) {
    if (!_phaseScores || phaseIdx < 0 || phaseIdx >= _phaseScores.length) return;
    const ps = _phaseScores[phaseIdx];
    _trackZoom = { min: ps.startIdx, max: ps.endIdx };
    _renderTrackChart();
}

function _labels() {
    const min = _trackZoom?.min ?? 0;
    const max = _trackZoom?.max ?? (_fd.rows - 1);
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

function _slice(arr, labels) {
    return labels.map(i => arr[i]);
}

function _renderTrackChart() {
    if (_trackChart) { _trackChart.destroy(); _trackChart = null; }
    const canvas = document.getElementById('track-chart');
    if (!canvas) return;
    const labels = _labels();
    const datasets = [];

    if (_trackActive.has('altMsl')) datasets.push({
        label: 'Alt MSL (ft)', data: _slice(_fd.altFt, labels),
        borderColor: C.alt, backgroundColor: 'transparent', borderWidth: 1.5,
        pointRadius: 0, yAxisID: 'yAlt',
    });
    if (_trackActive.has('gs')) datasets.push({
        label: 'GS (kt)', data: _slice(_fd.speedKts, labels),
        borderColor: C.gs, backgroundColor: 'transparent', borderWidth: 1.5,
        pointRadius: 0, yAxisID: 'ySpd',
    });
    if (_trackActive.has('ias') && _fd.iasKts) datasets.push({
        label: 'IAS est (kt)', data: _slice(_fd.iasKts, labels),
        borderColor: C.ias, backgroundColor: 'transparent', borderWidth: 1.5,
        borderDash: [4,2], pointRadius: 0, yAxisID: 'ySpd',
    });
    if (_trackActive.has('bank')) datasets.push({
        label: 'Bank (°)', data: _slice(_fd.bank, labels),
        borderColor: C.bank, backgroundColor: 'transparent', borderWidth: 1,
        borderDash: [2,2], pointRadius: 0, yAxisID: 'yAtt',
    });
    if (_trackActive.has('pitch')) datasets.push({
        label: 'Pitch (°)', data: _slice(_fd.pitch, labels),
        borderColor: C.pitch, backgroundColor: 'transparent', borderWidth: 1,
        borderDash: [2,2], pointRadius: 0, yAxisID: 'yAtt',
    });

    _trackChart = _makeChart('track-chart', labels.map(String), datasets, {
        yAlt: { position: 'left',  title: 'Alt (ft)',   color: C.alt },
        ySpd: { position: 'right', title: 'Speed (kt)', color: C.gs, noGrid: true },
        yAtt: { position: 'right', title: 'Attitude (°)', color: C.bank, noGrid: true, min: -60, max: 60 },
    });

    _renderPhaseBand();
}

function _renderEngineChart() {
    if (_engineChart) { _engineChart.destroy(); _engineChart = null; }
    const canvas = document.getElementById('engine-chart');
    if (!canvas) return;
    const n = _fd.rows;
    const labels = Array.from({ length: n }, (_, i) => String(i));
    const datasets = [];

    if (_engineActive.has('egt')) {
        [0,1,2,3].forEach(c => datasets.push({
            label: `EGT${c+1}`, data: Array.from(_fd.egt[c]),
            borderColor: C.egt[c], backgroundColor: 'transparent',
            borderWidth: 1.5, pointRadius: 0, yAxisID: 'yTemp',
        }));
    }
    if (_engineActive.has('cht')) {
        [0,1,2,3].forEach(c => datasets.push({
            label: `CHT${c+1}`, data: Array.from(_fd.cht[c]),
            borderColor: C.cht[c], backgroundColor: 'transparent',
            borderWidth: 1.5, pointRadius: 0, yAxisID: 'yTemp',
        }));
    }
    if (_engineActive.has('roc') && _fd.chtRoc) {
        [0,1,2,3].forEach(c => datasets.push({
            label: `ROC${c+1}`, data: Array.from(_fd.chtRoc[c]),
            borderColor: C.roc[c], backgroundColor: 'transparent',
            borderWidth: 1, borderDash: [3,2], pointRadius: 0, yAxisID: 'yRoc',
        }));
    }
    if (_engineActive.has('ff')) datasets.push({
        label: 'Fuel Flow (gph)', data: Array.from(_fd.fuelFlow),
        borderColor: C.ff, backgroundColor: 'transparent',
        borderWidth: 1.5, pointRadius: 0, yAxisID: 'yFF',
    });
    if (_engineActive.has('mp')) datasets.push({
        label: 'MP (inHg)', data: Array.from(_fd.rpm).map((_, i) => {
            const row = _fd.rows > i ? i : 0;
            // MP column is col 1 (MP) in CSV — use oilPress as proxy if MP not parsed separately
            return 0;
        }),
        borderColor: C.mp, backgroundColor: 'transparent',
        borderWidth: 1.5, pointRadius: 0, yAxisID: 'yFF',
    });
    if (_engineActive.has('rpm')) datasets.push({
        label: 'RPM', data: Array.from(_fd.rpm),
        borderColor: C.rpm, backgroundColor: 'transparent',
        borderWidth: 1.5, pointRadius: 0, yAxisID: 'yRpm',
    });

    _engineChart = _makeChart('engine-chart', labels, datasets, {
        yTemp: { position: 'left',  title: 'Temp (°F)', color: C.egt[0] },
        yRoc:  { position: 'right', title: 'ROC (°F/min)', color: C.roc[0], noGrid: true },
        yFF:   { position: 'right', title: 'GPH', color: C.ff, noGrid: true },
        yRpm:  { position: 'right', title: 'RPM', color: C.rpm, noGrid: true },
    });
}

function _makeChart(canvasId, labels, datasets, axes) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const scales = { x: { ticks: { maxTicksLimit: 6, font: { size: 9 } }, grid: { color: C.grid } } };
    for (const [id, cfg] of Object.entries(axes)) {
        scales[id] = {
            type: 'linear',
            position: cfg.position,
            title: { display: true, text: cfg.title, color: cfg.color, font: { size: 9 } },
            ticks: { font: { size: 9 } },
            grid: cfg.noGrid ? { drawOnChartArea: false } : { color: C.grid },
        };
        if (cfg.min !== undefined) scales[id].min = cfg.min;
        if (cfg.max !== undefined) scales[id].max = cfg.max;
    }
    try {
        return new Chart(canvas, {
            type: 'line',
            data: { labels, datasets },
            options: {
                animation: false, responsive: true, maintainAspectRatio: false,
                elements: { point: { radius: 0 } },
                plugins: { legend: { labels: { boxWidth: 10, font: { size: 9 } } } },
                scales,
            },
        });
    } catch (e) {
        console.error('Chart error:', e);
        return null;
    }
}

function _renderPhaseBand() {
    const band = document.getElementById('phase-band');
    if (!band || !_phaseScores) return;
    const total = _fd.rows - 1;
    band.innerHTML = _phaseScores.map(ps => {
        const left = (ps.startIdx / total * 100).toFixed(2);
        const width = ((ps.endIdx - ps.startIdx) / total * 100).toFixed(2);
        const color = ps.score >= 80 ? '#1a8c35' : ps.score >= 60 ? '#b87000' : '#cc2222';
        return `<div style="position:absolute;left:${left}%;width:${width}%;height:4px;background:${color}"></div>`;
    }).join('');
}

export function seekCharts(rowIdx) {
    _seekOnChart(_trackChart, 'track-chart', rowIdx);
    _seekOnChart(_engineChart, 'engine-chart', rowIdx);
}

function _seekOnChart(chart, canvasId, rowIdx) {
    if (!chart) return;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const meta = chart.getDatasetMeta(0);
    if (!meta?.data?.[rowIdx]) return;
    const x = meta.data[rowIdx]?.x;
    if (x == null) return;
    let line = canvas.parentElement.querySelector('.chart-cursor');
    if (!line) {
        line = document.createElement('div');
        line.className = 'chart-cursor';
        line.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:rgba(0,0,0,0.35);pointer-events:none;z-index:10';
        canvas.parentElement.style.position = 'relative';
        canvas.parentElement.appendChild(line);
    }
    line.style.left = x + 'px';
}
```

- [ ] **Step 2: Verify**

Load a flight, switch to Engine tab — EGT/CHT chart should render. Switch back to Flight Track — altitude/speed chart renders. Toggle pills add/remove series.

- [ ] **Step 3: Commit**
```bash
git add js/charts.js
git commit -m "feat(charts): multi-overlay chart with toggle pills, dual y-axes, phase band"
```

---

### Task 9: js/replay.js — phase-score coloring + rich traffic markers + display menu

**Files:**
- Modify: `js/replay.js`

- [ ] **Step 1: Replace replay.js**

```javascript
// js/replay.js

const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

let _map, _trackGroup, _marker, _trafficMarkers = [];
let _fd = null, _trafficData = null, _phaseScores = null;

// Traffic display prefs — loaded from localStorage
let _trafficPrefs = {
    callsign: true, altitude: true, speed: false,
    heading: false, squawk: false, altColor: true, proxRing: true,
};

export function initReplay(fd, trafficData, phaseScores) {
    _fd = fd;
    _trafficData = trafficData;
    _phaseScores = phaseScores;
    _loadTrafficPrefs();

    if (!_map) {
        _map = L.map('map', { zoomControl: true });
        const sectional = L.tileLayer('http://192.168.1.77:8090/tiles/sectional/{z}/{x}/{y}.png', {
            maxZoom: 12, attribution: 'FAA Sectional',
        });
        const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap', maxZoom: 18,
        });
        sectional.addTo(_map);
        sectional.on('tileerror', () => { sectional.remove(); osm.addTo(_map); });
    } else {
        _map.eachLayer(l => { if (!(l instanceof L.TileLayer)) _map.removeLayer(l); });
    }

    _renderTrack();
    _renderMarker(0);
    _fitBounds();
    _wireTrafficMenu();

    window._replay = { seek };
}

function _scoreColor(score) {
    return score >= 80 ? '#1a8c35' : score >= 60 ? '#b87000' : '#cc2222';
}

function _renderTrack() {
    if (_trackGroup) { _map.removeLayer(_trackGroup); _trackGroup = null; }
    _trackGroup = L.layerGroup().addTo(_map);
    for (const ps of (_phaseScores || [])) {
        const pts = [];
        for (let i = ps.startIdx; i <= ps.endIdx; i++) {
            if (_fd.lat[i] && _fd.lon[i]) pts.push([_fd.lat[i], _fd.lon[i]]);
        }
        if (pts.length < 2) continue;
        L.polyline(pts, { color: _scoreColor(ps.score), weight: 3, opacity: 0.85 }).addTo(_trackGroup);
    }
}

function _renderMarker(idx) {
    const lat = _fd.lat[idx], lon = _fd.lon[idx];
    if (!lat || !lon) return;
    const course = _fd.course[idx] || 0;
    const icon = L.divIcon({
        className: '',
        html: `<div style="width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:20px solid #1a1a2e;transform:rotate(${course}deg);transform-origin:center bottom"></div>`,
        iconSize: [16, 20], iconAnchor: [8, 10],
    });
    if (_marker) _map.removeLayer(_marker);
    _marker = L.marker([lat, lon], { icon }).addTo(_map);
}

function _renderTraffic(idx) {
    _trafficMarkers.forEach(m => _map.removeLayer(m));
    _trafficMarkers = [];
    if (!_trafficData) return;

    const snap = _trafficData.snapshots.find(s => Math.abs(s.tSec - idx) <= 5);
    if (!snap) return;

    const ownAlt = _fd.altFt[idx];
    const prefs = _trafficPrefs;

    for (const t of snap.targets) {
        const diff = t.altFt - ownAlt;
        const isProx = Math.abs(diff) < 1000;
        const colorHex = (!prefs.altColor) ? '#0066cc'
            : isProx ? '#b87000'
            : diff > 0 ? '#0055bb'
            : '#888888';

        // Build label HTML
        const parts = [];
        if (prefs.callsign && (t.callsign || t.icao))
            parts.push(`<div style="font-weight:700;white-space:nowrap">${_esc(t.callsign || t.icao)}</div>`);
        const sub = [];
        if (prefs.altitude) sub.push(`${t.altFt.toFixed(0)}ft`);
        if (prefs.speed)    sub.push(`${t.speedKts.toFixed(0)}kt`);
        if (prefs.heading)  sub.push(`${t.heading.toFixed(0)}°`);
        if (sub.length) parts.push(`<div style="font-size:0.7rem;white-space:nowrap;color:#444">${sub.join(' · ')}</div>`);

        const pulse = (prefs.proxRing && isProx)
            ? 'animation:pulse 1s infinite;box-shadow:0 0 0 0 rgba(184,112,0,0.5)'
            : '';
        const iconHtml = `
            <div style="display:flex;flex-direction:column;align-items:center">
              <div style="font-size:1rem;color:${colorHex};transform:rotate(${t.heading}deg);${pulse}">✈</div>
              ${parts.join('')}
            </div>`;

        const icon = L.divIcon({
            className: '', html: iconHtml,
            iconSize: [60, 50], iconAnchor: [30, 12],
        });

        let popupContent = `<b>${_esc(t.callsign || t.icao)}</b><br>${t.altFt.toFixed(0)}ft · ${t.speedKts.toFixed(0)}kt · hdg ${t.heading.toFixed(0)}°`;
        if (prefs.squawk || true) popupContent += `<br>Squawk: ${_esc(t.squawk || '—')} · ICAO: ${_esc(t.icao)}`;

        const m = L.marker([t.lat, t.lon], { icon })
            .bindPopup(popupContent)
            .addTo(_map);
        _trafficMarkers.push(m);
    }
}

function _fitBounds() {
    const pts = [];
    for (let i = 0; i < _fd.rows; i++)
        if (_fd.lat[i] && _fd.lon[i]) pts.push([_fd.lat[i], _fd.lon[i]]);
    if (pts.length) _map.fitBounds(pts);
}

function _wireTrafficMenu() {
    const menuBtn = document.getElementById('traffic-menu-btn');
    const menu    = document.getElementById('traffic-menu');
    if (!menuBtn || !menu) return;

    if (_trafficData) menuBtn.classList.remove('hidden');

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== menuBtn) menu.classList.add('hidden');
    });

    menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const field = cb.dataset.field;
        cb.checked = _trafficPrefs[field] !== false;
        cb.addEventListener('change', () => {
            _trafficPrefs[field] = cb.checked;
            _saveTrafficPrefs();
            seek(parseInt(document.getElementById('scrubber').value));
        });
    });
}

function _loadTrafficPrefs() {
    try {
        const saved = JSON.parse(localStorage.getItem('trafficPrefs') || '{}');
        Object.assign(_trafficPrefs, saved);
    } catch (_) {}
}

function _saveTrafficPrefs() {
    try { localStorage.setItem('trafficPrefs', JSON.stringify(_trafficPrefs)); } catch (_) {}
}

export function seek(idx) {
    _renderMarker(idx);
    _renderTraffic(idx);
}
```

- [ ] **Step 2: Add pulse keyframe to style.css**

Add at the end of `css/style.css`:

```css
@keyframes pulse {
  0%   { box-shadow: 0 0 0 0 rgba(184,112,0,0.6); }
  70%  { box-shadow: 0 0 0 8px rgba(184,112,0,0); }
  100% { box-shadow: 0 0 0 0 rgba(184,112,0,0); }
}
```

- [ ] **Step 3: Commit**
```bash
git add js/replay.js css/style.css
git commit -m "feat(replay): phase-score path coloring, rich traffic markers, display menu"
```

---

### Task 10: js/engine-cluster.js — instrument cluster

**Files:**
- Create: `js/engine-cluster.js`

- [ ] **Step 1: Create the file**

```javascript
// js/engine-cluster.js

let _fd = null, _thr = null;

export function initEngineCluster(fd, thr) {
    _fd = fd;
    _thr = thr;
    const el = document.getElementById('engine-cluster');
    if (!el) return;
    el.innerHTML = `
        <div class="ec-grid" id="egt-grid"></div>
        <div class="ec-grid" id="cht-grid"></div>
        <div class="ec-strip" id="ec-strip"></div>
    `;
    seek(0);
    window._engineCluster = { seek };
}

export function seek(idx) {
    if (!_fd) return;
    const thr = _thr || {};
    const chtCaution = thr.chtCaution || 380;
    const chtDanger  = thr.chtDanger  || 435;
    const egtDanger  = thr.egtDanger  || 1650;

    const egtGrid = document.getElementById('egt-grid');
    const chtGrid = document.getElementById('cht-grid');
    const strip   = document.getElementById('ec-strip');
    if (!egtGrid || !chtGrid || !strip) return;

    const maxEgt = Math.max(...[0,1,2,3].map(c => _fd.egt[c][idx]));
    const maxCht = Math.max(...[0,1,2,3].map(c => _fd.cht[c][idx]));

    egtGrid.innerHTML = [0,1,2,3].map(c => {
        const v = _fd.egt[c][idx];
        const cls = v > egtDanger ? 'danger' : v === maxEgt && v > 1200 ? 'caution' : '';
        return `<div class="ec-tile ${cls}">
          <div class="ec-tile-label">EGT ${c+1}</div>
          <div class="ec-tile-value">${v > 0 ? v.toFixed(0) : '—'}°</div>
        </div>`;
    }).join('');

    chtGrid.innerHTML = [0,1,2,3].map(c => {
        const v   = _fd.cht[c][idx];
        const roc = _fd.chtRoc ? _fd.chtRoc[c][idx] : null;
        const rocStr = roc !== null ? `${roc >= 0 ? '+' : ''}${roc.toFixed(0)}°/min` : '';
        const rocWarn = roc !== null && _fd.pctPower[idx] > 65 && Math.abs(roc) > 50;
        const cls = v > chtDanger ? 'danger' : v > chtCaution ? 'caution' : '';
        return `<div class="ec-tile ${cls}">
          <div class="ec-tile-label">CHT ${c+1}</div>
          <div class="ec-tile-value">${v > 0 ? v.toFixed(0) : '—'}°</div>
          ${roc !== null ? `<div class="ec-tile-roc ${rocWarn ? 'warn' : ''}">${rocStr}</div>` : ''}
        </div>`;
    }).join('');

    const rpm = _fd.rpm[idx];
    const ff  = _fd.fuelFlow[idx];
    const pwr = _fd.pctPower[idx];
    const op  = _fd.opCondition[idx] || '—';
    const gal = _fd.gallonsRem[idx];
    strip.innerHTML = `
        <span><span class="label">RPM</span> ${rpm.toFixed(0)}</span>
        <span><span class="label">FF</span> ${ff.toFixed(1)} gph</span>
        <span><span class="label">PWR</span> ${pwr.toFixed(0)}%</span>
        <span><span class="label">Op</span> ${op}</span>
        <span><span class="label">Fuel rem</span> ${gal.toFixed(1)} gal</span>
    `;
}
```

- [ ] **Step 2: Commit**
```bash
git add js/engine-cluster.js
git commit -m "feat(engine-cluster): live EGT/CHT instrument cluster with CHT ROC"
```

---

### Task 11: js/vspeeds.js — V-speeds modal

**Files:**
- Create: `js/vspeeds.js`

- [ ] **Step 1: Create the file**

```javascript
// js/vspeeds.js

const V_SPEED_DEFS = [
    { key: 'vrKias',   label: 'Vr',  desc: 'Rotation speed' },
    { key: 'vs0Kias',  label: 'Vs0', desc: 'Stall, flaps down' },
    { key: 'vs1Kias',  label: 'VS1', desc: 'Stall, flaps up' },
    { key: 'vxKias',   label: 'Vx',  desc: 'Best angle of climb' },
    { key: 'vyKias',   label: 'Vy',  desc: 'Best rate of climb' },
    { key: 'vcmKias',  label: 'Vcm', desc: 'Recommended touchdown' },
    { key: 'vrefKias', label: 'Vref', desc: 'Landing reference' },
    { key: 'vneKias',  label: 'Vne', desc: 'Never exceed' },
    { key: 'vnoKias',  label: 'Vno', desc: 'Max structural cruise' },
];

let _defaults = {};
let _tailNumber = '';

export function initVspeeds(defaults, tailNumber) {
    _defaults = defaults || {};
    _tailNumber = tailNumber || 'default';
    _buildTable();
    document.getElementById('vspeeds-btn')?.addEventListener('click', () => {
        document.getElementById('vspeeds-modal')?.classList.remove('hidden');
    });
    document.getElementById('vspeeds-cancel')?.addEventListener('click', () => {
        document.getElementById('vspeeds-modal')?.classList.add('hidden');
    });
    document.getElementById('vspeeds-save')?.addEventListener('click', _save);
}

function _storageKey() { return `vspeeds_${_tailNumber}`; }

function _loadOverrides() {
    try { return JSON.parse(localStorage.getItem(_storageKey()) || '{}'); }
    catch (_) { return {}; }
}

function _buildTable() {
    const table = document.getElementById('vspeeds-table');
    if (!table) return;
    const overrides = _loadOverrides();
    table.innerHTML = `
        <thead>
          <tr>
            <th>Speed</th><th>Description</th>
            <th style="text-align:right">Default (kt)</th>
            <th style="text-align:right">Override (kt)</th>
          </tr>
        </thead>
        <tbody>
          ${V_SPEED_DEFS.map(def => `
            <tr>
              <td style="font-weight:800;font-family:var(--font-instrument)">${def.label}</td>
              <td style="color:var(--text-muted)">${def.desc}</td>
              <td style="text-align:right;font-family:var(--font-instrument)">${_defaults[def.key] ?? '—'}</td>
              <td style="text-align:right">
                <input type="number" data-key="${def.key}"
                  value="${overrides[def.key] ?? ''}"
                  placeholder="${_defaults[def.key] ?? ''}"
                  min="0" max="400" step="1">
              </td>
            </tr>
          `).join('')}
        </tbody>
    `;
}

function _save() {
    const table = document.getElementById('vspeeds-table');
    const overrides = {};
    table?.querySelectorAll('input[data-key]').forEach(inp => {
        const v = parseFloat(inp.value);
        if (!isNaN(v) && v > 0) overrides[inp.dataset.key] = v;
    });
    try { localStorage.setItem(_storageKey(), JSON.stringify(overrides)); } catch (_) {}
    document.getElementById('vspeeds-modal')?.classList.add('hidden');
}

// Returns merged thresholds: overrides win over defaults.
export function getVspeeds() {
    const overrides = _loadOverrides();
    return { ..._defaults, ...overrides };
}
```

- [ ] **Step 2: Commit**
```bash
git add js/vspeeds.js
git commit -m "feat(vspeeds): V-speeds modal with localStorage overrides per aircraft"
```

---

### Task 12: js/ai-review.js — AI Review tab

**Files:**
- Create: `js/ai-review.js`

- [ ] **Step 1: Create the file**

```javascript
// js/ai-review.js
import { closestApproach } from './traffic-parser.js';

export function initAiReview(fd, scores, phaseScores, events, trafficData) {
    const panel = document.getElementById('review-panel');
    if (!panel) return;

    const col = s => s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red';
    const bar = s => `<div class="review-score-bar-wrap"><div class="review-score-bar ${col(s)}" style="width:${s}%"></div></div>`;

    const topEvents = [...events]
        .sort((a, b) => (b.level === 'red' ? 2 : b.level === 'orange' ? 1 : 0) -
                        (a.level === 'red' ? 2 : a.level === 'orange' ? 1 : 0))
        .slice(0, 3);

    const fmt = d => d ? d.toISOString().slice(11, 16) + 'Z' : '--:--Z';
    const o = fd.oooi || {};

    panel.innerHTML = `
        <div class="review-top">
          <div class="review-summary">
            <h4>FLIGHT SUMMARY</h4>
            <div class="review-flight-info">
              <div><b>${fd.depIcao || '?'} → ${fd.destIcao || '?'}</b></div>
              <div>${fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : '—'}
                   &nbsp; ${fmt(o.off)} – ${fmt(o.on)}</div>
              <div>Block ${fd.blockMinutes.toFixed(0)} min · Air ${fd.airMinutes.toFixed(0)} min · ${fd.totalDistanceNm.toFixed(0)} nm</div>
              ${fd.depMetar  ? `<div style="font-size:0.75rem;margin-top:4px;color:var(--text-muted)">${fd.depMetar}</div>`  : ''}
              ${fd.destMetar ? `<div style="font-size:0.75rem;color:var(--text-muted)">${fd.destMetar}</div>` : ''}
            </div>
          </div>
          <div class="review-scores">
            <h4>SCORE BREAKDOWN</h4>
            <div class="review-score-row">
              <span class="review-score-label">Engine Mgmt</span>${bar(scores.engineMgmt.overall)}
              <span class="review-score-num">${scores.engineMgmt.overall}</span>
            </div>
            <div class="review-score-row">
              <span class="review-score-label">Airmanship</span>${bar(scores.airmanship.overall)}
              <span class="review-score-num">${scores.airmanship.overall}</span>
            </div>
            ${scores.approach ? `
            <div class="review-score-row">
              <span class="review-score-label">Approach</span>${bar(scores.approach.overall)}
              <span class="review-score-num">${scores.approach.overall}</span>
            </div>` : ''}
            <div class="review-score-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">
              <span class="review-score-label"><b>Overall</b></span>${bar(scores.overall)}
              <span class="review-score-num"><b>${scores.overall}</b></span>
            </div>
            ${topEvents.length ? `
            <div style="margin-top:10px">
              <div style="font-size:0.7rem;font-weight:800;color:var(--text-label);margin-bottom:4px">TOP EVENTS</div>
              ${topEvents.map(e => `
                <div class="review-event-item">
                  <span style="color:${e.level==='red'?'var(--color-danger)':'var(--color-caution)'}">⚠</span>
                  ${e.type} — ${e.detail}
                </div>`).join('')}
            </div>` : ''}
          </div>
        </div>
        <div class="review-narrative" id="review-narrative">
          <div class="review-generate-wrap">
            <button class="hdr-btn" id="review-generate-btn">Generate AI Review ▶</button>
            <span id="review-status" style="font-size:0.8rem;color:var(--text-muted)"></span>
          </div>
          <div id="review-content"></div>
        </div>
    `;

    // Try loading cached review
    fetch(`/api/review/${encodeURIComponent(fd.filename)}`)
        .then(r => r.json())
        .then(cached => {
            if (cached?.narrative) _renderNarrative(cached.narrative);
        })
        .catch(() => {});

    document.getElementById('review-generate-btn')?.addEventListener('click', () =>
        _generateReview(fd, scores, events, trafficData)
    );
}

function _generateReview(fd, scores, events, trafficData) {
    const status = document.getElementById('review-status');
    const btn    = document.getElementById('review-generate-btn');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Generating… (15–30 seconds)';

    const payload = _buildPayload(fd, scores, events, trafficData);
    fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) throw new Error(data.error);
        fetch(`/api/review/${encodeURIComponent(fd.filename)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ narrative: data.narrative }),
        }).catch(() => {});
        _renderNarrative(data.narrative);
        if (status) status.textContent = '';
    })
    .catch(err => {
        if (status) status.textContent = `Failed: ${err.message}`;
        if (btn) btn.disabled = false;
    });
}

function _renderNarrative(narrative) {
    const content = document.getElementById('review-content');
    const btn = document.getElementById('review-generate-btn');
    const status = document.getElementById('review-status');
    if (btn) { btn.textContent = 'Refresh ↺'; btn.disabled = false; }
    if (status) status.textContent = '';
    if (!content) return;

    // Split narrative into sections by category headers
    const sections = _parseSections(narrative);
    content.innerHTML = sections.map(sec => `
        <div class="review-section">
          ${sec.title ? `<div class="review-section-hdr" data-open="1">▼ ${sec.title}</div>` : ''}
          <div class="review-section-body">${sec.body}</div>
        </div>
    `).join('');

    content.querySelectorAll('.review-section-hdr').forEach(hdr => {
        hdr.addEventListener('click', () => {
            const open = hdr.dataset.open === '1';
            hdr.dataset.open = open ? '0' : '1';
            hdr.textContent = (open ? '▶ ' : '▼ ') + hdr.textContent.slice(2);
            const body = hdr.nextElementSibling;
            if (body) body.style.display = open ? 'none' : '';
        });
    });
}

function _parseSections(text) {
    const lines = text.split('\n');
    const sections = [];
    let current = { title: '', body: '' };
    const headingRe = /^(Engine Management|Airmanship|Approach|Summary|Overall)/i;
    for (const line of lines) {
        if (headingRe.test(line.trim())) {
            if (current.body.trim()) sections.push(current);
            current = { title: line.trim(), body: '' };
        } else {
            current.body += line + '\n';
        }
    }
    if (current.body.trim() || current.title) sections.push(current);
    return sections.length > 0 ? sections : [{ title: '', body: text }];
}

function _buildPayload(fd, scores, events, trafficData) {
    const fmt = d => d ? d.toISOString().slice(11, 16) + 'Z' : '--:--Z';
    const o = fd.oooi || {};
    const closest = closestApproach(trafficData?.proximityEvents || []);
    const avgOf = (arr) => arr.reduce((a,b) => a+b, 0) / arr.length;

    const phaseStats = {};
    for (const phase of fd.phases) {
        const idxs = [];
        for (let i = phase.startIdx; i <= phase.endIdx; i++) idxs.push(i);
        if (!idxs.length) continue;
        phaseStats[phase.name] = {
            durationMin: Math.round(idxs.length / 60),
            avgCht: Math.round(avgOf(idxs.map(i => Math.max(...[0,1,2,3].map(c => fd.cht[c][i]))))),
            avgEgt: Math.round(avgOf(idxs.map(i => Math.max(...[0,1,2,3].map(c => fd.egt[c][i]))))),
            avgFuelFlow: parseFloat(avgOf(idxs.map(i => fd.fuelFlow[i])).toFixed(1)),
        };
    }

    return {
        flight:   `${fd.depIcao || '?'}→${fd.destIcao || '?'}`,
        date:     fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : '—',
        aircraft: 'RV-9A N194JT, Lycoming O-360 A1A',
        oooi:     { outZ: fmt(o.out), offZ: fmt(o.off), onZ: fmt(o.on), inZ: fmt(o.in) },
        duration: { blockMin: Math.round(fd.blockMinutes), airMin: Math.round(fd.airMinutes),
                    distNm: Math.round(fd.totalDistanceNm) },
        conditions: { depMetar: fd.depMetar, destMetar: fd.destMetar,
                      avgHeadwindKt: Math.round(fd.avgHeadwindKt || 0) },
        scores:   { overall: scores.overall, engineMgmt: scores.engineMgmt.overall,
                    airmanship: scores.airmanship.overall, approach: scores.approach?.overall ?? null },
        events:   events.slice(0, 20).map(e => ({ timeMin: Math.round(e.tSec/60), type: e.type, detail: e.detail })),
        phaseStats,
        dmmsViolations: events.filter(e => e.type === 'DMMS_VIOLATION').length,
        redBoxSeconds:  events.filter(e => e.type === 'RED_BOX').length,
        chtRocEvents:   events.filter(e => e.type === 'CHT_ROC_CAUTION').length,
        closestTraffic: closest ? { callsign: closest.callsign, horizNm: parseFloat(closest.horizNm.toFixed(1)),
                                    vertFt: closest.vertFt } : null,
    };
}
```

- [ ] **Step 2: Commit**
```bash
git add js/ai-review.js
git commit -m "feat(ai-review): AI Review tab with summary, scores, cached narrative"
```

---

### Task 13: js/app.js — wire all new modules

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: Replace app.js**

```javascript
// js/app.js
import { parseCSV }               from './csv-parser.js';
import { detectOOOI }             from './oooi.js';
import { parseTrafficNDJSON, computeProximityEvents, closestApproach } from './traffic-parser.js';
import { computeChtRoc, scoreEngineMgmt, scoreAirmanship, scoreApproach, scorePhases } from './scorer.js';
import { detectEvents }           from './event-detector.js';
import { initReplay }             from './replay.js';
import { initCharts }             from './charts.js';
import { initPhaseSidebar }       from './phase-sidebar.js';
import { initScorePanel, seek as seekScorePanel } from './score-panel.js';
import { initEngineCluster }      from './engine-cluster.js';
import { initVspeeds, getVspeeds } from './vspeeds.js';
import { initAiReview }           from './ai-review.js';
import { applyAirspeeds }         from './flight-physics.js';

const API = '';

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadFlightList() {
    const r = await fetch(`${API}/api/flights`);
    const flights = await r.json();
    const list = document.getElementById('flight-list');
    if (!flights.length) {
        list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px">No flights found in ~/flights</p>';
        return;
    }
    list.innerHTML = flights.map(f => `
        <div class="flight-item" data-name="${escHtml(f.name)}">
          <span class="flight-item-name">${escHtml(f.name)}</span>
          ${f.hasTraffic ? '<span class="flight-item-badge">+ TRAFFIC</span>' : ''}
        </div>
    `).join('');
    list.querySelectorAll('.flight-item').forEach(el =>
        el.addEventListener('click', () => openFlight(el.dataset.name))
    );
}

async function openFlight(filename) {
    document.getElementById('flight-selector').classList.add('hidden');
    document.getElementById('debrief-root').classList.remove('hidden');

    const csvResp = await fetch(`${API}/api/flights/${encodeURIComponent(filename)}`);
    if (!csvResp.ok) {
        document.getElementById('hdr-route').textContent = `Error loading ${filename}`;
        return;
    }
    const csvText = await csvResp.text();
    const fd = parseCSV(csvText);
    fd.filename = filename;

    const m = filename.match(/\d{8}_([A-Z0-9]{3,4})-([A-Z0-9]{3,4})/);
    if (m) { fd.depIcao = m[1]; fd.destIcao = m[2]; }

    let trafficData = null;
    const trafficFilename = filename.replace(/\.csv$/, '_traffic.ndjson');
    try {
        const tr = await fetch(`${API}/api/flights/${encodeURIComponent(trafficFilename)}`);
        if (tr.ok) {
            const ndjson = await tr.text();
            trafficData = parseTrafficNDJSON(ndjson);
            trafficData.proximityEvents = computeProximityEvents(
                trafficData.snapshots, fd.lat, fd.lon, fd.altFt
            );
        }
    } catch (_) {}

    fd.oooi = detectOOOI(fd);
    fd.blockMinutes = fd.oooi.blockMinutes;
    fd.airMinutes   = fd.oooi.airMinutes;

    const isoWinds = Array.from({ length: fd.rows }, (_, i) => ({
        windSpeed: 0, windDir: 0,
        tempC: 15 - fd.altFt[i] * 0.002,
    }));
    applyAirspeeds(fd, isoWinds, new Float32Array(fd.rows).fill(29.92));

    // Compute CHT ROC and attach to fd
    fd.chtRoc = computeChtRoc(fd);

    fetchMETARs(fd);

    const rawThr = await loadThresholds();

    // Initialize V-speeds modal with defaults; get merged thresholds
    const tailMatch = filename.match(/N\d+[A-Z]+/i);
    initVspeeds(rawThr, tailMatch ? tailMatch[0] : 'default');
    const thr = getVspeeds();

    const scores = {
        engineMgmt: scoreEngineMgmt(fd, thr),
        airmanship: scoreAirmanship(fd, thr, trafficData),
        approach:   scoreApproach(fd, thr),
    };
    scores.overall = Math.round(
        ([scores.engineMgmt.overall, scores.airmanship.overall,
          scores.approach?.overall ?? 100].reduce((a,b) => a+b, 0)) / 3
    );

    const phaseScores = scorePhases(fd, thr, trafficData);
    const events = detectEvents(fd, trafficData, thr);

    // Expose on window for console debugging
    window._fd = fd;
    window._phaseScores = phaseScores;
    window._events = events;

    renderHeader(fd);

    // Init all panels
    initPhaseSidebar(phaseScores, (rowIdx, phaseIdx) => {
        const scrubber = document.getElementById('scrubber');
        scrubber.value = rowIdx;
        scrubber.dispatchEvent(new Event('input'));
        window._charts?.zoomToPhase(phaseIdx);
    });

    initScorePanel(fd, phaseScores, events, thr);
    initReplay(fd, trafficData, phaseScores);
    initEngineCluster(fd, thr);
    initCharts(fd, phaseScores);
    initAiReview(fd, scores, phaseScores, events, trafficData);

    wireScrubber(fd, events, phaseScores);
    wireTabSwitching();
    appendTrainingLog(filename, scores, events, trafficData, fd);
}

async function loadThresholds() {
    try {
        const r = await fetch('http://192.168.1.77:8090/aircraft-config.json',
            { signal: AbortSignal.timeout(2000) });
        if (r.ok) return await r.json();
    } catch (_) {}
    return {
        chtCaution: 380, chtDanger: 435, egtDanger: 1650,
        oilTempMin: 100, oilTempMax: 245,
        vnoKias: 165, vneKias: 202, vs1Kias: 50, vrefKias: 65,
        typicalSfc: 0.42,
    };
}

async function fetchMETARs(fd) {
    if (!fd.depIcao || !fd.destIcao) return;
    const offUtc = fd.oooi?.off?.toISOString() || '';
    const onUtc  = fd.oooi?.on?.toISOString()  || '';
    try {
        const [dep, dest] = await Promise.all([
            fetch('/api/metar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ icao: fd.depIcao, utc: offUtc }) }).then(r => r.json()),
            fetch('/api/metar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ icao: fd.destIcao, utc: onUtc }) }).then(r => r.json()),
        ]);
        fd.depMetar  = dep.metar  || '';
        fd.destMetar = dest.metar || '';
    } catch (_) {}
}

function renderHeader(fd) {
    const route = `${fd.depIcao || '?'} → ${fd.destIcao || '?'}`;
    const stats = `Block ${fd.blockMinutes.toFixed(0)}m · Air ${fd.airMinutes.toFixed(0)}m · ${fd.totalDistanceNm.toFixed(0)} nm`;
    document.getElementById('hdr-route').textContent = route;
    document.getElementById('hdr-stats').textContent = stats;
    document.getElementById('back-btn').addEventListener('click', () => location.reload());
}

function wireScrubber(fd, events, phaseScores) {
    const scrubber = document.getElementById('scrubber');
    scrubber.max = fd.rows - 1;

    // Event ticks
    const ticks = document.getElementById('event-ticks');
    if (ticks) {
        ticks.innerHTML = events.map(e => {
            const pct = (e.tSec / (fd.rows - 1)) * 100;
            const color = e.level === 'red' ? '#cc2222' : e.level === 'purple' ? '#7b2d8b' : '#b87000';
            return `<div style="position:absolute;left:${pct}%;width:2px;height:100%;background:${color};top:0;opacity:0.7"></div>`;
        }).join('');
    }

    let playing = false, speed = 1, rafId = null, lastTime = null, accumulator = 0;
    const playBtn = document.getElementById('play-btn');

    document.querySelectorAll('.speed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            speed = parseInt(btn.dataset.speed);
        });
    });

    function tick(ts) {
        if (!playing) return;
        if (lastTime !== null) {
            accumulator += (ts - lastTime) / 1000 * speed;
            const advance = Math.floor(accumulator);
            if (advance > 0) {
                accumulator -= advance;
                const cur = parseInt(scrubber.value);
                const next = Math.min(fd.rows - 1, cur + advance);
                scrubber.value = next;
                scrubber.dispatchEvent(new Event('input'));
                if (next >= fd.rows - 1) { playing = false; if (playBtn) playBtn.textContent = '▶'; accumulator = 0; return; }
            }
        }
        lastTime = ts;
        rafId = requestAnimationFrame(tick);
    }

    if (playBtn) {
        playBtn.addEventListener('click', () => {
            playing = !playing;
            playBtn.textContent = playing ? '⏸' : '▶';
            if (playing) { lastTime = null; accumulator = 0; rafId = requestAnimationFrame(tick); }
            else if (rafId) cancelAnimationFrame(rafId);
        });
    }

    scrubber.addEventListener('input', () => {
        const idx = parseInt(scrubber.value);
        updateTimeDisplay(fd, idx);
        window._replay?.seek(idx);
        window._charts?.seek(idx);
        window._scorePanel?.seek(idx);
        window._phaseSidebar?.seek(idx);
        window._engineCluster?.seek(idx);
    });
}

function updateTimeDisplay(fd, idx) {
    if (!fd.startUtc) return;
    const t = new Date(fd.startUtc.getTime() + idx * 1000);
    const el = document.getElementById('time-display');
    if (el) el.textContent = t.toISOString().slice(11, 19) + 'Z';
}

function wireTabSwitching() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            _switchTab(tab);
        });
    });
}

function _switchTab(tab) {
    const threePanel  = document.getElementById('three-panel');
    const chartPanel  = document.getElementById('chart-panel');
    const reviewPanel = document.getElementById('review-panel');
    const mapPanel    = document.getElementById('map-panel');
    const engineCluster = document.getElementById('engine-cluster');
    const trackChart  = document.getElementById('track-chart-wrap');
    const engineChart = document.getElementById('engine-chart-wrap');

    threePanel?.classList.toggle('hidden', tab === 'review');
    chartPanel?.classList.toggle('hidden', tab === 'review');
    reviewPanel?.classList.toggle('hidden', tab !== 'review');

    if (tab !== 'review') {
        mapPanel?.classList.toggle('hidden', tab !== 'track');
        engineCluster?.classList.toggle('hidden', tab !== 'engine');
        trackChart?.classList.toggle('hidden', tab !== 'track');
        engineChart?.classList.toggle('hidden', tab !== 'engine');
    }

    // Invalidate Leaflet size on track tab switch (map may have been hidden)
    if (tab === 'track') {
        setTimeout(() => window._replay && L.Map && document.getElementById('map') &&
            (window._leafletMap = window._leafletMap || document.getElementById('map')._leaflet_id), 100);
    }
}

function appendTrainingLog(filename, scores, events, trafficData, fd) {
    const entry = {
        date: fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
        route: filename.replace(/\.csv$/, ''),
        scores: { overall: scores.overall, engineMgmt: scores.engineMgmt.overall,
                  airmanship: scores.airmanship.overall, approach: scores.approach?.overall ?? null },
        eventCounts: events.reduce((acc, e) => { acc[e.type] = (acc[e.type]||0)+1; return acc; }, {}),
        trafficProximityEvents: trafficData?.proximityEvents?.length ?? 0,
        closestTrafficNm: closestApproach(trafficData?.proximityEvents || [])?.horizNm ?? null,
    };
    fetch('/api/training-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
    }).catch(() => {});
}

// ── Init ──────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const preload = params.get('file');
if (preload) openFlight(preload);
else loadFlightList();
```

- [ ] **Step 2: Reload browser and load a flight**

Open `http://192.168.1.77:8092`, select a flight. Verify:
- Header shows route + stats
- Phase sidebar populated with scored phases
- Map shows flight track
- Score panel shows parameter rows
- Chart panel shows Alt/Speed overlays
- Playback bar works — scrubbing updates map, score panel, phase sidebar

- [ ] **Step 3: Verify tab switching**

Click Engine tab → instrument cluster appears, engine chart renders. Click AI Review → summary + score breakdown visible. Click back to Flight Track → map visible.

- [ ] **Step 4: Commit**
```bash
git add js/app.js
git commit -m "feat(app): wire 3-tab layout, phase sidebar, score panel, engine cluster, V-speeds"
```

---

### Task 14: server/debrief-server.py — /api/terrain endpoint

**Files:**
- Modify: `server/debrief-server.py`

- [ ] **Step 1: Read the existing server file to find the right insertion point**

```bash
grep -n "def do_POST\|def do_GET\|api/winds\|api/metar\|class.*Handler" server/debrief-server.py | head -30
```

- [ ] **Step 2: Add terrain endpoint**

Locate the `do_POST` method handler. After the `elif path == '/api/metar':` block, add:

```python
        elif path == '/api/terrain':
            body = json.loads(self.rfile.read(content_length))
            points = body.get('points', [])
            if not points:
                self._json({'elevations': []})
                return
            # Batch to max 100 points per request to open-elevation.com
            elevations = []
            batch_size = 100
            for i in range(0, len(points), batch_size):
                batch = points[i:i+batch_size]
                try:
                    resp = requests.post(
                        'https://api.open-elevation.com/api/v1/lookup',
                        json={'locations': [{'latitude': p['lat'], 'longitude': p['lon']} for p in batch]},
                        timeout=10,
                    )
                    results = resp.json().get('results', [])
                    elevations.extend(r.get('elevation', 0) * 3.28084 for r in results)  # m → ft
                except Exception:
                    elevations.extend(0 for _ in batch)
            self._json({'elevations': elevations})
```

- [ ] **Step 3: Restart server and test endpoint**

```bash
curl -s -X POST http://localhost:8092/api/terrain \
  -H 'Content-Type: application/json' \
  -d '{"points":[{"lat":34.94,"lon":-81.05}]}' | python3 -m json.tool
```
Expected: `{"elevations": [<some_positive_number_in_feet>]}`

- [ ] **Step 4: Commit**
```bash
git add server/debrief-server.py
git commit -m "feat(server): add /api/terrain endpoint for AGL altitude computation"
```

---

### Task 15: Self-review and final integration test

- [ ] **Step 1: Full integration test**

Start server: `python3 server/debrief-server.py`

Load a flight and verify all 15 items from the spec's enhancement summary table:

| Enhancement | Verify |
|---|---|
| Three-panel shell | Phase sidebar left, map center, score panel right |
| Phase sidebar score badges | Each phase row shows score with green/amber/red |
| Score/rationale panel | Scrubbing updates parameter rows in real time |
| Phase-color-coded flight path | Polyline segments use score colors |
| ADS-B traffic markers | (requires traffic file) Markers show callsign, alt, heading icon |
| Traffic display menu | ✈ ⚙ button opens popover; toggling fields updates markers |
| Multi-overlay chart | Toggle pills add/remove series; dual y-axes visible |
| Phase color band | Colored strip at bottom of scrubber shows phase scores |
| Engine instrument cluster | Engine tab shows 4-cylinder EGT/CHT grid with ROC |
| CHT ROC per cylinder | ROC values shown on CHT tiles; amber when >50°/min |
| CHT ROC chart overlay | Engine chart CHT ROC toggle adds dashed lines |
| V-speeds modal | V-speeds ⚙ button opens modal; save persists to localStorage |
| AI Review tab | Summary + score breakdown + Generate button visible |
| Cached AI review | Second load of same flight shows cached narrative |
| Traffic proximity pulse | (requires traffic file) Proximity marker pulses amber |
| localStorage persistence | Reload browser — traffic display settings and V-speeds preserved |

- [ ] **Step 2: Fix any regressions found during integration test**

- [ ] **Step 3: Final commit**
```bash
git add -A
git commit -m "feat: complete ForeFlight-inspired UI enhancement suite"
```
