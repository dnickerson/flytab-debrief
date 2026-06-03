// js/gpx-export.js
export function toGPX(fd, filename) {
    const name = filename.replace(/\.csv$/, '');
    const pts = [];
    for (let i = 0; i < fd.rows; i++) {
        const lat  = (Math.round(fd.lat[i] * 1e5) / 1e5).toFixed(6);
        const lon  = (Math.round(fd.lon[i] * 1e5) / 1e5).toFixed(6);
        const elev = (fd.altFt[i] * 0.3048).toFixed(1);  // ft → metres
        const spd  = (fd.speedKts[i] * 0.514444).toFixed(2); // kts → m/s
        pts.push(
            `    <trkpt lat="${lat}" lon="${lon}">` +
            `<ele>${elev}</ele>` +
            `<extensions><speed>${spd}</speed></extensions>` +
            `</trkpt>`
        );
    }
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="flytab-debrief"',
        '  xmlns="http://www.topografix.com/GPX/1/1"',
        '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        `  <trk><name>${name}</name><trkseg>`,
        ...pts,
        '  </trkseg></trk>',
        '</gpx>',
    ].join('\n');
}
