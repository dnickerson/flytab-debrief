import { describe, it, expect } from 'vitest';
import { ENGINE_LIMITS, resolveLimits } from '../js/engine-limits.js';

describe('resolveLimits', () => {
    it('returns the canonical envelope when given no thresholds', () => {
        const L = resolveLimits({});
        expect(L.chtCaution).toBe(420);
        expect(L.chtDanger).toBe(450);
        expect(L.chtRocLimit).toBe(60);
        expect(L.egtSpreadCaution).toBe(100);
        expect(L.egtSpreadDanger).toBe(140);
        expect(L.oilTempMin).toBe(100);
        expect(L.oilTempMax).toBe(245);
    });

    it('is safe for null/undefined input', () => {
        expect(resolveLimits(null).chtRocLimit).toBe(60);
        expect(resolveLimits(undefined).chtCaution).toBe(420);
    });

    it('lets caller values win over defaults, leaving the rest untouched', () => {
        const L = resolveLimits({ chtCaution: 400, chtRocLimit: 45 });
        expect(L.chtCaution).toBe(400);
        expect(L.chtRocLimit).toBe(45);
        expect(L.chtDanger).toBe(450);   // untouched default
    });

    it('passes non-engine fields (V-speeds) straight through', () => {
        const L = resolveLimits({ vnoKias: 165, vneKias: 202 });
        expect(L.vnoKias).toBe(165);
        expect(L.vneKias).toBe(202);
        expect(L.chtCaution).toBe(420);  // engine default still present
    });

    it('does not mutate ENGINE_LIMITS', () => {
        const before = { ...ENGINE_LIMITS };
        resolveLimits({ chtCaution: 1 });
        expect(ENGINE_LIMITS).toEqual(before);
    });
});
