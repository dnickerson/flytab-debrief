import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseCSV, haversineNm, segmentPhases, to24hUTC } from '../js/csv-parser.js';

const SAMPLE = readFileSync('tests/fixtures/sample.csv', 'utf8');

describe('parseCSV', () => {
    it('returns correct row count', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.rows).toBe(10);
    });

    it('parses RPM from column 7', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.rpm[0]).toBe(2400);
    });

    it('parses EGT1 from column 16', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.egt[0][0]).toBe(1380);
    });

    it('parses CHT4 from column 23', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.cht[3][0]).toBe(345);
    });

    it('parses latitude from column 27', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.lat[0]).toBeCloseTo(35.12, 2);
    });

    it('parses Operating_Condition string', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.opCondition[0]).toBe('ROP');
    });

    it('parses ml_phase string', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.mlPhase[0]).toBe('cruise');
    });

    it('computes maxCht correctly', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.maxCht).toBeGreaterThanOrEqual(345);
    });

    it('uses Float32Array for rpm', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.rpm).toBeInstanceOf(Float32Array);
    });

    it('uses Uint8Array for mlAnomaly', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.mlAnomaly).toBeInstanceOf(Uint8Array);
    });

    it('sets totalDistanceNm > 0 for moving flight', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.totalDistanceNm).toBeGreaterThan(0);
    });

    it('parses startUtc as a valid Date from date+time_z columns', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.startUtc).toBeInstanceOf(Date);
        expect(isNaN(fd.startUtc.getTime())).toBe(false);
        // sample.csv first row date=2026-05-11, time_z=12:00:00 PM → 2026-05-11T12:00:00Z
        expect(fd.startUtc.toISOString()).toBe('2026-05-11T12:00:00.000Z');
    });
});

describe('to24hUTC', () => {
    it('converts PM time correctly', () => {
        expect(to24hUTC('1:32:53 PM')).toBe('13:32:53');
    });

    it('converts 12:00 PM (noon) correctly', () => {
        expect(to24hUTC('12:00:00 PM')).toBe('12:00:00');
    });

    it('converts 12:00 AM (midnight) correctly', () => {
        expect(to24hUTC('12:00:00 AM')).toBe('00:00:00');
    });

    it('converts AM time correctly', () => {
        expect(to24hUTC('9:05:30 AM')).toBe('09:05:30');
    });
});

describe('segmentPhases', () => {
    it('groups consecutive identical phases', () => {
        const phases = segmentPhases(['climb','climb','cruise','cruise','cruise','descent']);
        expect(phases).toHaveLength(3);
        expect(phases[0]).toEqual({ name: 'climb', startIdx: 0, endIdx: 1 });
        expect(phases[1]).toEqual({ name: 'cruise', startIdx: 2, endIdx: 4 });
        expect(phases[2]).toEqual({ name: 'descent', startIdx: 5, endIdx: 5 });
    });

    it('handles single-phase flight', () => {
        const phases = segmentPhases(['ground','ground']);
        expect(phases).toHaveLength(1);
        expect(phases[0].endIdx).toBe(1);
    });
});

describe('haversineNm', () => {
    it('returns ~0 for identical points', () => {
        expect(haversineNm(35, -80, 35, -80)).toBeCloseTo(0, 5);
    });

    it('returns ~60nm for 1 degree latitude', () => {
        expect(haversineNm(35, -80, 36, -80)).toBeCloseTo(60.04, 0);
    });
});
