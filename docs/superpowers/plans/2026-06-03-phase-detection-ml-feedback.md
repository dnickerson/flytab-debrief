# Phase Detection, ML Display & Pilot Feedback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ML-only phase segmentation with physics-based detection (altitude derivative + RPM/speed), surface ML disagreements in the sidebar, and let pilots correct labels that save to a training dataset for FlyTab model retraining.

**Architecture:** A new `js/phase-detector.js` module computes ground sub-phases from RPM/speed and flight phases from smoothed altitude rate, attaches `fd.altRate` to FlightData, and is called from `app.js` after OOOI detection. The phase sidebar shows ML disagreement badges and an inline correction panel. Corrections persist to `{flight}.phases.json` via two new server endpoints and append training entries to the existing JSONL training log.

**Tech Stack:** Vanilla ES modules, Vitest, Python 3 http.server

**Working directory:** `/home/dananickerson/flytab-debrief/.claude/worktrees/feat+core`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `js/phase-detector.js` | **Create** | `detectPhases(fd)` — all phase detection logic, attaches `fd.altRate` |
| `tests/phase-detector.test.js` | **Create** | Unit tests for detection algorithm |
| `js/csv-parser.js` | **Modify** | Remove `segmentPhases` from `parseCSV`, init `fd.altRate = null` |
| `js/scorer.js` | **Modify** | `scorePhases` uses `seg.pilotLabel ?? seg.name` for scoring logic |
| `js/app.js` | **Modify** | Call `detectPhases`, load saved corrections overlay, update `fd.approaches` |
| `js/score-panel.js` | **Modify** | Add GS, ROC, ROD rows to AIRMANSHIP section |
| `js/phase-sidebar.js` | **Modify** | ML badge, disagreement counter, phase numbering, inline correction panel |
| `css/style.css` | **Modify** | Styles for ML badge, correction panel |
| `server/debrief-server.py` | **Modify** | `GET/PUT /api/phases/{filename}` endpoints |

---

### Task 1: `detectPhases` — physics-based phase detection (TDD)

**Files:**
- Create: `tests/phase-detector.test.js`
- Create: `js/phase-detector.js`

- [ ] **Step 1: Create the test file**

```javascript
// tests/phase-detector.test.js
import { describe, it, expect } from 'vitest';
import { detectPhases } from '../js/phase-detector.js';

// Minimal FlightData builder for tests
function makeFd({ n = 200, altProfile, rpmProfile, spdProfile, mlPhases } = {}) {
    const fd = {
        rows: n,
        altFt:    new Float32Array(n),
        speedKts: new Float32Array(n),
        rpm:      new Float32Array(n),
        mlPhase:  Array(n).fill('cruise'),
        lat:      new Float32Array(n),
        lon:      new Float32Array(n),
        oooi:     null,
        altRate:  null,
    };
    if (altProfile)  altProfile.forEach(([i, v]) => fd.altFt[i]    = v);
    if (rpmProfile)  rpmProfile.forEach(([i, v]) => fd.rpm[i]      = v);
    if (spdProfile)  spdProfile.forEach(([i, v]) => fd.speedKts[i] = v);
    if (mlPhases)    mlPhases.forEach(([i, v])   => fd.mlPhase[i]  = v);
    return fd;
}

describe('detectPhases', () => {
    it('attaches fd.altRate Float32Array of length fd.rows', () => {
        const fd = makeFd();
        detectPhases(fd);
        expect(fd.altRate).toBeInstanceOf(Float32Array);
        expect(fd.altRate.length).toBe(fd.rows);
    });

    it('returns array and sets fd.phases', () => {
        const fd = makeFd();
        const segs = detectPhases(fd);
        expect(Array.isArray(segs)).toBe(true);
        expect(fd.phases).toBe(segs);
    });

    it('detects startup when RPM rises above 500 for 3 consecutive rows', () => {
        const fd = makeFd({ n: 300 });
        // RPM starts at 0, rises at row 10
        for (let i = 10; i < 300; i++) fd.rpm[i] = 1000;
        detectPhases(fd);
        const startup = fd.phases.find(s => s.name === 'startup');
        expect(startup).toBeDefined();
        expect(startup.startIdx).toBe(10);
    });

    it('detects runup when RPM >= 1800 while speed < 3', () => {
        const fd = makeFd({ n: 400 });
        // startup rows 10–130, warmup 130–200, runup 200–250
        for (let i = 10; i < 400; i++) fd.rpm[i] = 1000;
        for (let i = 200; i < 250; i++) fd.rpm[i] = 2000; // runup
        detectPhases(fd);
        const runup = fd.phases.find(s => s.name === 'runup');
        expect(runup).toBeDefined();
        expect(runup.startIdx).toBeGreaterThanOrEqual(200);
    });

    it('detects taxi when speed >= 3 on ground', () => {
        const fd = makeFd({ n: 400 });
        for (let i = 10; i < 400; i++) fd.rpm[i] = 1000;
        for (let i = 150; i < 200; i++) fd.speedKts[i] = 15; // taxi
        detectPhases(fd);
        const taxi = fd.phases.find(s => s.name === 'taxi');
        expect(taxi).toBeDefined();
    });

    it('classifies sustained +200fpm as climb', () => {
        const fd = makeFd({ n: 500 });
        // Ground: rows 0–49 (rpm running, speed 0)
        for (let i = 0; i < 500; i++) fd.rpm[i] = 1000;
        // Takeoff at row 50: alt jumps above 200ft, speed > 40
        for (let i = 50; i < 500; i++) {
            fd.altFt[i]    = 500 + (i - 50) * 10;  // climbing ~600 fpm
            fd.speedKts[i] = 90;
        }
        detectPhases(fd);
        const climb = fd.phases.find(s => s.name === 'climb');
        expect(climb).toBeDefined();
    });

    it('classifies stable altitude as cruise', () => {
        const fd = makeFd({ n: 600 });
        for (let i = 0; i < 600; i++) {
            fd.rpm[i]      = 1000;
            fd.altFt[i]    = i < 50 ? 0 : i < 150 ? (i - 50) * 10 : 3500; // climb then stable
            fd.speedKts[i] = i < 50 ? 0 : 120;
        }
        detectPhases(fd);
        const cruise = fd.phases.find(s => s.name === 'cruise');
        expect(cruise).toBeDefined();
    });

    it('detects approach when ml_phase=approach for >= 10 consecutive rows', () => {
        const fd = makeFd({ n: 500 });
        for (let i = 0; i < 500; i++) {
            fd.altFt[i]    = i < 50 ? 0 : 3500 - Math.max(0, i - 200) * 5;
            fd.speedKts[i] = i < 50 ? 0 : 100;
            fd.rpm[i]      = 1000;
        }
        for (let i = 400; i < 430; i++) fd.mlPhase[i] = 'approach';
        detectPhases(fd);
        const approach = fd.phases.find(s => s.name === 'approach');
        expect(approach).toBeDefined();
        expect(approach.startIdx).toBe(400);
        expect(approach.endIdx).toBe(429);
    });

    it('sets mlLabel to mode of ml_phase values across segment', () => {
        const fd = makeFd({ n: 500 });
        for (let i = 0; i < 500; i++) { fd.altFt[i] = 3500; fd.speedKts[i] = i < 50 ? 0 : 120; fd.rpm[i] = 1000; }
        // Mostly cruise but a few rows labeled climb
        for (let i = 100; i < 110; i++) fd.mlPhase[i] = 'climb';
        detectPhases(fd);
        const seg = fd.phases.find(s => s.startIdx <= 100 && s.endIdx >= 110);
        expect(seg).toBeDefined();
        expect(seg.mlLabel).toBe('cruise'); // mode is still cruise
    });

    it('sets mlAgreement=false when mlLabel differs from name', () => {
        const fd = makeFd({ n: 500 });
        for (let i = 0; i < 500; i++) { fd.rpm[i] = 1000; fd.speedKts[i] = i < 50 ? 0 : 120; }
        for (let i = 50; i < 500; i++) fd.altFt[i] = 500 + (i - 50) * 8; // climbing
        // ML says cruise for the climb segment
        detectPhases(fd);
        const climb = fd.phases.find(s => s.name === 'climb');
        if (climb) expect(climb.mlAgreement).toBe(false); // ML says cruise, we say climb
    });

    it('pilotLabel is null on all segments initially', () => {
        const fd = makeFd();
        detectPhases(fd);
        for (const seg of fd.phases) expect(seg.pilotLabel).toBeNull();
    });

    it('each segment has durationSec = endIdx - startIdx + 1', () => {
        const fd = makeFd();
        detectPhases(fd);
        for (const seg of fd.phases) {
            expect(seg.durationSec).toBe(seg.endIdx - seg.startIdx + 1);
        }
    });

    it('segments cover the full row range without gaps', () => {
        const fd = makeFd({ n: 300 });
        for (let i = 10; i < 300; i++) { fd.rpm[i] = 1000; fd.speedKts[i] = i < 50 ? 0 : 100; fd.altFt[i] = i < 50 ? 0 : 3500; }
        detectPhases(fd);
        let cursor = 0;
        for (const seg of fd.phases) {
            expect(seg.startIdx).toBe(cursor);
            cursor = seg.endIdx + 1;
        }
        expect(cursor).toBe(300);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test tests/phase-detector.test.js 2>&1 | tail -15
```
Expected: FAIL — `Cannot find module '../js/phase-detector.js'`

- [ ] **Step 3: Create `js/phase-detector.js`**

```javascript
// js/phase-detector.js

export function detectPhases(fd) {
    const n = fd.rows;

    // ── 1. Smooth altitude and compute altRate (ft/min) ──────────────────
    const W = 15;  // ±15 rows = 30-second window at 1Hz
    const smooth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - W), hi = Math.min(n - 1, i + W);
        let s = 0;
        for (let j = lo; j <= hi; j++) s += fd.altFt[j];
        smooth[i] = s / (hi - lo + 1);
    }
    const altRate = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - W), hi = Math.min(n - 1, i + W);
        altRate[i] = (smooth[hi] - smooth[lo]) / Math.max(hi - lo, 1) * 60;
    }
    fd.altRate = altRate;

    // ── 2. Find takeoff and landing row indices ───────────────────────────
    const depElev = _fieldElev(fd, 0, Math.min(300, n));
    const arrElev = _fieldElev(fd, Math.max(0, n - 300), n);

    let takeoffIdx = n;
    for (let i = 0; i < n; i++) {
        if (fd.altFt[i] > depElev + 200 && fd.speedKts[i] > 40) { takeoffIdx = i; break; }
    }

    let landingIdx = n - 1;
    for (let i = n - 1; i >= takeoffIdx; i--) {
        if (fd.altFt[i] < arrElev + 200 && fd.speedKts[i] < 100) { landingIdx = i; break; }
    }

    // ── 3. Build segments ─────────────────────────────────────────────────
    const segs = [];
    _groundPhases(fd, 0, takeoffIdx - 1, segs);
    if (takeoffIdx <= landingIdx) _flightPhases(fd, altRate, takeoffIdx, landingIdx, segs);
    if (landingIdx + 1 < n) segs.push({ name: 'landing', startIdx: landingIdx + 1, endIdx: n - 1 });

    // If nothing was detected (e.g. ground-only data) cover entire range
    if (!segs.length) segs.push({ name: 'ground', startIdx: 0, endIdx: n - 1 });

    // Ensure full coverage with no gaps
    _fillGaps(segs, n);

    // ── 4. Merge segments shorter than 60s ────────────────────────────────
    _mergeShort(segs, 60);

    // ── 5. Annotate each segment ──────────────────────────────────────────
    for (const seg of segs) {
        seg.mlLabel     = _mode(fd.mlPhase, seg.startIdx, seg.endIdx);
        seg.mlAgreement = seg.name === seg.mlLabel;
        seg.pilotLabel  = null;
        seg.durationSec = seg.endIdx - seg.startIdx + 1;
        seg.distNm      = _distNm(fd, seg.startIdx, seg.endIdx);
        seg.score       = 0;
    }

    fd.phases     = segs;
    fd.approaches = segs.filter(s => s.name === 'approach');
    return segs;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _fieldElev(fd, from, to) {
    let sum = 0, count = 0;
    for (let i = from; i < to; i++) {
        if (fd.altFt[i] > 0 && fd.speedKts[i] < 10 && fd.rpm[i] > 0) {
            sum += fd.altFt[i]; count++;
        }
    }
    return count > 0 ? sum / count : 0;
}

function _groundPhases(fd, start, end, out) {
    if (start > end) return;

    // Find engine start: first 3 consecutive rows with RPM >= 500
    let startupBegin = -1;
    for (let i = start; i <= end - 2; i++) {
        if (fd.rpm[i] >= 500 && fd.rpm[i + 1] >= 500 && fd.rpm[i + 2] >= 500) {
            startupBegin = i; break;
        }
    }

    // Rows before startup (engine cold)
    if (startupBegin > start) out.push({ name: 'ground', startIdx: start, endIdx: startupBegin - 1 });
    if (startupBegin === -1) {
        out.push({ name: 'ground', startIdx: start, endIdx: end }); return;
    }

    // Startup: first ~120 rows after engine start
    const startupEnd = Math.min(startupBegin + 119, end);
    out.push({ name: 'startup', startIdx: startupBegin, endIdx: startupEnd });

    // Remaining ground rows: scan for warmup / taxi / runup
    let i = startupEnd + 1;
    while (i <= end) {
        const rpm = fd.rpm[i], spd = fd.speedKts[i];

        if (rpm >= 1800 && spd < 3) {
            // Runup: sustained high-power stationary
            let j = i;
            while (j <= end && fd.rpm[j] >= 1800 && fd.speedKts[j] < 3) j++;
            if (j - i >= 10) { out.push({ name: 'runup', startIdx: i, endIdx: j - 1 }); i = j; }
            else i++;
        } else if (spd >= 3) {
            // Taxi: moving on ground
            let j = i;
            while (j <= end && fd.speedKts[j] >= 3) j++;
            out.push({ name: 'taxi', startIdx: i, endIdx: j - 1 }); i = j;
        } else if (rpm >= 500) {
            // Warmup: idling, not moving
            let j = i;
            while (j <= end && fd.rpm[j] >= 500 && fd.rpm[j] < 1800 && fd.speedKts[j] < 3) j++;
            if (j - i >= 30) out.push({ name: 'warmup', startIdx: i, endIdx: j - 1 });
            i = j;
        } else {
            i++;
        }
    }
}

function _flightPhases(fd, altRate, start, end, out) {
    // Build a raw label array for every airborne row
    const raw = new Array(end - start + 1);
    for (let i = 0; i <= end - start; i++) {
        const r = altRate[start + i];
        raw[i] = r > 200 ? 'climb' : r < -200 ? 'descent' : 'cruise';
    }

    // Override with 'approach' where ml_phase says so (≥10 consecutive rows)
    for (let i = 0; i < raw.length; ) {
        if (fd.mlPhase[start + i] === 'approach') {
            let j = i;
            while (j < raw.length && fd.mlPhase[start + j] === 'approach') j++;
            if (j - i >= 10) { for (let k = i; k < j; k++) raw[k] = 'approach'; i = j; }
            else i++;
        } else { i++; }
    }

    // Collapse raw array into segments
    let segStart = 0, curLabel = raw[0];
    for (let i = 1; i <= raw.length; i++) {
        const label = i < raw.length ? raw[i] : null;
        if (label !== curLabel) {
            out.push({ name: curLabel, startIdx: start + segStart, endIdx: start + i - 1 });
            segStart = i; curLabel = label;
        }
    }
}

function _fillGaps(segs, n) {
    // Sort by startIdx and patch any uncovered rows
    segs.sort((a, b) => a.startIdx - b.startIdx);
    if (segs.length && segs[0].startIdx > 0)
        segs.unshift({ name: 'ground', startIdx: 0, endIdx: segs[0].startIdx - 1 });
    const last = segs[segs.length - 1];
    if (last && last.endIdx < n - 1)
        segs.push({ name: 'ground', startIdx: last.endIdx + 1, endIdx: n - 1 });
}

function _mergeShort(segs, minSec) {
    let changed = true;
    while (changed && segs.length > 1) {
        changed = false;
        for (let i = 0; i < segs.length; i++) {
            if (segs[i].endIdx - segs[i].startIdx + 1 < minSec) {
                const neighbor = i === 0 ? i + 1 : i - 1;
                if (neighbor > i) { segs[neighbor].startIdx = segs[i].startIdx; }
                else              { segs[neighbor].endIdx   = segs[i].endIdx; }
                segs.splice(i, 1);
                changed = true; break;
            }
        }
    }
}

function _mode(arr, start, end) {
    const counts = {};
    for (let i = start; i <= end; i++) { const v = arr[i]; counts[v] = (counts[v] || 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'cruise';
}

function _distNm(fd, start, end) {
    let total = 0;
    for (let i = start + 1; i <= end; i++) {
        if (!fd.lat[i] || !fd.lon[i] || !fd.lat[i-1] || !fd.lon[i-1]) continue;
        const dLat = (fd.lat[i] - fd.lat[i-1]) * Math.PI / 180;
        const dLon = (fd.lon[i] - fd.lon[i-1]) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
            Math.cos(fd.lat[i-1]*Math.PI/180)*Math.cos(fd.lat[i]*Math.PI/180)*Math.sin(dLon/2)**2;
        total += 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    return parseFloat(total.toFixed(1));
}
```

- [ ] **Step 4: Run tests**

```bash
npm test tests/phase-detector.test.js 2>&1 | tail -20
```
Expected: all tests pass. If any fail, fix the implementation before continuing.

- [ ] **Step 5: Commit**

```bash
git add js/phase-detector.js tests/phase-detector.test.js
git commit -m "feat(phase-detector): physics-based phase detection with ground sub-phases and altitude rate"
```

---

### Task 2: `js/csv-parser.js` — remove segmentPhases from parseCSV

**Files:**
- Modify: `js/csv-parser.js`
- Modify: `tests/csv-parser.test.js` (remove any test that checks `fd.phases` length)

- [ ] **Step 1: Check if any csv-parser test asserts on `fd.phases`**

```bash
grep -n "phases" /home/dananickerson/flytab-debrief/.claude/worktrees/feat+core/tests/csv-parser.test.js
```

- [ ] **Step 2: Edit `parseCSV` in `js/csv-parser.js`**

Find the line:
```javascript
        phases: [], approaches: [],
```
Add `altRate: null` to the fd object initializer — it will be populated by `detectPhases` in app.js:
```javascript
        phases: [], approaches: [], altRate: null,
```

Find the two lines at the bottom of `parseCSV`:
```javascript
    fd.phases   = segmentPhases(fd.mlPhase);
    fd.approaches = fd.phases.filter(p => p.name === 'approach');
```

Remove them. The `segmentPhases` function stays in the file (retained for direct unit tests), but `parseCSV` no longer calls it.

- [ ] **Step 3: Run all tests**

```bash
npm test 2>&1 | tail -15
```
Expected: all tests pass (csv-parser tests that called `segmentPhases` directly still pass since the function still exists).

- [ ] **Step 4: Commit**

```bash
git add js/csv-parser.js
git commit -m "feat(csv-parser): remove segmentPhases from parseCSV; detectPhases owns fd.phases"
```

---

### Task 3: `js/scorer.js` — use pilotLabel in scorePhases

**Files:**
- Modify: `js/scorer.js`

- [ ] **Step 1: Find the effectiveName reference in `scorePhases`**

In `js/scorer.js`, inside `scorePhases`, find where `seg.name` is used to determine whether approach scoring applies. It will look like:
```javascript
const subs = seg.name === 'approach' || seg.name === 'landing'
    ? [chtScore, rocScore, bankScore, speedScore, approachScore]
    : [chtScore, rocScore, bankScore, speedScore];

return {
    name: seg.name,
    ...
    score: clamp(Math.round(avg(subs))),
};
```

- [ ] **Step 2: Add effectiveName to use pilotLabel when set**

At the start of the `fd.phases.map(seg => {` callback, add one line:

```javascript
        const effectiveName = seg.pilotLabel ?? seg.name;
```

Then replace the two `seg.name` references used for scoring logic:

```javascript
        const subs = effectiveName === 'approach' || effectiveName === 'landing'
            ? [chtScore, rocScore, bankScore, speedScore, approachScore]
            : [chtScore, rocScore, bankScore, speedScore];

        return {
            name:        seg.name,          // keep original computed name
            effectiveName,                  // pilotLabel ?? name
            startIdx:    seg.startIdx,
            endIdx:      seg.endIdx,
            durationSec: seg.durationSec,
            distNm:      seg.distNm,
            score:       clamp(Math.round(avg(subs))),
            mlLabel:     seg.mlLabel,
            mlAgreement: seg.mlAgreement,
            pilotLabel:  seg.pilotLabel,
        };
```

- [ ] **Step 3: Run all tests**

```bash
npm test 2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add js/scorer.js
git commit -m "feat(scorer): scorePhases uses pilotLabel when set for approach scoring logic"
```

---

### Task 4: `js/app.js` — wire detectPhases and load corrections

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: Add import for detectPhases**

At the top of `js/app.js`, add the import after the existing csv-parser import:

```javascript
import { detectPhases }            from './phase-detector.js';
```

- [ ] **Step 2: Insert detectPhases call and corrections overlay in `openFlight`**

Find this block in `openFlight`:
```javascript
    // Compute CHT ROC and attach to fd before scoring
    fd.chtRoc = computeChtRoc(fd);

    fetchMETARs(fd);
```

Replace with:
```javascript
    // Compute CHT ROC and attach to fd before scoring
    fd.chtRoc = computeChtRoc(fd);

    // Physics-based phase detection (replaces ml_phase segmentation)
    // Must run after detectOOOI so fd.oooi is available for landing estimation
    detectPhases(fd);

    // Load any saved pilot corrections and overlay pilotLabel onto segments
    try {
        const saved = await fetch(`${API}/api/phases/${encodeURIComponent(filename)}`);
        if (saved.ok) {
            const { segments } = await saved.json();
            if (segments) {
                for (const cor of segments) {
                    const seg = fd.phases[cor.segmentIdx];
                    if (seg) seg.pilotLabel = cor.pilotLabel;
                }
            }
        }
    } catch (_) {}

    fetchMETARs(fd);
```

- [ ] **Step 3: Run the debrief server and load a flight in the browser**

```bash
python3 server/debrief-server.py &
```
Open `http://192.168.1.77:8092`, load a flight.

Expected: No console errors. Phase sidebar populates. `window._fd.altRate` is a Float32Array in the browser console. `window._fd.phases` shows the new segments (startup/warmup/taxi/runup visible for ground phase).

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "feat(app): wire detectPhases and load saved phase corrections"
```

---

### Task 5: `js/score-panel.js` — add GS, ROC, ROD to AIRMANSHIP

**Files:**
- Modify: `js/score-panel.js`

- [ ] **Step 1: Locate the AIRMANSHIP section in `seek()`**

Find this block (around line 86):
```javascript
        <div class="sp-section-title">AIRMANSHIP</div>
        ${_row('Bank', `${Math.abs(bank).toFixed(0)}°`, bankStatus, bankStatus !== 'pass' ? '>30°' : '')}
        ${ias !== null ? _row('IAS', `${ias.toFixed(0)} kt`, iasStatus, iasStatus !== 'pass' ? `Vno ${vno}` : '') : ''}
        ${_row('Alt stability', `±${altStd.toFixed(0)} ft`, altStatus, '')}
```

- [ ] **Step 2: Add GS, ROC, ROD rows**

Replace the AIRMANSHIP block with:
```javascript
        <div class="sp-section-title">AIRMANSHIP</div>
        ${_row('Bank', `${Math.abs(bank).toFixed(0)}°`, bankStatus, bankStatus !== 'pass' ? '>30°' : '')}
        ${ias !== null ? _row('IAS', `${ias.toFixed(0)} kt`, iasStatus, iasStatus !== 'pass' ? `Vno ${vno}` : '') : ''}
        ${_row('Ground speed', `${(_fd.speedKts[rowIdx] ?? 0).toFixed(0)} kt`, 'pass', '')}
        ${_fd.altRate && Math.abs(_fd.altRate[rowIdx]) >= 50 ? (
            _fd.altRate[rowIdx] > 0
                ? _row('Rate of climb', `+${_fd.altRate[rowIdx].toFixed(0)} fpm`, 'pass', '')
                : _row('Rate of descent', `${_fd.altRate[rowIdx].toFixed(0)} fpm`, 'pass', '')
        ) : ''}
        ${_row('Alt stability', `±${altStd.toFixed(0)} ft`, altStatus, '')}
```

- [ ] **Step 3: Reload browser and verify**

Open a flight, scrub to a climb segment. The score panel AIRMANSHIP section should show Ground speed (kt) and Rate of climb (fpm). Scrub to descent — shows Rate of descent. Scrub to cruise with small altitude changes — neither ROC nor ROD shown.

- [ ] **Step 4: Commit**

```bash
git add js/score-panel.js
git commit -m "feat(score-panel): add ground speed, rate of climb, rate of descent to AIRMANSHIP"
```

---

### Task 6: `js/phase-sidebar.js` + `css/style.css` — ML badges, correction panel

**Files:**
- Modify: `js/phase-sidebar.js`
- Modify: `css/style.css`

- [ ] **Step 1: Add CSS for new sidebar elements to `css/style.css`**

Append to the end of `css/style.css` (before the `@keyframes pulse` block):

```css
/* ── Phase sidebar ML disagreement + correction ──────────────────── */
.ps-ml-badge { font-size: 0.68rem; font-weight: 700; color: var(--color-caution); margin-top: 3px; cursor: pointer; }
.ps-confirmed-badge { font-size: 0.68rem; font-weight: 700; color: var(--color-success); margin-top: 3px; }
.ps-sidebar-header { font-size: 0.68rem; font-weight: 800; color: var(--text-label); letter-spacing: 0.06em; padding: 6px 12px 4px; border-bottom: 1px solid var(--border-light); display: flex; gap: 10px; }
.ps-sidebar-header .disagree { color: var(--color-caution); }
.ps-sidebar-header .confirmed { color: var(--color-success); }
.ps-correction-panel { padding: 8px 10px; background: var(--bg-surface); border-top: 1px solid var(--border-light); }
.ps-correction-title { font-size: 0.7rem; font-weight: 800; color: var(--text-label); margin-bottom: 6px; letter-spacing: 0.05em; }
.ps-label-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; margin-bottom: 8px; }
.ps-label-opt { display: flex; align-items: center; gap: 4px; font-size: 0.75rem; cursor: pointer; padding: 2px; }
.ps-label-opt input[type=radio] { accent-color: var(--accent); }
.ps-correction-actions { display: flex; gap: 6px; }
.ps-correction-actions button { padding: 4px 12px; border-radius: 3px; font-size: 0.75rem; font-weight: 700; cursor: pointer; border: 1px solid var(--border-strong); }
.ps-confirm-btn { background: var(--accent); color: #fff; border-color: var(--accent) !important; }
```

- [ ] **Step 2: Replace `js/phase-sidebar.js` entirely**

```javascript
// js/phase-sidebar.js

const PHASE_ICONS = {
    ground: '■', startup: '⚡', warmup: '◌', taxi: '▷', runup: '◉',
    climb: '▶', cruise: '→', descent: '▼', approach: '↙', landing: '■',
};

const PHASE_LABELS = {
    ground: 'Ground', startup: 'Startup', warmup: 'Warmup', taxi: 'Taxi', runup: 'Runup',
    climb: 'Climb', cruise: 'Cruise', descent: 'Descent', approach: 'Approach', landing: 'Landing',
};

// Phases that can repeat and need numbering
const REPEATABLE = new Set(['climb', 'cruise', 'descent']);

let _phaseScores = null;
let _onSeekCb = null;
let _onCorrectCb = null;
let _openCorrectionIdx = -1;

function scoreColor(s) { return s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red'; }
function scoreHex(s)   { return s >= 80 ? '#1a8c35' : s >= 60 ? '#b87000' : '#cc2222'; }
function fmtDuration(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Assign occurrence numbers to repeatable phases
function _numberedLabel(phaseScores, idx) {
    const name = phaseScores[idx].name;
    if (!REPEATABLE.has(name)) return PHASE_LABELS[name] || name;
    let count = 0;
    for (let i = 0; i <= idx; i++) { if (phaseScores[i].name === name) count++; }
    return `${PHASE_LABELS[name]} ${count}`;
}

function _renderSidebar(phaseScores) {
    const el = document.getElementById('phase-sidebar');
    if (!el) return;

    const disagreeCount   = phaseScores.filter(p => !p.mlAgreement && !p.pilotLabel).length;
    const confirmedCount  = phaseScores.filter(p => p.pilotLabel !== null).length;

    const headerParts = ['PHASES'];
    if (disagreeCount > 0) headerParts.push(`<span class="disagree">${disagreeCount} disagreement${disagreeCount !== 1 ? 's' : ''}</span>`);
    if (confirmedCount > 0) headerParts.push(`<span class="confirmed">${confirmedCount} confirmed</span>`);

    const header = headerParts.length > 1
        ? `<div class="ps-sidebar-header">${headerParts.join(' · ')}</div>`
        : '';

    const rows = phaseScores.map((ps, idx) => {
        const label = _numberedLabel(phaseScores, idx);
        const effective = ps.pilotLabel ?? ps.name;
        const effectiveLabel = ps.pilotLabel ? (_numberedLabel(phaseScores, idx) + ' ✎') : label;

        let badge = '';
        if (ps.pilotLabel !== null) {
            const txt = ps.pilotLabel !== ps.name ? `✓ corrected: ${PHASE_LABELS[ps.pilotLabel] || ps.pilotLabel}` : '✓ confirmed';
            badge = `<div class="ps-confirmed-badge">${txt}</div>`;
        } else if (!ps.mlAgreement) {
            badge = `<div class="ps-ml-badge" data-correct="${idx}">⚠ ML: ${PHASE_LABELS[ps.mlLabel] || ps.mlLabel}</div>`;
        }

        const correction = _openCorrectionIdx === idx ? _correctionPanel(ps, idx) : '';

        return `
            <div class="ps-phase" data-idx="${idx}" data-start="${ps.startIdx}">
              <div class="ps-phase-name">
                <span class="ps-phase-icon">${PHASE_ICONS[effective] || '→'}</span>
                <span>${effectiveLabel}</span>
              </div>
              <div class="ps-meta">${ps.distNm.toFixed(1)} nm · ${fmtDuration(ps.durationSec)}</div>
              <div class="ps-score">
                <span class="ps-score-badge ${scoreColor(ps.score)}">${ps.score}</span>
                <div class="ps-score-bar">
                  <div class="ps-score-fill" style="width:${ps.score}%;background:${scoreHex(ps.score)}"></div>
                </div>
              </div>
              ${badge}
              ${correction}
            </div>`;
    }).join('');

    el.innerHTML = header + rows;

    el.querySelectorAll('.ps-phase').forEach(row => {
        row.addEventListener('click', (e) => {
            // Don't seek if clicking correction controls
            if (e.target.closest('.ps-correction-panel')) return;
            if (e.target.dataset.correct !== undefined) {
                _openCorrectionIdx = _openCorrectionIdx === parseInt(e.target.dataset.correct)
                    ? -1
                    : parseInt(e.target.dataset.correct);
                _renderSidebar(_phaseScores);
                return;
            }
            _openCorrectionIdx = -1;
            const startIdx = parseInt(row.dataset.start);
            _onSeekCb(startIdx, parseInt(row.dataset.idx));
        });
    });

    el.querySelectorAll('.ps-confirm-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const selected = el.querySelector(`input[name="phase-label-${idx}"]:checked`);
            if (!selected) return;
            _phaseScores[idx].pilotLabel = selected.value;
            _openCorrectionIdx = -1;
            _renderSidebar(_phaseScores);
            _onCorrectCb?.(_phaseScores[idx], idx);
        });
    });

    el.querySelectorAll('.ps-cancel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _openCorrectionIdx = -1;
            _renderSidebar(_phaseScores);
        });
    });
}

function _correctionPanel(ps, idx) {
    const ALL_PHASES = ['startup','warmup','taxi','runup','climb','cruise','descent','approach','landing'];
    const current = ps.pilotLabel ?? ps.name;
    const opts = ALL_PHASES.map(p => `
        <label class="ps-label-opt">
          <input type="radio" name="phase-label-${idx}" value="${p}" ${p === current ? 'checked' : ''}>
          ${PHASE_LABELS[p]}
        </label>`).join('');
    return `
        <div class="ps-correction-panel">
          <div class="ps-correction-title">LABEL THIS SEGMENT</div>
          <div class="ps-label-grid">${opts}</div>
          <div class="ps-correction-actions">
            <button class="ps-confirm-btn" data-idx="${idx}">Confirm ✓</button>
            <button class="ps-cancel-btn">Cancel</button>
          </div>
        </div>`;
}

export function initPhaseSidebar(phaseScores, onSeekCb, onCorrectCb) {
    _phaseScores    = phaseScores;
    _onSeekCb       = onSeekCb;
    _onCorrectCb    = onCorrectCb;
    _openCorrectionIdx = -1;
    _renderSidebar(phaseScores);
    window._phaseSidebar = { seek: _seekSidebar };
}

function _seekSidebar(rowIdx) {
    if (!_phaseScores) return;
    const el = document.getElementById('phase-sidebar');
    if (!el) return;
    const active = _phaseScores.findIndex(ps => rowIdx >= ps.startIdx && rowIdx <= ps.endIdx);
    el.querySelectorAll('.ps-phase').forEach((row, i) =>
        row.classList.toggle('active', i === active));
}
```

- [ ] **Step 3: Reload browser and verify**

Load a flight. The sidebar header should show disagreement count if any ML/computed mismatches exist. Click a `⚠ ML: cruise` badge — the correction panel expands. Select a different label and click Confirm — badge changes to `✓ confirmed`. Click the phase row itself (not the badge) — scrubber jumps.

- [ ] **Step 4: Commit**

```bash
git add js/phase-sidebar.js css/style.css
git commit -m "feat(phase-sidebar): ML disagreement badges, phase numbering, inline correction panel"
```

---

### Task 7: `server/debrief-server.py` + `js/app.js` correction save — server endpoints and training log

**Files:**
- Modify: `server/debrief-server.py`
- Modify: `js/app.js`

- [ ] **Step 1: Add GET/PUT `/api/phases/{filename}` to `debrief-server.py`**

Read `server/debrief-server.py` to find the `do_GET` and `do_PUT` handlers. The `do_GET` handler has a block like:
```python
elif p.startswith('/api/review/'):
    self._get_review(p[len('/api/review/'):])
```

Add **after** the `/api/review/` GET block:
```python
        elif p.startswith('/api/phases/'):
            self._get_phases(urllib.parse.unquote(p[len('/api/phases/'):]))
```

In `do_PUT`, after the `/api/review/` block:
```python
        elif p.startswith('/api/phases/'):
            self._put_phases(urllib.parse.unquote(p[len('/api/phases/'):]))
```

Then add the two methods to the handler class (after `_get_review`/`_put_review`):

```python
    def _get_phases(self, name):
        if not name:
            return self._not_found()
        path = FLIGHTS_DIR / (name + '.phases.json')
        if path.exists():
            self._json({'segments': json.loads(path.read_text())})
        else:
            self._json({'segments': None})

    def _put_phases(self, name):
        if not name:
            return self._not_found()
        n = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(n))
        path = FLIGHTS_DIR / (name + '.phases.json')
        path.write_text(json.dumps(body.get('segments', []), indent=2))
        self._json({'ok': True})
```

- [ ] **Step 2: Wire the `onCorrectCb` in `js/app.js`**

Find the `initPhaseSidebar` call in `openFlight`:
```javascript
    initPhaseSidebar(phaseScores, (rowIdx, phaseIdx) => {
        const scrubber = document.getElementById('scrubber');
        scrubber.value = rowIdx;
        scrubber.dispatchEvent(new Event('input'));
        window._charts?.zoomToPhase(phaseIdx);
    });
```

Replace with:
```javascript
    initPhaseSidebar(
        phaseScores,
        (rowIdx, phaseIdx) => {
            const scrubber = document.getElementById('scrubber');
            scrubber.value = rowIdx;
            scrubber.dispatchEvent(new Event('input'));
            window._charts?.zoomToPhase(phaseIdx);
        },
        async (seg, segIdx) => {
            // Save all corrections to server
            const corrected = phaseScores
                .filter(p => p.pilotLabel !== null)
                .map((p, i) => ({
                    segmentIdx:    phaseScores.indexOf(p),
                    pilotLabel:    p.pilotLabel,
                }));
            fetch(`${API}/api/phases/${encodeURIComponent(filename)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ segments: corrected }),
            }).catch(() => {});

            // Append training entry to log
            const avgOf = (arr, s, e) => {
                let sum = 0, cnt = 0;
                for (let i = s; i <= e; i++) { sum += arr[i]; cnt++; }
                return cnt > 0 ? parseFloat((sum / cnt).toFixed(2)) : 0;
            };
            const s = seg.startIdx, e = seg.endIdx;
            const entry = {
                type:           'phase_correction',
                flightDate:     fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : '',
                flightFile:     filename,
                segmentIdx:     segIdx,
                startIdx:       s,
                endIdx:         e,
                durationSec:    seg.durationSec,
                computedLabel:  seg.name,
                mlLabel:        seg.mlLabel,
                pilotLabel:     seg.pilotLabel,
                stats: {
                    avgAltFt:      Math.round(avgOf(fd.altFt, s, e)),
                    avgAltRateFpm: Math.round(avgOf(fd.altRate, s, e)),
                    avgSpeedKts:   Math.round(avgOf(fd.speedKts, s, e)),
                    avgRpm:        Math.round(avgOf(fd.rpm, s, e)),
                    avgPctPower:   Math.round(avgOf(fd.pctPower, s, e)),
                    avgFuelFlow:   parseFloat(avgOf(fd.fuelFlow, s, e).toFixed(1)),
                    maxChtF:       Math.round(Math.max(...[0,1,2,3].flatMap(c =>
                        Array.from({length: e - s + 1}, (_, k) => fd.cht[c][s + k])))),
                    avgBank:       parseFloat(Math.abs(avgOf(fd.bank, s, e)).toFixed(1)),
                },
            };
            fetch(`${API}/api/training-log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry),
            }).catch(() => {});
        }
    );
```

- [ ] **Step 3: Restart server and test end-to-end**

```bash
kill $(lsof -t -i:8092) 2>/dev/null; python3 server/debrief-server.py &
```

Load a flight, confirm a correction on a disagreement badge. Then:

```bash
ls ~/flights/*.phases.json
cat ~/flights/*.phases.json
tail -1 ~/.flytab-debrief/training-log.jsonl | python3 -m json.tool
```

Expected: A `.phases.json` file exists alongside the CSV with the corrected segment. The last training-log entry is a `phase_correction` object with `computedLabel`, `mlLabel`, `pilotLabel`, and `stats`.

- [ ] **Step 4: Run all tests**

```bash
npm test 2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/debrief-server.py js/app.js
git commit -m "feat(server+app): GET/PUT /api/phases endpoints and training log for pilot corrections"
```
