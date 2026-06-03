import { describe, it, expect } from 'vitest';
import {
    computeTAS, computeIAS, computePressureAlt,
    computeHeadwind, computeDMMS, applyAirspeeds,
} from '../js/flight-physics.js';

describe('computeTAS', () => {
    it('returns GS when wind is calm', () => {
        expect(computeTAS(120, 0, 0, 0)).toBeCloseTo(120, 1);
    });

    it('adds headwind component to get higher TAS', () => {
        // flying north (course=0), wind from north (windDir=0) → headwind
        const tas = computeTAS(120, 0, 10, 0);
        expect(tas).toBeCloseTo(130, 0);
    });

    it('subtracts tailwind to get lower TAS', () => {
        // flying north (0), wind from south (180) → tailwind
        const tas = computeTAS(120, 0, 10, 180);
        expect(tas).toBeCloseTo(110, 0);
    });
});

describe('computePressureAlt', () => {
    it('returns GPS alt when altimeter is 29.92', () => {
        expect(computePressureAlt(5000, 29.92)).toBeCloseTo(5000, 1);
    });

    it('adds correction for low altimeter setting', () => {
        // altimeter 29.42 → +500 ft
        expect(computePressureAlt(5000, 29.42)).toBeCloseTo(5500, 0);
    });
});

describe('computeIAS', () => {
    it('equals TAS at sea level in ISA conditions', () => {
        expect(computeIAS(100, 0, 288.15)).toBeCloseTo(100, 1);
    });

    it('IAS < TAS at altitude', () => {
        const ias = computeIAS(150, 8000, 278);
        expect(ias).toBeLessThan(150);
    });
});

describe('computeHeadwind', () => {
    it('returns full wind speed when flying directly into wind', () => {
        // wind FROM 270 (west), course 270 → headwind = full wind speed
        expect(computeHeadwind(20, 270, 270)).toBeCloseTo(20, 1);
    });

    it('returns negative for tailwind', () => {
        // wind FROM 090 (east), course 270 → tailwind
        expect(computeHeadwind(20, 90, 270)).toBeCloseTo(-20, 1);
    });
});

describe('computeDMMS', () => {
    it('returns 1.404 * VS1', () => {
        expect(computeDMMS(50)).toBeCloseTo(70.2, 1);
    });
});

describe('applyAirspeeds', () => {
    it('populates tasKts and iasKts Float32Arrays', () => {
        const fd = {
            rows: 3,
            speedKts: new Float32Array([120, 122, 121]),
            course: new Float32Array([185, 185, 185]),
            altFt: new Float32Array([3500, 3500, 3500]),
            tasKts: null, iasKts: null,
            avgTas: 0, avgIas: 0, avgHeadwindKt: 0,
        };
        const winds = [
            { windSpeed: 10, windDir: 180, tempC: 10 },
            { windSpeed: 10, windDir: 180, tempC: 10 },
            { windSpeed: 10, windDir: 180, tempC: 10 },
        ];
        const altimeters = new Float32Array([29.92, 29.92, 29.92]);
        applyAirspeeds(fd, winds, altimeters);
        expect(fd.tasKts).toBeInstanceOf(Float32Array);
        expect(fd.iasKts).toBeInstanceOf(Float32Array);
        expect(fd.avgTas).toBeGreaterThan(0);
    });
});
