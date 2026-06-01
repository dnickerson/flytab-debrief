import { describe, it, expect } from 'vitest';
import { parseTrafficNDJSON, computeProximityEvents } from '../js/traffic-parser.js';

const SAMPLE_NDJSON = [
    JSON.stringify({ t: 0, targets: [
        { icao: 'A12345', cs: 'AAL123', lat: 35.20, lon: -80.30, altFt: 3500, spdKts: 240, hdg: 185, squawk: '3421' }
    ]}),
    JSON.stringify({ t: 5, targets: [
        { icao: 'A12345', cs: 'AAL123', lat: 35.21, lon: -80.31, altFt: 3500, spdKts: 240, hdg: 185, squawk: '3421' }
    ]}),
].join('\n');

describe('parseTrafficNDJSON', () => {
    it('parses snapshot count', () => {
        const td = parseTrafficNDJSON(SAMPLE_NDJSON);
        expect(td.snapshots).toHaveLength(2);
    });

    it('maps cs field to callsign', () => {
        const td = parseTrafficNDJSON(SAMPLE_NDJSON);
        expect(td.snapshots[0].targets[0].callsign).toBe('AAL123');
    });

    it('preserves tSec', () => {
        const td = parseTrafficNDJSON(SAMPLE_NDJSON);
        expect(td.snapshots[1].tSec).toBe(5);
    });

    it('returns empty snapshots for empty input', () => {
        const td = parseTrafficNDJSON('');
        expect(td.snapshots).toHaveLength(0);
    });
});

describe('computeProximityEvents', () => {
    it('flags traffic within 3nm / 1000ft', () => {
        const snapshots = [{ tSec: 0, targets: [{
            icao: 'A12345', callsign: 'AAL123',
            lat: 35.12, lon: -80.23, altFt: 3600,
        }]}];
        const ownLat  = new Float32Array([35.12]);
        const ownLon  = new Float32Array([-80.23]);
        const ownAlt  = new Float32Array([3500]);
        const events = computeProximityEvents(snapshots, ownLat, ownLon, ownAlt);
        expect(events).toHaveLength(1);
        expect(events[0].horizNm).toBeLessThan(0.1);
        expect(events[0].vertFt).toBe(100);
        expect(events[0].relAlt).toBe('above');
    });

    it('does not flag traffic > 3nm away', () => {
        const snapshots = [{ tSec: 0, targets: [{
            icao: 'B99999', callsign: 'DAL456',
            lat: 36.00, lon: -80.23, altFt: 3600,
        }]}];
        const events = computeProximityEvents(
            snapshots,
            new Float32Array([35.12]),
            new Float32Array([-80.23]),
            new Float32Array([3500])
        );
        expect(events).toHaveLength(0);
    });
});
