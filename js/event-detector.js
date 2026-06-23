// js/event-detector.js
import { resolveLimits } from './engine-limits.js';

export function detectEvents(fd, trafficData, thr) {
    const events = [];
    const n = fd.rows;
    const L = resolveLimits(thr);   // engine envelope, single source of truth
    const DMMS = 1.404 * (thr.vs1Kias || 50);

    // CHT caution / danger — debounce: emit once per exceedance block
    for (let cyl = 0; cyl < 4; cyl++) {
        let cauBlock = false, danBlock = false;
        for (let i = 0; i < n; i++) {
            const v = fd.cht[cyl][i];
            if (v > L.chtDanger) {
                if (!danBlock) { events.push(_ev(i, 'CHT_DANGER', 'red', `CHT${cyl+1} ${v}°F`)); danBlock = true; }
            } else { danBlock = false; }
            if (v > L.chtCaution && v <= L.chtDanger) {
                if (!cauBlock) { events.push(_ev(i, 'CHT_CAUTION', 'orange', `CHT${cyl+1} ${v}°F`)); cauBlock = true; }
            } else { cauBlock = false; }
        }
    }

    // Red box: pctPower > 65 AND |pctFromPeak| < 50
    let rbBlock = false;
    for (let i = 0; i < n; i++) {
        if (fd.pctPower[i] > 65 && Math.abs(fd.pctFromPeak[i]) < 50) {
            if (!rbBlock) { events.push(_ev(i, 'RED_BOX', 'red', `${fd.pctPower[i].toFixed(0)}% pwr near peak`)); rbBlock = true; }
        } else { rbBlock = false; }
    }

    // ML anomaly
    for (let i = 0; i < n; i++) {
        if (fd.mlAnomaly[i]) events.push(_ev(i, 'ML_ANOMALY', 'purple', `score ${fd.mlScore[i].toFixed(2)}`));
    }

    // Carb ice: sustained 30s
    let carbSec = 0;
    for (let i = 0; i < n; i++) {
        const t = fd.carbTemp[i];
        if (t > 0 && t >= 32 && t <= 50) { carbSec++; if (carbSec === 30) events.push(_ev(i, 'CARB_ICE_RISK', 'orange', `carb ${t}°F`)); }
        else carbSec = 0;
    }

    // DMMS violation: IAS < DMMS+5 AND |bank| > 15 — debounce: one event per exceedance block
    if (fd.iasKts) {
        let dmmsBlock = false;
        for (let i = 0; i < n; i++) {
            if (fd.iasKts[i] < DMMS + 5 && Math.abs(fd.bank[i]) > 15) {
                if (!dmmsBlock) {
                    events.push(_ev(i, 'DMMS_VIOLATION', 'red', `IAS ${fd.iasKts[i].toFixed(0)}kt bank ${fd.bank[i].toFixed(0)}°`));
                    dmmsBlock = true;
                }
            } else { dmmsBlock = false; }
        }
    }

    // No DMMS condition in cruise > 60s
    let noDmmsSec = 0;
    for (let i = 0; i < n; i++) {
        if (fd.mlPhase[i] === 'cruise' && !fd.opCondition[i]) {
            noDmmsSec++; if (noDmmsSec === 60) events.push(_ev(i, 'NO_DMMS_CONDITION', 'orange', 'mixture undefined'));
        } else noDmmsSec = 0;
    }

    // Bank exceedance > 45° in cruise
    for (let i = 0; i < n; i++) {
        if (fd.mlPhase[i] === 'cruise' && Math.abs(fd.bank[i]) > 45)
            events.push(_ev(i, 'BANK_EXCEEDANCE', 'orange', `bank ${fd.bank[i].toFixed(0)}°`));
    }

    // Speed exceedance
    if (fd.iasKts && thr.vnoKias) {
        for (let i = 0; i < n; i++) {
            if (fd.iasKts[i] > thr.vnoKias)
                events.push(_ev(i, 'SPEED_EXCEEDANCE', 'red', `IAS ${fd.iasKts[i].toFixed(0)}kt`));
        }
    }

    // High sink rate in descent sustained 10s
    let sinkStreak = 0;
    for (let i = 1; i < n; i++) {
        if (fd.mlPhase[i] === 'descent') {
            const fpm = (fd.altFt[i - 1] - fd.altFt[i]) * 60;
            if (fpm > 1500) { sinkStreak++; if (sinkStreak === 10) events.push(_ev(i, 'SINK_RATE_HIGH', 'orange', `${fpm.toFixed(0)} fpm`)); }
            else sinkStreak = 0;
        }
    }

    // CHT ROC caution: sustained above the ROC limit at >65% power for 30s
    if (fd.chtRoc) {
        for (let cyl = 0; cyl < 4; cyl++) {
            let streak = 0;
            for (let i = 0; i < n; i++) {
                if (fd.pctPower[i] > 65 && Math.abs(fd.chtRoc[cyl][i]) > L.chtRocLimit) {
                    streak++;
                    if (streak === 30) {
                        events.push(_ev(i, 'CHT_ROC_CAUTION', 'orange',
                            `CHT${cyl + 1} ${fd.chtRoc[cyl][i].toFixed(0)}°F/min`));
                    }
                } else {
                    streak = 0;
                }
            }
        }
    }

    // Traffic proximity from pre-computed events
    if (trafficData?.proximityEvents) {
        for (const pe of trafficData.proximityEvents)
            events.push(_ev(pe.tSec, 'TRAFFIC_PROXIMITY', 'orange',
                `${pe.callsign || pe.icao} ${pe.horizNm.toFixed(1)}nm ${pe.vertFt}ft`));
    }

    events.sort((a, b) => a.tSec - b.tSec);
    return events;
}

function _ev(tSec, type, level, detail) {
    return { tSec, type, level, detail };
}
