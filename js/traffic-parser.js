// js/traffic-parser.js
import { haversineNm } from './csv-parser.js';

export function parseTrafficNDJSON(text) {
    const snapshots = [];
    for (const line of text.trim().split('\n')) {
        if (!line.trim()) continue;
        try {
            const raw = JSON.parse(line);
            snapshots.push({
                tSec: raw.t,
                targets: (raw.targets || []).map(t => ({
                    icao:     t.icao,
                    callsign: t.cs || '',
                    lat:      t.lat,
                    lon:      t.lon,
                    altFt:    t.altFt,
                    speedKts: t.spdKts,
                    heading:  t.hdg,
                    squawk:   t.squawk || '',
                })),
            });
        } catch (_) {}
    }
    return { snapshots, proximityEvents: [] };
}

export function computeProximityEvents(snapshots, ownLat, ownLon, ownAlt) {
    const events = [];
    for (const snap of snapshots) {
        const rowIdx = Math.round(snap.tSec);
        const idx = Math.min(rowIdx, ownLat.length - 1);
        for (const t of snap.targets) {
            const horizNm = haversineNm(ownLat[idx], ownLon[idx], t.lat, t.lon);
            const vertFt  = Math.abs(ownAlt[idx] - t.altFt);
            if (horizNm < 3 && vertFt < 1000) {
                events.push({
                    tSec: snap.tSec, icao: t.icao, callsign: t.callsign,
                    horizNm, vertFt,
                    relAlt: t.altFt >= ownAlt[idx] + 100 ? 'above'
                          : t.altFt <= ownAlt[idx] - 100 ? 'below' : 'level',
                });
            }
        }
    }
    return events;
}

export function closestApproach(proximityEvents) {
    if (!proximityEvents.length) return null;
    return proximityEvents.reduce((best, e) =>
        e.horizNm < best.horizNm ? e : best
    );
}
