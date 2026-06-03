// js/flight-physics.js

export function computeTAS(gs, course, windSpeed, windDir) {
    const cr = course  * Math.PI / 180;
    const wr = (windDir + 180) * Math.PI / 180;
    const tasN = gs * Math.cos(cr) - windSpeed * Math.cos(wr);
    const tasE = gs * Math.sin(cr) - windSpeed * Math.sin(wr);
    return Math.sqrt(tasN * tasN + tasE * tasE);
}

export function computePressureAlt(altFt, altimeterInHg) {
    return altFt - (altimeterInHg - 29.92) * 1000;
}

export function computeIAS(tas, pressureAlt, oatK) {
    const sigma = Math.pow(1 - 6.8755e-6 * pressureAlt, 5.2559) * (288.15 / oatK);
    return tas * Math.sqrt(Math.max(0, sigma));
}

export function computeHeadwind(windSpeed, windDir, course) {
    return windSpeed * Math.cos((windDir - course) * Math.PI / 180);
}

export function computeDMMS(vs1Kias) {
    return 1.404 * vs1Kias;
}

export function applyAirspeeds(fd, windsAtAlt, altimeterByRow) {
    fd.tasKts = new Float32Array(fd.rows);
    fd.iasKts = new Float32Array(fd.rows);
    let sumTas = 0, sumIas = 0, sumHw = 0;
    for (let i = 0; i < fd.rows; i++) {
        const { windSpeed, windDir, tempC } = windsAtAlt[i];
        const tas = computeTAS(fd.speedKts[i], fd.course[i], windSpeed, windDir);
        const pa  = computePressureAlt(fd.altFt[i], altimeterByRow[i]);
        const oatK = (tempC !== null && tempC !== undefined
            ? tempC
            : 15 - fd.altFt[i] * 0.002) + 273.15;
        fd.tasKts[i] = tas;
        fd.iasKts[i] = computeIAS(tas, pa, oatK);
        sumTas += tas;
        sumIas += fd.iasKts[i];
        sumHw  += computeHeadwind(windSpeed, windDir, fd.course[i]);
    }
    fd.avgTas = fd.rows > 0 ? sumTas / fd.rows : 0;
    fd.avgIas = fd.rows > 0 ? sumIas / fd.rows : 0;
    fd.avgHeadwindKt = fd.rows > 0 ? sumHw / fd.rows : 0;
}
