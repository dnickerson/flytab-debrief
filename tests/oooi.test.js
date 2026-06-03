import { describe, it, expect } from 'vitest';
import { detectOOOI, estimateFieldElev } from '../js/oooi.js';

function makeFD(rows, overrides = {}) {
    const rpm    = new Float32Array(rows);
    const altFt  = new Float32Array(rows);
    const speedKts = new Float32Array(rows);
    Object.assign(rpm, overrides.rpm || []);
    Object.assign(altFt, overrides.altFt || []);
    Object.assign(speedKts, overrides.speedKts || []);
    return { rows, rpm, altFt, speedKts, startUtc: new Date('2026-05-11T14:00:00Z') };
}

describe('detectOOOI', () => {
    it('detects Out when RPM sustained >= 500 for 3 rows', () => {
        const fd = makeFD(10, { rpm: [0, 0, 600, 600, 600, 600, 600, 600, 600, 0] });
        const o = detectOOOI(fd, 500, 500);
        expect(o.out).toBeInstanceOf(Date);
        expect(o.out.getTime()).toBe(new Date('2026-05-11T14:00:02Z').getTime());
    });

    it('detects Off when alt > depElev+200 AND speed > 40', () => {
        const fd = makeFD(10, {
            rpm:      [600, 600, 600, 600, 600, 600, 600, 600, 600, 600],
            altFt:    [500, 500, 500, 500, 750, 800, 850, 900, 950, 100],
            speedKts: [30,  30,  30,  30,  50,  80,  90,  100, 110, 10],
        });
        const o = detectOOOI(fd, 500, 0);
        expect(o.off.getTime()).toBe(new Date('2026-05-11T14:00:04Z').getTime());
    });

    it('detects In as last row with RPM > 0', () => {
        const fd = makeFD(10, { rpm: [600, 600, 600, 600, 600, 600, 600, 0, 0, 0] });
        const o = detectOOOI(fd, 0, 0);
        expect(o.in.getTime()).toBe(new Date('2026-05-11T14:00:06Z').getTime());
    });

    it('computes blockMinutes as In - Out', () => {
        const fd = makeFD(100, {
            rpm: new Float32Array(100).fill(600),
        });
        const o = detectOOOI(fd, 0, 0);
        expect(o.blockMinutes).toBeGreaterThan(0);
    });
});

describe('estimateFieldElev', () => {
    it('returns minimum positive altitude in the window', () => {
        const altFt = new Float32Array([0, 500, 520, 510, 530, 0]);
        expect(estimateFieldElev(altFt, 1, 5)).toBe(500);
    });
});
