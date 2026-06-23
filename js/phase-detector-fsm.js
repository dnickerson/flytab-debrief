// js/phase-detector-fsm.js
//
// FSM-based flight-phase detector — drop-in replacement for phase-detector.js.
//
// Same public contract as phase-detector.js:
//   detectPhases(fd) -> segs[]   and sets fd.altRate, fd.phases, fd.approaches.
// To use it, change the import in js/app.js from
//   import { detectPhases } from './phase-detector.js';
// to
//   import { detectPhases } from './phase-detector-fsm.js';
//
// Why this exists
// ---------------
// The original detector stitched phases from independent ad-hoc passes and
// *borrowed* the `approach` label straight out of fd.mlPhase (the on-device ML
// phase). That makes the debrief's phase track only as good as the runtime
// label it was trying to audit. This version:
//   • runs a real finite-state machine with a legal-transition table, so
//     physically impossible sequences (landing before takeoff, cruise during
//     shutdown) cannot occur;
//   • derives every phase from physics — RPM, MP, fuel flow, GPS ground speed,
//     GPS position delta, altitude and smoothed altitude-rate — with NO
//     dependency on fd.mlPhase;
//   • uses a GPS-position delta (haversine over a short window) to tell a truly
//     stationary aircraft (warmup / runup) from one that is creeping (taxi),
//     because GPS ground speed is noisy at a standstill;
//   • being a post-flight (offline) detector, it is allowed to look ahead, so it
//     uses centered smoothing and hysteresis back-fill for clean boundaries.
//
// Taxonomy note
// -------------
// The debrief sidebar/charts/scorer speak a fixed 10-name vocabulary:
//   ground, startup, warmup, taxi, runup, climb, cruise, descent, approach, landing
// The FSM reasons over a richer 13-state internal alphabet (it distinguishes
// taxi_out/taxi_in, takeoff and shutdown for correct sequencing) and then
// collapses to the display vocabulary in DISPLAY_NAME below. To surface the
// richer states in the UI later, add icons/labels for them in phase-sidebar.js
// and remove their entries from DISPLAY_NAME — nothing else changes.

// ── Tunables (RV-9A / O-360-A1A) ────────────────────────────────────────────
const RPM_SHUTDOWN   = 50;     // engine stopped
const RPM_RUNUP      = 1700;   // run-up / mag check RPM
const RPM_TAKEOFF    = 2400;   // committed to takeoff above this
const RPM_RUNNING    = 500;    // engine is running above this

const SPEED_STATIONARY = 5;    // <= this and not moving on GPS = parked
const SPEED_TAXI       = 35;   // taxi speed ceiling (kt ground speed)
const SPEED_AIRBORNE   = 70;   // safely above Vr (kt)
const SPEED_APPROACH   = 100;  // in descent near field below this = approach

const ALT_AIRBORNE_MIN = 200;  // ft AGL to be considered airborne
const ALT_APPROACH_AGL = 600;  // ft AGL below which low-and-slow = approach/landing

const ROC_CLIMB   =  200;      // ft/min
const ROC_DESCENT = -200;

const MP_FULL_POWER = 25;      // "Hg — full-power takeoff
const FF_SHUTDOWN   = 0.5;     // GPH — effectively zero

const GPS_MOVE_NM   = 0.0015;  // ~9 ft over the window = "creeping", not parked
const GPS_MOVE_WIN  = 5;       // rows (s) for the position-delta test

const STARTUP_SECS  = 120;     // first 2 min after engine start
const ALT_SMOOTH_W  = 15;      // ±15 rows = 30 s centered window
const AIRBORNE_GO   = 3;       // consecutive rows to latch airborne
const AIRBORNE_LAND = 8;       // consecutive rows to latch back on the ground

// Minimum segment duration (s) — flicker shorter than this is absorbed into the
// previous phase. Meaningful brief events keep small floors; en-route phases use
// a large floor so step climbs/descents don't fragment cruise.
const MIN_DURATION = {
    startup: 5,  warmup: 15, runup: 10, taxi_out: 8, takeoff: 3,
    climb: 30,   cruise: 30, descent: 30, approach: 10, landing: 5,
    taxi_in: 8,  shutdown: 3, ground: 1,
};

// Legal FSM transitions over the internal alphabet.
const TRANSITIONS = {
    shutdown: new Set(['shutdown', 'startup']),
    startup:  new Set(['startup', 'warmup', 'taxi_out', 'runup', 'shutdown']),
    warmup:   new Set(['warmup', 'runup', 'taxi_out', 'taxi_in', 'startup', 'shutdown']),
    runup:    new Set(['runup', 'warmup', 'taxi_out', 'shutdown']),
    taxi_out: new Set(['taxi_out', 'takeoff', 'runup', 'warmup', 'shutdown']),
    takeoff:  new Set(['takeoff', 'climb', 'cruise', 'taxi_out']),
    climb:    new Set(['climb', 'cruise', 'descent', 'approach']),
    cruise:   new Set(['cruise', 'climb', 'descent', 'approach']),
    descent:  new Set(['descent', 'cruise', 'climb', 'approach', 'landing']),
    approach: new Set(['approach', 'landing', 'climb', 'descent', 'cruise']),
    landing:  new Set(['landing', 'taxi_in', 'approach', 'takeoff']),
    taxi_in:  new Set(['taxi_in', 'shutdown', 'takeoff']),
};

const AIRBORNE = new Set(['takeoff', 'climb', 'cruise', 'descent', 'approach']);

// Internal alphabet → debrief display vocabulary.
const DISPLAY_NAME = {
    shutdown: 'ground', startup: 'startup', warmup: 'warmup', runup: 'runup',
    taxi_out: 'taxi',   taxi_in: 'taxi',    takeoff: 'climb',
    climb: 'climb', cruise: 'cruise', descent: 'descent',
    approach: 'approach', landing: 'landing',
};

// ── Public API ──────────────────────────────────────────────────────────────
export function detectPhases(fd) {
    const n = fd.rows;
    if (!n) { fd.phases = []; fd.approaches = []; return []; }

    const altRate  = _altRate(fd, n);
    fd.altRate     = altRate;

    const depElev  = _fieldElev(fd, 0, Math.min(300, n));
    const arrElev  = _fieldElev(fd, Math.max(0, n - 300), n);
    const mid      = Math.floor(n / 2);

    const moving   = _gpsMoving(fd, n);
    const airborne = _airborneWindow(fd, n, depElev, arrElev);
    const { startBegin, startEnd } = _startupWindow(fd, n);

    // ── Pass 1: per-row candidate → FSM-validated phase ──────────────────────
    const phase = new Array(n);
    let cur = 'shutdown';
    let postLanding = false;
    for (let i = 0; i < n; i++) {
        const fieldElev = i < mid ? depElev : arrElev;
        const cand = _classify(
            fd.rpm[i], fd.speedKts[i], fd.altFt[i], fd.mp[i], fd.fuelFlow[i],
            altRate[i], fieldElev, airborne[i], postLanding, moving[i],
            i >= startBegin && i <= startEnd && startBegin >= 0,
        );
        cur = TRANSITIONS[cur]?.has(cand) ? cand : cur;
        phase[i] = cur;
        if (AIRBORNE.has(cur)) postLanding = true;
    }

    // ── Pass 2: minimum-duration smoothing on the internal labels ────────────
    _smoothShort(phase, n);

    // ── Pass 3: build display segments ───────────────────────────────────────
    const segs = [];
    let start = 0;
    for (let i = 1; i <= n; i++) {
        const a = i < n ? DISPLAY_NAME[phase[i]]    : null;
        const b = DISPLAY_NAME[phase[start]];
        if (a !== b) {
            segs.push({ name: b, startIdx: start, endIdx: i - 1 });
            start = i;
        }
    }
    if (!segs.length) segs.push({ name: 'ground', startIdx: 0, endIdx: n - 1 });

    // ── Pass 4: annotate (same contract as phase-detector.js) ────────────────
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

// ── Per-row classifier (physics only) ───────────────────────────────────────
function _classify(rpm, spd, alt, mp, ff, roc, fieldElev,
                   airborne, postLanding, moving, inStartupWindow) {
    if (rpm <= RPM_SHUTDOWN && ff <= FF_SHUTDOWN) return 'shutdown';

    if (airborne) {
        const agl = alt - fieldElev;
        if (agl < ALT_APPROACH_AGL && spd < SPEED_APPROACH)
            return spd > SPEED_TAXI ? 'approach' : 'landing';
        if (roc > ROC_CLIMB)   return 'climb';
        if (roc < ROC_DESCENT) return 'descent';
        return 'cruise';
    }

    // ── On the ground ──
    if (rpm >= RPM_TAKEOFF && mp >= MP_FULL_POWER && spd > SPEED_TAXI)
        return 'takeoff';

    if (postLanding && spd > SPEED_STATIONARY && spd <= SPEED_TAXI)
        return spd > 15 ? 'landing' : 'taxi_in';

    // Run-up: elevated RPM while genuinely stationary (GPS not creeping).
    if (rpm >= RPM_RUNUP && spd <= SPEED_STATIONARY && !moving)
        return 'runup';

    // Moving on the ground = taxi (direction depends on whether we've flown).
    if (spd > SPEED_STATIONARY || moving)
        return postLanding ? 'taxi_in' : 'taxi_out';

    // Stationary, engine running, low RPM.
    if (rpm >= RPM_RUNNING)
        return inStartupWindow ? 'startup' : 'warmup';

    return 'shutdown';
}

// ── Smoothed altitude rate (ft/min), centered window — offline so look-ahead OK ─
function _altRate(fd, n) {
    const W = ALT_SMOOTH_W;
    const smooth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - W), hi = Math.min(n - 1, i + W);
        let s = 0;
        for (let j = lo; j <= hi; j++) s += fd.altFt[j];
        smooth[i] = s / (hi - lo + 1);
    }
    const rate = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - W), hi = Math.min(n - 1, i + W);
        rate[i] = (smooth[hi] - smooth[lo]) / Math.max(hi - lo, 1) * 60;
    }
    return rate;
}

// Average MSL altitude while parked with engine running near the given window.
function _fieldElev(fd, from, to) {
    let sum = 0, count = 0;
    for (let i = from; i < to; i++) {
        if (fd.altFt[i] > 0 && fd.speedKts[i] < 10 && fd.rpm[i] > 0) {
            sum += fd.altFt[i]; count++;
        }
    }
    return count > 0 ? sum / count : (to > from ? fd.altFt[from] : 0);
}

// Boolean per row: did the aircraft physically move over the last GPS_MOVE_WIN
// seconds? Distinguishes parked (warmup/runup) from creeping (taxi).
function _gpsMoving(fd, n) {
    const moving = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const j = Math.max(0, i - GPS_MOVE_WIN);
        if (!fd.lat[i] || !fd.lon[i] || !fd.lat[j] || !fd.lon[j]) continue;
        moving[i] = _haversineNm(fd.lat[j], fd.lon[j], fd.lat[i], fd.lon[i]) > GPS_MOVE_NM ? 1 : 0;
    }
    return moving;
}

// Latched airborne window with hysteresis + back-fill (offline detector).
function _airborneWindow(fd, n, depElev, arrElev) {
    const air = new Uint8Array(n);
    let state = false, counter = 0;
    for (let i = 0; i < n; i++) {
        const aboveField = fd.altFt[i] > depElev + ALT_AIRBORNE_MIN;
        const fastEnough = fd.speedKts[i] >= SPEED_AIRBORNE;
        const slowAndLow = fd.speedKts[i] < SPEED_TAXI &&
                           fd.altFt[i] < arrElev + ALT_APPROACH_AGL;
        if (!state) {
            if (aboveField && fastEnough) {
                if (++counter >= AIRBORNE_GO) {
                    state = true; counter = 0;
                    for (let k = i - AIRBORNE_GO + 1; k <= i; k++) if (k >= 0) air[k] = 1;
                }
            } else counter = 0;
        } else {
            air[i] = 1;
            if (slowAndLow) {
                if (++counter >= AIRBORNE_LAND) {
                    state = false; counter = 0;
                    for (let k = i - AIRBORNE_LAND + 1; k <= i; k++) if (k >= 0) air[k] = 0;
                }
            } else counter = 0;
        }
    }
    return air;
}

// First row where the engine starts running for good, plus the startup window end.
function _startupWindow(fd, n) {
    let startBegin = -1;
    for (let i = 0; i < n - 2; i++) {
        if (fd.rpm[i] >= RPM_RUNNING && fd.rpm[i + 1] >= RPM_RUNNING && fd.rpm[i + 2] >= RPM_RUNNING) {
            startBegin = i; break;
        }
    }
    const startEnd = startBegin < 0 ? -1 : Math.min(startBegin + STARTUP_SECS - 1, n - 1);
    return { startBegin, startEnd };
}

// Absorb segments shorter than their per-phase minimum into the previous phase.
// Iterates to a fixed point. Operates on the internal-label array in place.
function _smoothShort(phase, n) {
    for (let pass = 0; pass < 5; pass++) {
        let changed = false;
        let i = 0;
        while (i < n) {
            let j = i;
            while (j < n && phase[j] === phase[i]) j++;
            const dur = j - i;
            const min = MIN_DURATION[phase[i]] ?? 10;
            if (dur < min && (i > 0 || j < n)) {
                const repl = i > 0 ? phase[i - 1] : phase[j];
                for (let k = i; k < j; k++) phase[k] = repl;
                changed = true;
            }
            i = j;
        }
        if (!changed) break;
    }
}

// ── Small helpers (self-contained, matching original style) ─────────────────
function _mode(arr, start, end) {
    const counts = {};
    for (let i = start; i <= end; i++) { const v = arr[i]; counts[v] = (counts[v] || 0) + 1; }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'cruise';
}

function _haversineNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _distNm(fd, start, end) {
    let total = 0;
    for (let i = start + 1; i <= end; i++) {
        if (!fd.lat[i] || !fd.lon[i] || !fd.lat[i - 1] || !fd.lon[i - 1]) continue;
        total += _haversineNm(fd.lat[i - 1], fd.lon[i - 1], fd.lat[i], fd.lon[i]);
    }
    return parseFloat(total.toFixed(1));
}
