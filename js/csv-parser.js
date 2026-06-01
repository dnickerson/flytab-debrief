// js/csv-parser.js
export const CSV_COLS = {
    OIL_TEMP: 2, OIL_PRESS: 3, RPM: 7, FUEL_FLOW: 8, GAL_REM: 9,
    CARB_TEMP: 12, EGT1: 16, EGT2: 17, EGT3: 18, EGT4: 19,
    CHT1: 20, CHT2: 21, CHT3: 22, CHT4: 23,
    DATE: 24, TIME_Z: 25,
    LON: 26, LAT: 27, ALT_FT: 28, SPEED_KTS: 29,
    BANK: 30, PITCH: 31, COURSE: 33,
    PCT_POWER: 37, OP_COND: 38, PCT_FROM_PEAK: 39, SFC: 40,
    ML_PHASE: 41, ML_SCORE: 42, ML_ANOMALY: 43,
};

// Convert 12-hour Zulu time string "1:32:53 PM" → "13:32:53"
export function to24hUTC(timeStr) {
    const m = timeStr.trim().match(/^(\d+):(\d+):(\d+)\s*(AM|PM)$/i);
    if (!m) return timeStr;
    let h = parseInt(m[1]);
    const min = m[2], sec = m[3], ampm = m[4].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${min}:${sec}`;
}

export function parseCSV(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) throw new Error('CSV has no data rows');
    const data = lines.slice(1);
    const n = data.length;
    const C = CSV_COLS;

    const fd = {
        rows: n, sampleHz: 1,
        time: new Float32Array(n),
        rpm: new Float32Array(n),
        egt: [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)],
        cht: [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)],
        oilTemp: new Float32Array(n), oilPress: new Float32Array(n),
        carbTemp: new Float32Array(n), fuelFlow: new Float32Array(n),
        gallonsRem: new Float32Array(n), pctPower: new Float32Array(n),
        opCondition: [], pctFromPeak: new Float32Array(n), sfc: new Float32Array(n),
        lat: new Float32Array(n), lon: new Float32Array(n),
        altFt: new Float32Array(n), speedKts: new Float32Array(n),
        bank: new Float32Array(n), pitch: new Float32Array(n), course: new Float32Array(n),
        mlPhase: [], mlScore: new Float32Array(n), mlAnomaly: new Uint8Array(n),
        tasKts: null, iasKts: null,
        filename: '', depIcao: '', destIcao: '', startUtc: null,
        oooi: null, blockMinutes: 0, airMinutes: 0, totalDistanceNm: 0,
        phases: [], approaches: [],
        maxCht: 0, maxEgt: 0, avgFuelFlow: 0, totalFuelBurned: 0,
        avgTas: 0, avgIas: 0, avgHeadwindKt: 0,
        depMetar: '', destMetar: '', windsAloft: null,
    };

    let maxCht = 0, maxEgt = 0, totalFF = 0;
    for (let i = 0; i < n; i++) {
        const c = data[i].split(',');
        fd.time[i]        = i;
        fd.rpm[i]         = +c[C.RPM]    || 0;
        fd.oilTemp[i]     = +c[C.OIL_TEMP]  || 0;
        fd.oilPress[i]    = +c[C.OIL_PRESS] || 0;
        fd.fuelFlow[i]    = +c[C.FUEL_FLOW] || 0;
        fd.gallonsRem[i]  = +c[C.GAL_REM]   || 0;
        fd.carbTemp[i]    = +c[C.CARB_TEMP] || 0;
        for (let j = 0; j < 4; j++) {
            fd.egt[j][i] = +c[C.EGT1 + j] || 0;
            fd.cht[j][i] = +c[C.CHT1 + j] || 0;
            if (fd.cht[j][i] > maxCht) maxCht = fd.cht[j][i];
            if (fd.egt[j][i] > maxEgt) maxEgt = fd.egt[j][i];
        }
        fd.lon[i]         = +c[C.LON]   || 0;
        fd.lat[i]         = +c[C.LAT]   || 0;
        fd.altFt[i]       = +c[C.ALT_FT]    || 0;
        fd.speedKts[i]    = +c[C.SPEED_KTS] || 0;
        fd.bank[i]        = +c[C.BANK]  || 0;
        fd.pitch[i]       = +c[C.PITCH] || 0;
        fd.course[i]      = +c[C.COURSE] || 0;
        fd.pctPower[i]    = +c[C.PCT_POWER]     || 0;
        fd.pctFromPeak[i] = +c[C.PCT_FROM_PEAK] || 0;
        fd.sfc[i]         = +c[C.SFC]    || 0;
        fd.mlScore[i]     = +c[C.ML_SCORE]   || 0;
        fd.mlAnomaly[i]   = +c[C.ML_ANOMALY] || 0;
        fd.opCondition.push((c[C.OP_COND]  || '').trim());
        fd.mlPhase.push(   (c[C.ML_PHASE] || '').trim());
        totalFF += fd.fuelFlow[i];
    }

    // Parse startUtc from first data row (date col 24 + time_z col 25)
    try {
        const first = data[0].split(',');
        const dateStr = (first[C.DATE] || '').trim();       // "2026-04-12"
        const timeStr = (first[C.TIME_Z] || '').trim();     // "1:32:53 PM" (Zulu)
        if (dateStr && timeStr) {
            fd.startUtc = new Date(`${dateStr}T${to24hUTC(timeStr)}Z`);
        }
    } catch (_) {}

    fd.maxCht = maxCht;
    fd.maxEgt = maxEgt;
    fd.avgFuelFlow    = n > 0 ? totalFF / n : 0;
    fd.totalFuelBurned = totalFF / 3600;
    fd.phases   = segmentPhases(fd.mlPhase);
    fd.approaches = fd.phases.filter(p => p.name === 'approach');
    fd.totalDistanceNm = computeDistanceNm(fd.lat, fd.lon);
    return fd;
}

export function segmentPhases(mlPhase) {
    if (!mlPhase.length) return [];
    const segs = [];
    let cur = mlPhase[0], start = 0;
    for (let i = 1; i < mlPhase.length; i++) {
        if (mlPhase[i] !== cur) {
            segs.push({ name: cur, startIdx: start, endIdx: i - 1 });
            cur = mlPhase[i]; start = i;
        }
    }
    segs.push({ name: cur, startIdx: start, endIdx: mlPhase.length - 1 });
    return segs;
}

export function haversineNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function computeDistanceNm(lat, lon) {
    let total = 0;
    for (let i = 1; i < lat.length; i++)
        total += haversineNm(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    return total;
}
