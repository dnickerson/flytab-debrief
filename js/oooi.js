// js/oooi.js
export function detectOOOI(fd, depElevFt = null, arrElevFt = null) {
    const n = fd.rows;
    if (depElevFt === null) depElevFt = estimateFieldElev(fd.altFt, 0, Math.min(30, n));
    if (arrElevFt === null) arrElevFt = estimateFieldElev(fd.altFt, Math.max(0, n - 30), n);

    // OUT: first row where RPM >= 500 sustained 3 rows
    let outIdx = -1;
    for (let i = 0; i < n - 2; i++) {
        if (fd.rpm[i] >= 500 && fd.rpm[i+1] >= 500 && fd.rpm[i+2] >= 500) {
            outIdx = i; break;
        }
    }

    // OFF: first row after Out where alt > depElev+200 AND speed > 40
    let offIdx = -1;
    for (let i = Math.max(0, outIdx); i < n; i++) {
        if (fd.altFt[i] > depElevFt + 200 && fd.speedKts[i] > 40) {
            offIdx = i; break;
        }
    }

    // IN: last row where RPM > 0
    let inIdx = -1;
    for (let i = n - 1; i >= 0; i--) {
        if (fd.rpm[i] > 0) { inIdx = i; break; }
    }

    // ON: last row before IN where alt > arrElev+200 AND speed < 100
    let onIdx = -1;
    const end = inIdx >= 0 ? inIdx : n;
    for (let i = end - 1; i >= 0; i--) {
        if (fd.altFt[i] > arrElevFt + 200 && fd.speedKts[i] < 100) {
            onIdx = i; break;
        }
    }

    const base = fd.startUtc ? fd.startUtc.getTime() : 0;
    const toDate = idx => new Date(base + idx * 1000);

    const out = toDate(outIdx >= 0 ? outIdx : 0);
    const off = toDate(offIdx >= 0 ? offIdx : 0);
    const on  = toDate(onIdx  >= 0 ? onIdx  : n - 1);
    const inn = toDate(inIdx  >= 0 ? inIdx  : n - 1);

    return {
        out, off, on, in: inn,
        blockMinutes: (inn - out) / 60000,
        airMinutes:   (on  - off) / 60000,
    };
}

export function estimateFieldElev(altFt, startIdx, endIdx) {
    let min = Infinity;
    for (let i = startIdx; i < endIdx; i++)
        if (altFt[i] > 0 && altFt[i] < min) min = altFt[i];
    return min === Infinity ? 0 : min;
}
