import { describe, it, expect } from 'vitest';
import { toGPX } from '../js/gpx-export.js';
import { readFileSync } from 'fs';
import { parseCSV } from '../js/csv-parser.js';

const fd = parseCSV(readFileSync('tests/fixtures/sample.csv', 'utf8'));

describe('toGPX', () => {
    it('produces valid GPX 1.1 XML header', () => {
        const gpx = toGPX(fd, '20260511_KLKR-KGSP.csv');
        expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    });

    it('includes a trkpt for each row', () => {
        const gpx = toGPX(fd, '20260511_KLKR-KGSP.csv');
        const count = (gpx.match(/<trkpt/g) || []).length;
        expect(count).toBe(fd.rows);
    });

    it('includes lat/lon attributes', () => {
        const gpx = toGPX(fd, '20260511_KLKR-KGSP.csv');
        expect(gpx).toContain('lat="35.120000"');
        expect(gpx).toContain('lon="-80.230000"');
    });

    it('includes elevation', () => {
        const gpx = toGPX(fd, '20260511_KLKR-KGSP.csv');
        expect(gpx).toContain('<ele>');
    });
});
