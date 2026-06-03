// js/scorer.js
export function colorForScore(s) {
    return s >= 80 ? 'green' : s >= 60 ? 'yellow' : 'red';
}

function clamp(v) { return Math.max(0, Math.min(100, v)); }
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

// Build row-index arrays for named phases.
// Prefers fd.phases (physics-detected segments) over raw fd.mlPhase so scoring
// uses the same boundaries shown in the phase sidebar.
function _phaseRows(fd, ...names) {
    const want = new Set(names);
    const out = {};
    for (const n of names) out[n] = [];
    if (fd.phases && fd.phases.length) {
        for (const seg of fd.phases) {
            const pn = seg.pilotLabel ?? seg.name;
            if (want.has(pn))
                for (let i = seg.startIdx; i <= seg.endIdx; i++) out[pn].push(i);
        }
    } else {
        for (let i = 0; i < fd.rows; i++) {
            const pn = fd.mlPhase[i];
            if (want.has(pn)) out[pn].push(i);
        }
    }
    return out;
}

// Computes CHT rate of change (°F/min) per cylinder using a 10-second rolling window.
// Returns array of 4 Float32Arrays, one per cylinder.
export function computeChtRoc(fd) {
    const n = fd.rows;
    const roc = [
        new Float32Array(n), new Float32Array(n),
        new Float32Array(n), new Float32Array(n),
    ];
    for (let c = 0; c < 4; c++) {
        for (let i = 0; i < n; i++) {
            const lookback = Math.min(i, 10);
            if (lookback < 2) { roc[c][i] = 0; continue; }
            if (fd.cht[c][i] <= 0 || fd.cht[c][i - lookback] <= 0) { roc[c][i] = 0; continue; }
            roc[c][i] = (fd.cht[c][i] - fd.cht[c][i - lookback]) / lookback * 60;
        }
    }
    return roc;
}

export function scoreEngineMgmt(fd, thr) {
    const n = fd.rows;

    // CHT: deduct 0.5/s above caution, 2.0/s above danger
    let chtScore = 100;
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < 4; c++) {
            const v = fd.cht[c][i];
            if (v > thr.chtDanger)  chtScore -= 2.0;
            else if (v > thr.chtCaution) chtScore -= 0.5;
        }
    }
    chtScore = clamp(chtScore);

    // EGT balance: mean spread during cruise rows
    const { cruise: cruiseIdxs } = _phaseRows(fd, 'cruise');
    let egtScore = 100;
    if (cruiseIdxs.length) {
        const spreads = cruiseIdxs.map(i => {
            const vals = [fd.egt[0][i], fd.egt[1][i], fd.egt[2][i], fd.egt[3][i]].filter(v => v > 0);
            return vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : 0;
        });
        const mean = avg(spreads);
        egtScore = mean <= 50 ? 100 : mean <= 100 ? clamp(100 - (mean - 50)) : 0;
    }

    // Mixture: % cruise rows with defined condition; red box = hard floor 20
    let redBoxCount = 0, definedCount = 0;
    for (const i of cruiseIdxs) {
        if (fd.opCondition[i]) definedCount++;
        if (fd.pctPower[i] > 65 && Math.abs(fd.pctFromPeak[i]) < 50) redBoxCount++;
    }
    const pctDefined = cruiseIdxs.length ? definedCount / cruiseIdxs.length : 1;
    let mixtureScore = clamp(pctDefined * 100);
    if (redBoxCount > 0) mixtureScore = Math.min(mixtureScore, 20);

    // Oil temp: % rows in normal range
    let oilInRange = 0;
    for (let i = 0; i < n; i++) {
        const v = fd.oilTemp[i];
        if (v > 0 && v >= (thr.oilTempMin || 100) && v <= (thr.oilTempMax || 245)) oilInRange++;
    }
    const oilScore = clamp((oilInRange / n) * 100);

    // Carb ice: seconds in 32-50°F range
    let carbIceSec = 0;
    for (let i = 0; i < n; i++) {
        const t = fd.carbTemp[i];
        if (t > 0 && t >= 32 && t <= 50) carbIceSec++;
    }
    const carbIceScore = clamp(100 - carbIceSec * 0.5);

    // Fuel efficiency: actual vs expected SFC
    let ffScore = 100;
    if (thr.typicalSfc && cruiseIdxs.length) {
        const sfcVals = cruiseIdxs.map(i => fd.sfc[i]).filter(v => v > 0);
        if (sfcVals.length) {
            const pctDiff = Math.abs(avg(sfcVals) - thr.typicalSfc) / thr.typicalSfc * 100;
            ffScore = clamp(100 - Math.max(0, pctDiff - 5) * 5);
        }
    }

    // CHT ROC: deduct when any cylinder exceeds 50°F/min at >65% power
    let chtRocScore = 100;
    if (fd.chtRoc) {
        for (let i = 0; i < n; i++) {
            if (fd.pctPower[i] <= 65) continue;
            for (let c = 0; c < 4; c++) {
                const excess = Math.abs(fd.chtRoc[c][i]) - 50;
                if (excess > 0) chtRocScore -= excess * 0.05;
            }
        }
        chtRocScore = clamp(chtRocScore);
    }

    const subs = [chtScore, egtScore, mixtureScore, oilScore, carbIceScore, ffScore, chtRocScore];
    return {
        overall: clamp(Math.round(avg(subs))),
        cht: chtScore, egtBalance: egtScore, mixture: mixtureScore,
        oilTemp: oilScore, carbIce: carbIceScore, fuelEfficiency: ffScore,
        chtRoc: chtRocScore,
    };
}

export function scoreAirmanship(fd, thr, trafficData) {
    const n = fd.rows;
    const DMMS = 1.404 * (thr.vs1Kias || 50);
    const { cruise: cruiseIdxs, descent: descentIdxs } = _phaseRows(fd, 'cruise', 'descent');

    // Altitude discipline: std dev of altFt during cruise
    let altScore = 100;
    if (cruiseIdxs.length > 1) {
        const alts = cruiseIdxs.map(i => fd.altFt[i]);
        const mean = avg(alts);
        const std = Math.sqrt(avg(alts.map(a => (a - mean) ** 2)));
        altScore = std <= 100 ? 100 : std <= 300 ? clamp(100 - (std - 100) * 0.2) : clamp(60 - (std - 300) * 0.3);
    }

    // Bank discipline: % cruise rows with |bank| <= 30
    let bankScore = 100;
    if (cruiseIdxs.length) {
        const ok = cruiseIdxs.filter(i => Math.abs(fd.bank[i]) <= 30).length;
        bankScore = clamp((ok / cruiseIdxs.length) * 100);
        for (const i of cruiseIdxs)
            if (Math.abs(fd.bank[i]) > 45) bankScore = clamp(bankScore - 2);
    }

    // Speed discipline: uses IAS if available, else unscored
    let speedScore = 100;
    const vno = thr.vnoKias, vne = thr.vneKias;
    if (fd.iasKts && vno) {
        let over = 0;
        for (let i = 0; i < n; i++) {
            if (fd.iasKts[i] > vno) over++;
            if (fd.iasKts[i] > vne - 10) speedScore = clamp(speedScore - 5);
        }
        speedScore = clamp(speedScore - (over / n) * 100);
    }

    // DMMS discipline: violations when IAS < DMMS+5 AND |bank| > 15
    let dmmsScore = 100;
    if (fd.iasKts) {
        for (let i = 0; i < n; i++) {
            if (fd.iasKts[i] < DMMS + 5 && Math.abs(fd.bank[i]) > 15) {
                const inPattern = ['approach','landing'].includes(fd.mlPhase[i]);
                dmmsScore = clamp(dmmsScore - (inPattern ? 40 : 20));
            }
        }
    }

    // Descent management
    let descentScore = 100;
    let highSinkStreak = 0;
    for (const i of descentIdxs) {
        const sinkFpm = i > 0 ? (fd.altFt[i - 1] - fd.altFt[i]) * 60 : 0;
        if (sinkFpm > 1500) {
            highSinkStreak++;
            if (highSinkStreak >= 10) descentScore = clamp(descentScore - 10);
        } else { highSinkStreak = 0; }
    }

    const subs = [altScore, bankScore, speedScore, dmmsScore, descentScore];
    return {
        overall: clamp(Math.round(avg(subs))),
        altitude: altScore, bank: bankScore, speed: speedScore,
        dmms: dmmsScore, descent: descentScore,
    };
}

export function scoreApproach(fd, thr) {
    if (!fd.approaches || !fd.approaches.length) return null;
    const scores = fd.approaches.map(seg => _scoreOneApproach(fd, seg, thr));
    const overall = clamp(Math.round(avg(scores.map(s => s.overall))));
    return { overall, segments: scores };
}

function _scoreOneApproach(fd, seg, thr) {
    const n = seg.endIdx - seg.startIdx + 1;
    if (n < 1) return { overall: 100, stabilization: 100, sinkRate: 100 };
    const vref = thr.vrefKias || 65;

    // Stabilization: last 30 rows (≈500ft at typical sink rate)
    const stabStart = Math.max(seg.startIdx, seg.endIdx - 30);
    let stabScore = 100;
    for (let i = stabStart; i <= seg.endIdx; i++) {
        const bankOk  = Math.abs(fd.bank[i]) <= 5;
        const sinkFpm = i > 0 ? (fd.altFt[i - 1] - fd.altFt[i]) * 60 : 0;
        const sinkOk  = sinkFpm < 1000;
        const speedOk = !fd.iasKts || Math.abs(fd.iasKts[i] - vref) <= 10;
        if (!bankOk || !sinkOk || !speedOk) stabScore = clamp(stabScore - 3);
    }

    // Sink rate: mean fpm vs expected 3° glidepath rate
    let sinkScore = 100;
    const sinkRates = [];
    for (let i = seg.startIdx + 1; i <= seg.endIdx; i++) {
        const fpm = (fd.altFt[i - 1] - fd.altFt[i]) * 60;
        if (fpm > 0) sinkRates.push(fpm);
    }
    if (sinkRates.length) {
        const expected = vref * 5.31;  // 3° glidepath: fpm ≈ GS(kts) × tan(3°) × 6076/60
        const pctDiff = Math.abs(avg(sinkRates) - expected) / expected * 100;
        sinkScore = clamp(100 - Math.max(0, pctDiff - 10) * 2);
    }

    const subs = [stabScore, sinkScore];
    return { overall: clamp(Math.round(avg(subs))), stabilization: stabScore, sinkRate: sinkScore };
}

// Returns array of {name, startIdx, endIdx, durationSec, distNm, score}
// for each phase segment in fd.phases.
export function scorePhases(fd, thr, trafficData) {
    return fd.phases.map(seg => {
        const effectiveName = seg.pilotLabel ?? seg.name;
        const n = seg.endIdx - seg.startIdx + 1;
        if (n < 2) return { ...seg, score: 100, durationSec: n, distNm: 0 };

        // Distance for this segment
        let distNm = 0;
        for (let i = seg.startIdx + 1; i <= seg.endIdx; i++) {
            if (fd.lat[i] && fd.lon[i] && fd.lat[i-1] && fd.lon[i-1]) {
                const dLat = (fd.lat[i] - fd.lat[i-1]) * Math.PI / 180;
                const dLon = (fd.lon[i] - fd.lon[i-1]) * Math.PI / 180;
                const a = Math.sin(dLat/2)**2 +
                    Math.cos(fd.lat[i-1]*Math.PI/180)*Math.cos(fd.lat[i]*Math.PI/180)*Math.sin(dLon/2)**2;
                distNm += 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            }
        }

        // CHT violations in this phase
        let chtOk = 0;
        for (let i = seg.startIdx; i <= seg.endIdx; i++) {
            const maxCht = Math.max(fd.cht[0][i], fd.cht[1][i], fd.cht[2][i], fd.cht[3][i]);
            if (maxCht <= (thr.chtCaution || 380)) chtOk++;
        }
        const chtScore = clamp((chtOk / n) * 100);

        // CHT ROC violations
        let rocOk = n;
        if (fd.chtRoc) {
            rocOk = 0;
            for (let i = seg.startIdx; i <= seg.endIdx; i++) {
                const maxRoc = Math.max(...[0,1,2,3].map(c => Math.abs(fd.chtRoc[c][i])));
                if (fd.pctPower[i] <= 65 || maxRoc <= 50) rocOk++;
            }
        }
        const rocScore = clamp((rocOk / n) * 100);

        // Bank exceedance
        let bankOk = 0;
        for (let i = seg.startIdx; i <= seg.endIdx; i++) {
            if (Math.abs(fd.bank[i]) <= 30) bankOk++;
        }
        const bankScore = clamp((bankOk / n) * 100);

        // Speed discipline (IAS vs Vno) — skip if IAS not available
        let speedScore = 100;
        if (fd.iasKts && thr.vnoKias) {
            let speedOk = 0;
            for (let i = seg.startIdx; i <= seg.endIdx; i++) {
                if (fd.iasKts[i] <= thr.vnoKias) speedOk++;
            }
            speedScore = clamp((speedOk / n) * 100);
        }

        // Approach stabilization — only for approach/landing phases
        let approachScore = 100;
        if (effectiveName === 'approach' || effectiveName === 'landing') {
            const vref = thr.vrefKias || 65;
            const stabStart = Math.max(seg.startIdx, seg.endIdx - 30);
            let stabOk = 0, stabTotal = 0;
            for (let i = stabStart; i <= seg.endIdx; i++) {
                stabTotal++;
                const bankOkA  = Math.abs(fd.bank[i]) <= 5;
                const sinkFpm  = i > 0 ? (fd.altFt[i-1] - fd.altFt[i]) * 60 : 0;
                const sinkOkA  = sinkFpm < 1000;
                const speedOkA = !fd.iasKts || Math.abs(fd.iasKts[i] - vref) <= 10;
                if (bankOkA && sinkOkA && speedOkA) stabOk++;
            }
            approachScore = stabTotal > 0 ? clamp((stabOk / stabTotal) * 100) : 100;
        }

        const subs = effectiveName === 'approach' || effectiveName === 'landing'
            ? [chtScore, rocScore, bankScore, speedScore, approachScore]
            : [chtScore, rocScore, bankScore, speedScore];

        return {
            name: seg.name,
            effectiveName,
            startIdx: seg.startIdx,
            endIdx: seg.endIdx,
            durationSec: n,
            distNm: parseFloat(distNm.toFixed(1)),
            score: clamp(Math.round(avg(subs))),
            mlLabel: seg.mlLabel ?? null,
            mlAgreement: seg.mlAgreement ?? true,
            pilotLabel: seg.pilotLabel ?? null,
        };
    });
}
