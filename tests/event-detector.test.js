import { describe, it, expect } from 'vitest';
import { detectEvents } from '../js/event-detector.js';
import { readFileSync } from 'fs';
import { parseCSV } from '../js/csv-parser.js';

const fd = parseCSV(readFileSync('tests/fixtures/sample.csv', 'utf8'));
const THR = { chtCaution: 380, chtDanger: 435, vnoKias: 165, vs1Kias: 50 };

describe('detectEvents', () => {
    it('returns an array', () => {
        expect(detectEvents(fd, null, THR)).toBeInstanceOf(Array);
    });

    it('flags CHT_CAUTION when CHT exceeds caution threshold', () => {
        const highChtFD = { ...fd,
            cht: [new Float32Array(10).fill(390), fd.cht[1], fd.cht[2], fd.cht[3]],
        };
        const events = detectEvents(highChtFD, null, THR);
        expect(events.some(e => e.type === 'CHT_CAUTION')).toBe(true);
    });

    it('flags CHT_DANGER when CHT exceeds danger threshold', () => {
        const dangerFD = { ...fd,
            cht: [new Float32Array(10).fill(440), fd.cht[1], fd.cht[2], fd.cht[3]],
        };
        const events = detectEvents(dangerFD, null, THR);
        expect(events.some(e => e.type === 'CHT_DANGER')).toBe(true);
    });

    it('flags RED_BOX when high power near peak EGT', () => {
        const rbFD = { ...fd,
            pctPower: new Float32Array(10).fill(70),
            pctFromPeak: new Float32Array(10).fill(30),
        };
        const events = detectEvents(rbFD, null, THR);
        expect(events.some(e => e.type === 'RED_BOX')).toBe(true);
    });

    it('flags ML_ANOMALY when mlAnomaly = 1', () => {
        const mlFD = { ...fd, mlAnomaly: new Uint8Array(10).fill(1) };
        const events = detectEvents(mlFD, null, THR);
        expect(events.some(e => e.type === 'ML_ANOMALY')).toBe(true);
    });

    it('flags TRAFFIC_PROXIMITY from TrafficData proximity events', () => {
        const td = { proximityEvents: [{ tSec: 3, icao: 'ABC', callsign: 'AAL1', horizNm: 1.5, vertFt: 500, relAlt: 'level' }] };
        const events = detectEvents(fd, td, THR);
        expect(events.some(e => e.type === 'TRAFFIC_PROXIMITY')).toBe(true);
    });

    it('each event has tSec, type, level, detail fields', () => {
        const highChtFD = { ...fd, cht: [new Float32Array(10).fill(390), fd.cht[1], fd.cht[2], fd.cht[3]] };
        const events = detectEvents(highChtFD, null, THR);
        const ev = events[0];
        expect(ev).toHaveProperty('tSec');
        expect(ev).toHaveProperty('type');
        expect(ev).toHaveProperty('level');
        expect(ev).toHaveProperty('detail');
    });
});
