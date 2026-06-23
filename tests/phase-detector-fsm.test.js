// tests/phase-detector-fsm.test.js
import { describe, it, expect } from 'vitest';
import { detectPhases } from '../js/phase-detector-fsm.js';

const DISPLAY_VOCAB = new Set([
    'ground', 'startup', 'warmup', 'taxi', 'runup',
    'climb', 'cruise', 'descent', 'approach', 'landing',
]);

// Builds a complete, physically-plausible 1 Hz flight that traverses every phase.
// Crucially, ml_phase is left as 'cruise' everywhere — the FSM must find approach
// (and every other phase) from physics, NOT by borrowing the ML label.
function buildFlight() {
    const FIELD = 500;          // ft MSL field elevation (dep == arr)
    const segs = [
        // [count, rpm, spd, alt, mp, ff, moving]
        [10,    0,  0, FIELD,  0,  0, false],  // engine off
        [150, 1000,  0, FIELD, 12,  2, false],  // startup(120s) -> warmup(30s), parked
        [30, 1000, 15, FIELD, 12,  2, true ],  // taxi_out
        [40, 1900,  0, FIELD, 18,  5, false],  // runup (elevated RPM, parked)
        [30, 1000, 15, FIELD, 12,  2, true ],  // taxi_out
        [150, 2500, 95, FIELD, 28, 14, true ],  // takeoff roll + climb (alt ramps below)
        [300, 2400,140,  3500, 23,  9, true ],  // cruise
        [150, 2000,120,  3500, 16,  6, true ],  // descent (alt ramps below)
        [60, 2000, 70,  1100, 14,  5, true ],  // approach (low AGL, slowing, airborne)
        [30, 1000, 28, FIELD, 10,  2, true ],  // landing rollout
        [40, 1000, 15, FIELD, 10,  2, true ],  // taxi_in
        [10,    0,  0, FIELD,  0,  0, false],  // shutdown
    ];
    const n = segs.reduce((a, s) => a + s[0], 0);
    const fd = {
        rows: n,
        rpm: new Float32Array(n), speedKts: new Float32Array(n),
        altFt: new Float32Array(n), mp: new Float32Array(n), fuelFlow: new Float32Array(n),
        lat: new Float32Array(n), lon: new Float32Array(n),
        mlPhase: Array(n).fill('cruise'), altRate: null, phases: [], approaches: [],
    };
    let i = 0, lon = -80.0;
    for (const [count, rpm, spd, alt, mp, ff, moving] of segs) {
        for (let k = 0; k < count; k++, i++) {
            fd.rpm[i] = rpm; fd.speedKts[i] = spd; fd.mp[i] = mp; fd.fuelFlow[i] = ff;
            fd.altFt[i] = alt; fd.lat[i] = 35.0;
            if (moving) lon += 0.0005;             // advance position when moving
            fd.lon[i] = lon;
        }
    }
    // Ramp altitude smoothly through the climb / descent / approach segments so
    // alt-rate and AGL behave like a real flight rather than step changes.
    const climbStart = 260, climbEnd = 410;
    for (let j = climbStart; j < climbEnd; j++)
        fd.altFt[j] = FIELD + (3500 - FIELD) * (j - climbStart) / (climbEnd - climbStart);
    const descStart = 710, apprEnd = 920;
    for (let j = descStart; j < apprEnd; j++)
        fd.altFt[j] = 3500 + (FIELD + 50 - 3500) * (j - descStart) / (apprEnd - descStart);
    return fd;
}

describe('detectPhases (FSM)', () => {
    it('attaches fd.altRate Float32Array of length fd.rows', () => {
        const fd = buildFlight();
        detectPhases(fd);
        expect(fd.altRate).toBeInstanceOf(Float32Array);
        expect(fd.altRate.length).toBe(fd.rows);
    });

    it('returns the segment array and sets fd.phases / fd.approaches', () => {
        const fd = buildFlight();
        const segs = detectPhases(fd);
        expect(Array.isArray(segs)).toBe(true);
        expect(fd.phases).toBe(segs);
        expect(Array.isArray(fd.approaches)).toBe(true);
    });

    it('emits only the debrief display vocabulary', () => {
        const fd = buildFlight();
        detectPhases(fd);
        for (const seg of fd.phases) expect(DISPLAY_VOCAB.has(seg.name)).toBe(true);
    });

    it('segments cover the full row range without gaps', () => {
        const fd = buildFlight();
        detectPhases(fd);
        let cursor = 0;
        for (const seg of fd.phases) {
            expect(seg.startIdx).toBe(cursor);
            cursor = seg.endIdx + 1;
        }
        expect(cursor).toBe(fd.rows);
    });

    it('traverses the expected phases of a complete flight', () => {
        const fd = buildFlight();
        detectPhases(fd);
        const names = new Set(fd.phases.map(s => s.name));
        for (const p of ['startup', 'taxi', 'runup', 'climb', 'cruise', 'descent', 'landing'])
            expect(names.has(p)).toBe(true);
    });

    it('detects approach from physics alone (ml_phase is never "approach")', () => {
        const fd = buildFlight();
        expect(fd.mlPhase.includes('approach')).toBe(false);   // proves no ML borrowing
        detectPhases(fd);
        expect(fd.approaches.length).toBeGreaterThan(0);
        expect(fd.phases.some(s => s.name === 'approach')).toBe(true);
    });

    it('never lands before it flies (legal ordering)', () => {
        const fd = buildFlight();
        detectPhases(fd);
        const firstAirborne = fd.phases.findIndex(s =>
            ['climb', 'cruise', 'descent', 'approach'].includes(s.name));
        const firstLanding = fd.phases.findIndex(s => s.name === 'landing');
        expect(firstAirborne).toBeGreaterThanOrEqual(0);
        expect(firstLanding).toBeGreaterThan(firstAirborne);
    });

    it('annotates each segment with the standard contract fields', () => {
        const fd = buildFlight();
        detectPhases(fd);
        for (const seg of fd.phases) {
            expect(seg.pilotLabel).toBeNull();
            expect(seg.durationSec).toBe(seg.endIdx - seg.startIdx + 1);
            expect(typeof seg.mlLabel).toBe('string');
            expect(typeof seg.mlAgreement).toBe('boolean');
            expect(typeof seg.distNm).toBe('number');
        }
    });
});
