import { describe, it, expect } from 'vitest';
import { scoreEngineMgmt, scoreAirmanship, scoreApproach, colorForScore } from '../js/scorer.js';
import { readFileSync } from 'fs';
import { parseCSV } from '../js/csv-parser.js';

const fd = parseCSV(readFileSync('tests/fixtures/sample.csv', 'utf8'));

const THRESHOLDS = {
    chtCaution: 380, chtDanger: 435, egtDanger: 1650,
    oilTempMin: 100, oilTempMax: 245,
    vnoKias: 165, vneKias: 202, vs1Kias: 50, vrefKias: 65,
    typicalSfc: 0.42,
};

describe('scoreEngineMgmt', () => {
    it('returns a score between 0 and 100', () => {
        const s = scoreEngineMgmt(fd, THRESHOLDS);
        expect(s.overall).toBeGreaterThanOrEqual(0);
        expect(s.overall).toBeLessThanOrEqual(100);
    });

    it('returns sub-scores for all 5 categories', () => {
        const s = scoreEngineMgmt(fd, THRESHOLDS);
        expect(s).toHaveProperty('cht');
        expect(s).toHaveProperty('egtBalance');
        expect(s).toHaveProperty('mixture');
        expect(s).toHaveProperty('oilTemp');
        expect(s).toHaveProperty('carbIce');
    });

    it('scores CHT=100 when all CHTs stay below caution', () => {
        const s = scoreEngineMgmt(fd, THRESHOLDS);
        expect(s.cht).toBe(100);
    });

    it('applies red box floor of 20 when in red box at high power', () => {
        const redFD = { ...fd,
            pctPower: new Float32Array(10).fill(70),
            pctFromPeak: new Float32Array(10).fill(30),
            mlPhase: Array(10).fill('cruise'),
            opCondition: Array(10).fill(''),
        };
        const s = scoreEngineMgmt(redFD, THRESHOLDS);
        expect(s.mixture).toBeLessThanOrEqual(20);
    });

    // Regression: CHT-ROC limit must come from the resolved envelope (default 60),
    // not a hardcoded 50. 55°F/min at high power is normal climb heating and must
    // not be penalized under the default limit; a tighter config must penalize it.
    it('honors the configurable CHT-ROC limit', () => {
        const rocFD = { ...fd,
            pctPower: new Float32Array(10).fill(70),
            chtRoc: [new Float32Array(10).fill(55), new Float32Array(10),
                     new Float32Array(10), new Float32Array(10)],
            mlPhase: Array(10).fill('cruise'),
        };
        expect(scoreEngineMgmt(rocFD, {}).chtRoc).toBe(100);                    // default limit 60
        expect(scoreEngineMgmt(rocFD, { chtRocLimit: 50 }).chtRoc).toBeLessThan(100);
    });

    // Regression: EGT-spread band comes from the resolved envelope (100/140), so a
    // 115°F cruise spread is a warn (partial credit), not an automatic zero.
    it('honors the configurable EGT-spread band', () => {
        const egtFD = { ...fd,
            egt: [new Float32Array(10).fill(1400), new Float32Array(10).fill(1400),
                  new Float32Array(10).fill(1400), new Float32Array(10).fill(1285)], // spread 115
            mlPhase: Array(10).fill('cruise'),
        };
        expect(scoreEngineMgmt(egtFD, {}).egtBalance).toBeGreaterThan(0);       // 115 in 100–140 warn band
        expect(scoreEngineMgmt(egtFD, { egtSpreadCaution: 50, egtSpreadDanger: 100 }).egtBalance).toBe(0);
    });
});

describe('scoreAirmanship', () => {
    it('returns a score between 0 and 100', () => {
        const s = scoreAirmanship(fd, THRESHOLDS, null);
        expect(s.overall).toBeGreaterThanOrEqual(0);
        expect(s.overall).toBeLessThanOrEqual(100);
    });

    it('has DMMS = 100 when no violations (no iasKts data)', () => {
        const s = scoreAirmanship(fd, THRESHOLDS, null);
        expect(s.dmms).toBe(100);
    });

    it('deducts pts per DMMS violation', () => {
        const violFD = { ...fd,
            iasKts: new Float32Array(10).fill(60),   // below DMMS (70.2)
            bank: new Float32Array(10).fill(20),      // > 15°
            mlPhase: Array(10).fill('cruise'),
        };
        const s = scoreAirmanship(violFD, THRESHOLDS, null);
        expect(s.dmms).toBeLessThan(100);
    });
});

describe('scoreApproach', () => {
    it('returns null when no approach segments', () => {
        const noApproachFD = { ...fd, phases: [], approaches: [] };
        expect(scoreApproach(noApproachFD, THRESHOLDS)).toBeNull();
    });
});

describe('colorForScore', () => {
    it('returns green for 80+', () => { expect(colorForScore(85)).toBe('green'); });
    it('returns yellow for 60-79', () => { expect(colorForScore(70)).toBe('yellow'); });
    it('returns red for < 60', () => { expect(colorForScore(55)).toBe('red'); });
});
