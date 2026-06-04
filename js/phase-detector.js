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

    // Search backward for the last row where the aircraft was still airborne
    // or on high-speed rollout (alt > arrElev+100 OR speed > 30 kt).
    // This gives the actual touchdown boundary rather than the last ground row.
    let landingIdx = takeoffIdx;
    for (let i = n - 1; i > takeoffIdx; i--) {
        if (fd.altFt[i] > arrElev + 100 || fd.speedKts[i] > 30) { landingIdx = i; break; }
    }

    // ── 3. Build segments ─────────────────────────────────────────────────
    const segs = [];
    _groundPhases(fd, 0, takeoffIdx - 1, segs);
    if (takeoffIdx <= landingIdx) _flightPhases(fd, altRate, takeoffIdx, landingIdx, segs);
    _postLandingPhases(fd, landingIdx + 1, n - 1, segs);

    if (!segs.length) segs.push({ name: 'ground', startIdx: 0, endIdx: n - 1 });

    _fillGaps(segs, n);
    _mergeShort(segs, 60);

    // ── 4. Annotate each segment ──────────────────────────────────────────
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

// Generate post-landing segments: rollout → taxi to parking.
// Landing = touchdown to when speed first drops below 20 kt (runway exit).
// Taxi  = runway exit to end of recording.
function _postLandingPhases(fd, start, end, out) {
    if (start > end) return;
    // Find the first row where speed drops below 20 kt (runway exit / turnoff)
    let taxiStart = end + 1; // default: no taxi, all landing
    for (let i = start; i <= end; i++) {
        if (fd.speedKts[i] < 20) { taxiStart = i; break; }
    }
    if (taxiStart > start) out.push({ name: 'landing', startIdx: start, endIdx: taxiStart - 1 });
    if (taxiStart <= end)  out.push({ name: 'taxi',    startIdx: taxiStart, endIdx: end });
}

function _groundPhases(fd, start, end, out) {
    if (start > end) return;

    let startupBegin = -1;
    for (let i = start; i <= end - 2; i++) {
        if (fd.rpm[i] >= 500 && fd.rpm[i + 1] >= 500 && fd.rpm[i + 2] >= 500) {
            startupBegin = i; break;
        }
    }

    if (startupBegin > start) out.push({ name: 'ground', startIdx: start, endIdx: startupBegin - 1 });
    if (startupBegin === -1) {
        out.push({ name: 'ground', startIdx: start, endIdx: end }); return;
    }

    const startupEnd = Math.min(startupBegin + 119, end);
    out.push({ name: 'startup', startIdx: startupBegin, endIdx: startupEnd });

    let i = startupEnd + 1;
    while (i <= end) {
        const rpm = fd.rpm[i], spd = fd.speedKts[i];

        if (rpm >= 1800 && spd < 3) {
            let j = i;
            while (j <= end && fd.rpm[j] >= 1800 && fd.speedKts[j] < 3) j++;
            if (j - i >= 10) { out.push({ name: 'runup', startIdx: i, endIdx: j - 1 }); i = j; }
            else i++;
        } else if (spd >= 3) {
            let j = i;
            while (j <= end && fd.speedKts[j] >= 3) j++;
            out.push({ name: 'taxi', startIdx: i, endIdx: j - 1 }); i = j;
        } else if (rpm >= 500) {
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
    const raw = new Array(end - start + 1);
    for (let i = 0; i <= end - start; i++) {
        const r = altRate[start + i];
        raw[i] = r > 200 ? 'climb' : r < -200 ? 'descent' : 'cruise';
    }

    for (let i = 0; i < raw.length; ) {
        if (fd.mlPhase[start + i] === 'approach') {
            let j = i;
            while (j < raw.length && fd.mlPhase[start + j] === 'approach') j++;
            if (j - i >= 10) { for (let k = i; k < j; k++) raw[k] = 'approach'; i = j; }
            else i++;
        } else { i++; }
    }

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
    segs.sort((a, b) => a.startIdx - b.startIdx);
    if (segs.length && segs[0].startIdx > 0)
        segs.unshift({ name: 'ground', startIdx: 0, endIdx: segs[0].startIdx - 1 });
    const last = segs[segs.length - 1];
    if (last && last.endIdx < n - 1)
        segs.push({ name: 'ground', startIdx: last.endIdx + 1, endIdx: n - 1 });
}

// Only merge short flight-phase transitions (climb/cruise/descent).
// Ground sub-phases (startup/runup/taxi/warmup/ground/landing) and approach
// are semantically meaningful and must not be merged away.
const MERGEABLE = new Set(['climb', 'cruise', 'descent']);

function _mergeShort(segs, minSec) {
    let changed = true;
    while (changed && segs.length > 1) {
        changed = false;
        for (let i = 0; i < segs.length; i++) {
            if (!MERGEABLE.has(segs[i].name)) continue;
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
