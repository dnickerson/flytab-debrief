// js/engine-limits.js
//
// Single source of truth for the engine operating envelope. Every consumer
// (scorer, score-panel, event-detector, engine-cluster) resolves its thresholds
// through resolveLimits(thr) so the same numbers govern scoring, badges, events,
// and the engine cluster — they cannot drift apart across modules.
//
// Values are data-derived for N194JT (carbureted Lycoming O-360-A1A) from 37
// flights. 380°F is this engine's CHT *optimal* (not a caution); max CHT ever
// recorded is 402°F. Cruise EGT spread runs median 63°F, p95 99°F, max 139°F.
// |CHT ROC| p99 is 53°F/min, so climb heating to ~55°F/min is normal.
export const ENGINE_LIMITS = {
    chtCaution: 420,        // °F
    chtDanger: 450,         // °F (ops-table max; 50°F under the 500°F bayonet redline)
    egtDanger: 1650,        // °F absolute
    egtSpreadCaution: 100,  // °F (cruise p95 ≈ 99)
    egtSpreadDanger: 140,   // °F (cruise max ≈ 139)
    chtRocLimit: 60,        // °F/min (|ROC| p99 ≈ 53)
    oilTempMin: 100,        // °F
    oilTempMax: 245,        // °F
    typicalSfc: 0.42,       // lb/hp/hr
};

// Merge caller-supplied thresholds (fetched aircraft-config.json, or a test stub)
// over the canonical envelope. Caller values win; any field the caller omits —
// including non-engine fields like V-speeds, which pass straight through — keeps
// the envelope default. Always returns a fully-populated object.
export function resolveLimits(thr) {
    return { ...ENGINE_LIMITS, ...(thr || {}) };
}
