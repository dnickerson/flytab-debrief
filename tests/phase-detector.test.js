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
        for (let i = 10; i < 300; i++) fd.rpm[i] = 1000;
        detectPhases(fd);
        const startup = fd.phases.find(s => s.name === 'startup');
        expect(startup).toBeDefined();
        expect(startup.startIdx).toBe(10);
    });

    it('detects runup when RPM >= 1800 while speed < 3', () => {
        const fd = makeFd({ n: 400 });
        for (let i = 10; i < 400; i++) fd.rpm[i] = 1000;
        for (let i = 200; i < 250; i++) fd.rpm[i] = 2000;
        detectPhases(fd);
        const runup = fd.phases.find(s => s.name === 'runup');
        expect(runup).toBeDefined();
        expect(runup.startIdx).toBeGreaterThanOrEqual(200);
    });

    it('detects taxi when speed >= 3 on ground', () => {
        const fd = makeFd({ n: 400 });
        for (let i = 10; i < 400; i++) fd.rpm[i] = 1000;
        for (let i = 150; i < 200; i++) fd.speedKts[i] = 15;
        detectPhases(fd);
        const taxi = fd.phases.find(s => s.name === 'taxi');
        expect(taxi).toBeDefined();
    });

    it('classifies sustained +200fpm as climb', () => {
        const fd = makeFd({ n: 500 });
        for (let i = 0; i < 500; i++) fd.rpm[i] = 1000;
        for (let i = 50; i < 500; i++) {
            fd.altFt[i]    = 500 + (i - 50) * 10;
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
            fd.altFt[i]    = i < 50 ? 0 : i < 150 ? (i - 50) * 10 : 3500;
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
        for (let i = 100; i < 110; i++) fd.mlPhase[i] = 'climb';
        detectPhases(fd);
        const seg = fd.phases.find(s => s.startIdx <= 100 && s.endIdx >= 110);
        expect(seg).toBeDefined();
        expect(seg.mlLabel).toBe('cruise');
    });

    it('sets mlAgreement=false when mlLabel differs from name', () => {
        const fd = makeFd({ n: 500 });
        for (let i = 0; i < 500; i++) { fd.rpm[i] = 1000; fd.speedKts[i] = i < 50 ? 0 : 120; }
        for (let i = 50; i < 500; i++) fd.altFt[i] = 500 + (i - 50) * 8;
        detectPhases(fd);
        const climb = fd.phases.find(s => s.name === 'climb');
        if (climb) expect(climb.mlAgreement).toBe(false);
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
