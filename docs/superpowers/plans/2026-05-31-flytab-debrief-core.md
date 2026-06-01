# flytab-debrief Core: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the flytab-debrief standalone post-flight debrief web application — Python server, data pipeline, physics/scoring engine, and full interactive UI.

**Architecture:** Python HTTP server (port 8092, bound to 0.0.0.0) serves a vanilla JS single-page app and proxies AWC weather data and Claude API calls. Pure-function JS logic modules are ES modules tested with vitest. UI modules (Leaflet map replay, Chart.js panels) are tested manually by loading a real CSV.

**Tech Stack:** Python 3 (stdlib + `requests`), vanilla JS ES modules, Leaflet 1.9 (CDN), Chart.js 4 (CDN), vitest 1.x, pytest

---

## File Map

| File | Create/Modify | Responsibility |
|------|--------------|----------------|
| `package.json` | Create | vitest test runner config |
| `tests/fixtures/sample.csv` | Create | Minimal 10-row flight CSV for tests |
| `server/debrief-server.py` | Create | HTTP server: static, file API, AWC proxy, Claude proxy |
| `systemd/flytab-debrief.service` | Create | systemd unit |
| `start-debrief.sh` | Create | Dev launch script |
| `tests/test_server.py` | Create | pytest server tests |
| `js/csv-parser.js` | Create | CSV text → FlightData typed arrays + helpers |
| `tests/csv-parser.test.js` | Create | vitest for csv-parser |
| `js/oooi.js` | Create | Out/Off/On/In detection from FlightData |
| `tests/oooi.test.js` | Create | vitest for oooi |
| `js/traffic-parser.js` | Create | NDJSON → TrafficData + proximity events |
| `tests/traffic-parser.test.js` | Create | vitest for traffic-parser |
| `js/flight-physics.js` | Create | TAS, IAS, DMMS, headwind |
| `tests/flight-physics.test.js` | Create | vitest for flight-physics |
| `js/scorer.js` | Create | Engine mgmt + airmanship + approach scores |
| `tests/scorer.test.js` | Create | vitest for scorer |
| `js/event-detector.js` | Create | FlightData + TrafficData → Event[] |
| `tests/event-detector.test.js` | Create | vitest for event-detector |
| `js/gpx-export.js` | Create | FlightData → GPX 1.1 string |
| `tests/gpx-export.test.js` | Create | vitest for gpx-export |
| `index.html` | Create | Single-page entry point (ES module scripts) |
| `css/style.css` | Create | Design tokens + two-panel grid layout |
| `js/app.js` | Create | Main controller: flight list, load sequence, module wiring |
| `js/replay.js` | Create | Leaflet map, track, aircraft marker, scrubber, traffic markers |
| `js/charts.js` | Create | Chart.js: 5 tabbed time-series with cursor sync |
| `js/claude-review.js` | Create | Payload builder, /api/claude fetch, panel render, cache |

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tests/fixtures/sample.csv`
- Create: `.gitignore`

- [ ] **Step 1: Initialise npm and install vitest**

```bash
cd ~/flytab-debrief
npm init -y
npm install --save-dev vitest
```

- [ ] **Step 2: Set package.json type and test script**

Edit `package.json` so it reads:

```json
{
  "name": "flytab-debrief",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^1.0.0"
  }
}
```

- [ ] **Step 3: Create test fixture CSV**

`tests/fixtures/sample.csv` — 10 data rows, header matches FlyTab exactly:

```
Zulu_Time,MP,Oil Temp,Oil Pressure,Fuel Pressure,Volts,Amps,RPM,Fuel Flow,Gallons Remaining,Fuel Level 1,Fuel Level 2,Carb Temp,GP 2,GP 3,Thermalcouple,EGT 1,EGT 2,EGT 3,EGT 4,CHT 1,CHT 2,CHT 3,CHT 4,date,time_z,longitude,latitude,altitude_ft,speed_kts,bank,pitch,acc_vert,course,EGT Spread,CHT Spread,Max EGT,Final_Percent_Power,Operating_Condition,Percent,SFC,ml_phase,ml_score,ml_anomaly,ml_latency_ms
12:00:00 PM,24.5,180,75,0,13.8,0,2400,9.2,28.0,14.0,14.0,55,0,0,0,1380,1370,1390,1360,335,340,330,345,2026-05-11,12:00:00 PM,-80.23,35.12,3500,125,2.1,-0.5,0,185,30,15,1390,68,ROP,120,0.42,cruise,0.05,0,2
12:00:01 PM,24.5,181,75,0,13.8,0,2400,9.2,27.9,14.0,14.0,55,0,0,0,1382,1372,1392,1362,336,341,331,346,2026-05-11,12:00:01 PM,-80.24,35.13,3502,124,2.2,-0.4,0,186,30,15,1392,68,ROP,118,0.42,cruise,0.05,0,2
12:00:02 PM,24.4,181,75,0,13.8,0,2400,9.1,27.8,14.0,14.0,55,0,0,0,1381,1371,1391,1361,336,341,331,346,2026-05-11,12:00:02 PM,-80.25,35.14,3504,123,2.0,-0.3,0,186,30,15,1391,68,ROP,118,0.42,cruise,0.04,0,2
12:00:03 PM,24.4,182,75,0,13.8,0,2400,9.1,27.7,14.0,14.0,55,0,0,0,1380,1370,1390,1360,335,340,330,345,2026-05-11,12:00:03 PM,-80.26,35.15,3506,124,1.9,-0.3,0,186,30,15,1390,68,ROP,119,0.42,cruise,0.04,0,2
12:00:04 PM,24.5,182,74,0,13.8,0,2400,9.2,27.6,14.0,14.0,55,0,0,0,1381,1371,1391,1361,336,341,331,346,2026-05-11,12:00:04 PM,-80.27,35.16,3508,125,2.0,-0.4,0,187,30,15,1391,68,ROP,120,0.42,cruise,0.05,0,2
12:00:05 PM,24.5,183,74,0,13.8,0,2400,9.2,27.5,14.0,14.0,56,0,0,0,1380,1372,1390,1362,335,341,330,346,2026-05-11,12:00:05 PM,-80.28,35.17,3510,124,2.1,-0.3,0,187,30,15,1390,68,ROP,120,0.42,cruise,0.05,0,2
12:00:06 PM,24.4,183,74,0,13.8,0,2400,9.1,27.4,14.0,14.0,56,0,0,0,1382,1372,1392,1362,336,341,331,347,2026-05-11,12:00:06 PM,-80.29,35.18,3512,123,2.0,-0.3,0,187,30,15,1392,68,ROP,118,0.42,cruise,0.04,0,2
12:00:07 PM,24.5,184,74,0,13.8,0,2400,9.2,27.3,14.0,14.0,56,0,0,0,1381,1371,1391,1361,335,340,330,346,2026-05-11,12:00:07 PM,-80.30,35.19,3514,124,1.9,-0.4,0,188,30,15,1391,68,ROP,119,0.42,cruise,0.04,0,2
12:00:08 PM,24.5,184,74,0,13.8,0,2400,9.1,27.2,14.0,14.0,56,0,0,0,1380,1370,1390,1360,336,341,331,347,2026-05-11,12:00:08 PM,-80.31,35.20,3516,125,2.1,-0.5,0,188,30,15,1390,68,ROP,120,0.42,cruise,0.05,0,2
12:00:09 PM,24.4,185,73,0,13.8,0,2400,9.0,27.1,14.0,14.0,56,0,0,0,1382,1372,1392,1362,337,342,332,348,2026-05-11,12:00:09 PM,-80.32,35.21,3518,124,2.2,-0.3,0,188,31,15,1392,68,ROP,118,0.42,cruise,0.05,0,2
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
__pycache__/
*.pyc
.pytest_cache/
~/.flytab-debrief/
```

- [ ] **Step 5: Verify vitest runs**

```bash
npm test
```

Expected: `No test files found` (no tests yet — that's fine).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tests/fixtures/sample.csv .gitignore
git commit -m "chore: project setup — vitest, sample fixture, gitignore"
```

---

## Task 2: Python Server — Foundation

**Files:**
- Create: `server/debrief-server.py`
- Create: `tests/test_server.py`

- [ ] **Step 1: Install pytest and requests**

```bash
pip install pytest requests --break-system-packages
```

- [ ] **Step 2: Write failing server tests**

`tests/test_server.py`:

```python
import subprocess, time, requests, json, tempfile, os, pytest
from pathlib import Path

FLIGHTS = Path(tempfile.mkdtemp())
PORT = 18092

@pytest.fixture(scope='module', autouse=True)
def server():
    env = os.environ.copy()
    env['FLIGHTS_DIR'] = str(FLIGHTS)
    env['DEBRIEF_PORT'] = str(PORT)
    p = subprocess.Popen(['python3', 'server/debrief-server.py'], env=env)
    time.sleep(0.5)
    yield
    p.terminate()

BASE = f'http://localhost:{PORT}'

def test_health():
    r = requests.get(f'{BASE}/api/health')
    assert r.status_code == 200
    assert r.json() == {'ok': True}

def test_list_flights_empty():
    r = requests.get(f'{BASE}/api/flights')
    assert r.status_code == 200
    assert r.json() == []

def test_list_flights_with_csv():
    (FLIGHTS / '20260511_KLKR-KGSP.csv').write_text('header\nrow1')
    r = requests.get(f'{BASE}/api/flights')
    data = r.json()
    assert len(data) == 1
    assert data[0]['name'] == '20260511_KLKR-KGSP.csv'
    assert data[0]['hasTraffic'] == False

def test_list_flights_has_traffic():
    (FLIGHTS / '20260511_KLKR-KGSP_traffic.ndjson').write_text('{}')
    r = requests.get(f'{BASE}/api/flights')
    data = r.json()
    assert data[0]['hasTraffic'] == True

def test_serve_csv():
    r = requests.get(f'{BASE}/api/flights/20260511_KLKR-KGSP.csv')
    assert r.status_code == 200
    assert 'header' in r.text

def test_serve_missing():
    r = requests.get(f'{BASE}/api/flights/nope.csv')
    assert r.status_code == 404

def test_path_traversal_blocked():
    r = requests.get(f'{BASE}/api/flights/../etc/passwd')
    assert r.status_code == 404

def test_cors_header():
    r = requests.get(f'{BASE}/api/health')
    assert r.headers.get('Access-Control-Allow-Origin') == '*'

def test_notes_roundtrip():
    name = '20260511_KLKR-KGSP.csv'
    requests.put(f'{BASE}/api/notes/{name}', json={'text': 'good flight'})
    r = requests.get(f'{BASE}/api/notes/{name}')
    assert r.json()['text'] == 'good flight'

def test_review_roundtrip():
    name = '20260511_KLKR-KGSP.csv'
    requests.put(f'{BASE}/api/review/{name}', json={'narrative': 'Well done'})
    r = requests.get(f'{BASE}/api/review/{name}')
    assert r.json()['narrative'] == 'Well done'
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
pytest tests/test_server.py -v
```

Expected: `ConnectionRefusedError` (server doesn't exist yet).

- [ ] **Step 4: Write `server/debrief-server.py`**

```python
#!/usr/bin/env python3
"""flytab-debrief server — port 8092, 0.0.0.0"""
import json, mimetypes, os, urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

FLIGHTS_DIR = Path(os.environ.get('FLIGHTS_DIR', Path.home() / 'flights'))
PORT = int(os.environ.get('DEBRIEF_PORT', 8092))
STATIC_DIR = Path(__file__).parent.parent


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors(); self.end_headers()

    def do_GET(self):
        p = self.path.split('?')[0]
        if p == '/api/health':
            self._json({'ok': True})
        elif p == '/api/flights':
            self._list_flights()
        elif p.startswith('/api/flights/'):
            self._serve_flight(p[len('/api/flights/'):])
        elif p.startswith('/api/notes/'):
            self._get_notes(p[len('/api/notes/'):])
        elif p.startswith('/api/review/'):
            self._get_review(p[len('/api/review/'):])
        else:
            self._static(p)

    def do_PUT(self):
        p = self.path
        if p.startswith('/api/notes/'):
            self._put_notes(p[len('/api/notes/'):])
        elif p.startswith('/api/review/'):
            self._put_review(p[len('/api/review/'):])
        else:
            self._err(404)

    def do_POST(self):
        p = self.path
        if p == '/api/winds':   self._proxy_winds()
        elif p == '/api/metar': self._proxy_metar()
        elif p == '/api/claude': self._proxy_claude()
        else: self._err(404)

    # ── helpers ──────────────────────────────────────────────────────────────

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._cors(); self.end_headers()
        self.wfile.write(body)

    def _err(self, code):
        self._json({'error': 'not found'}, code)

    def _safe_name(self, name):
        return name and '/' not in name and '..' not in name

    def _read_body(self):
        n = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(n))

    # ── routes ───────────────────────────────────────────────────────────────

    def _list_flights(self):
        FLIGHTS_DIR.mkdir(parents=True, exist_ok=True)
        files = sorted(FLIGHTS_DIR.glob('*.csv'), reverse=True)
        result = [{'name': f.name,
                   'hasTraffic': (FLIGHTS_DIR / (f.stem + '_traffic.ndjson')).exists()}
                  for f in files]
        self._json(result)

    def _serve_flight(self, name):
        if not self._safe_name(name): return self._err(404)
        path = FLIGHTS_DIR / name
        if not path.exists(): return self._err(404)
        ct = 'text/csv' if name.endswith('.csv') else 'application/x-ndjson'
        data = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ct)
        self._cors(); self.end_headers()
        self.wfile.write(data)

    def _get_notes(self, name):
        if not self._safe_name(name): return self._err(404)
        path = FLIGHTS_DIR / (name + '.notes.txt')
        self._json({'text': path.read_text() if path.exists() else ''})

    def _put_notes(self, name):
        if not self._safe_name(name): return self._err(404)
        (FLIGHTS_DIR / (name + '.notes.txt')).write_text(self._read_body().get('text', ''))
        self._json({'ok': True})

    def _get_review(self, name):
        if not self._safe_name(name): return self._err(404)
        path = FLIGHTS_DIR / (name + '.review.json')
        self._json(json.loads(path.read_text()) if path.exists() else None)

    def _put_review(self, name):
        if not self._safe_name(name): return self._err(404)
        n = int(self.headers.get('Content-Length', 0))
        (FLIGHTS_DIR / (name + '.review.json')).write_bytes(self.rfile.read(n))
        self._json({'ok': True})

    def _proxy_winds(self):
        body = self._read_body()
        fcst = body.get('fcst', '06')
        url = f'https://aviationweather.gov/api/data/windtemp?region=all&level=low&fcst={fcst}'
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                self._json({'raw': r.read().decode()})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _proxy_metar(self):
        body = self._read_body()
        icao = body.get('icao', '')
        url = f'https://aviationweather.gov/api/data/metar?ids={icao}&format=raw&taf=false'
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                self._json({'metar': r.read().decode().strip()})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _proxy_claude(self):
        api_key = os.environ.get('ANTHROPIC_API_KEY', '')
        if not api_key:
            return self._json({'error': 'ANTHROPIC_API_KEY not set'}, 500)
        body = self._read_body()
        payload = body.get('payload', {})
        system = ("You are an experienced CFI and A&P mechanic reviewing a post-flight data debrief "
                  "for an IFR-rated pilot flying an experimental RV-9A with a Lycoming O-360 A1A engine. "
                  "Provide honest, specific, actionable feedback in 3-5 paragraphs covering what went well, "
                  "what to watch, engine management, and any safety items. Reference specific times and "
                  "values. Be direct — this pilot has 1000+ hours.")
        req_body = json.dumps({
            "model": "claude-sonnet-4-6",
            "max_tokens": 1024,
            "system": [{"type": "text", "text": system,
                        "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": json.dumps(payload)}]
        }).encode()
        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages', data=req_body,
            headers={'Content-Type': 'application/json',
                     'x-api-key': api_key,
                     'anthropic-version': '2023-06-01',
                     'anthropic-beta': 'prompt-caching-2024-07-31'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                self._json({'narrative': json.loads(r.read())['content'][0]['text']})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _static(self, path):
        if path in ('', '/'):
            path = '/index.html'
        fp = STATIC_DIR / path.lstrip('/')
        if not fp.exists() or not fp.is_file():
            return self._err(404)
        ct, _ = mimetypes.guess_type(str(fp))
        data = fp.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ct or 'application/octet-stream')
        self._cors(); self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    FLIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    print(f'flytab-debrief on :{PORT}')
    HTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
```

- [ ] **Step 5: Run tests — all should pass**

```bash
pytest tests/test_server.py -v
```

Expected:
```
tests/test_server.py::test_health PASSED
tests/test_server.py::test_list_flights_empty PASSED
tests/test_server.py::test_list_flights_with_csv PASSED
tests/test_server.py::test_list_flights_has_traffic PASSED
tests/test_server.py::test_serve_csv PASSED
tests/test_server.py::test_serve_missing PASSED
tests/test_server.py::test_path_traversal_blocked PASSED
tests/test_server.py::test_cors_header PASSED
tests/test_server.py::test_notes_roundtrip PASSED
tests/test_server.py::test_review_roundtrip PASSED
10 passed
```

- [ ] **Step 6: Commit**

```bash
git add server/debrief-server.py tests/test_server.py
git commit -m "feat(server): HTTP server with file API, notes, review, external proxies"
```

---

## Task 3: systemd Service + Start Script

**Files:**
- Create: `systemd/flytab-debrief.service`
- Create: `start-debrief.sh`

- [ ] **Step 1: Create start script**

`start-debrief.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Dev default: ~/engine_analysis (120+ real FlyTab CSVs)
# Production: set FLIGHTS_DIR=~/flights or rely on systemd Environment=
export FLIGHTS_DIR="${FLIGHTS_DIR:-$HOME/engine_analysis}"
export DEBRIEF_PORT="${DEBRIEF_PORT:-8092}"
cd "$(dirname "$0")"
python3 server/debrief-server.py
```

```bash
chmod +x start-debrief.sh
```

- [ ] **Step 2: Create systemd unit**

`systemd/flytab-debrief.service` (replace `YOUR_USER` with actual username):

```ini
[Unit]
Description=FlyTab Debrief Server
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/flytab-debrief
ExecStart=/usr/bin/python3 /home/YOUR_USER/flytab-debrief/server/debrief-server.py
Restart=on-failure
RestartSec=5
Environment=FLIGHTS_DIR=/home/YOUR_USER/flights
Environment=DEBRIEF_PORT=8092

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Install and enable (run manually once, not in CI)**

```bash
sudo cp systemd/flytab-debrief.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now flytab-debrief
sudo systemctl status flytab-debrief
```

Expected: `Active: active (running)`.

- [ ] **Step 4: Commit**

```bash
git add start-debrief.sh systemd/flytab-debrief.service
git commit -m "feat(server): systemd service and start script"
```

---

## Task 4: csv-parser.js

**Files:**
- Create: `js/csv-parser.js`
- Create: `tests/csv-parser.test.js`

- [ ] **Step 1: Write failing tests**

`tests/csv-parser.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseCSV, haversineNm, segmentPhases, to24hUTC } from '../js/csv-parser.js';

const SAMPLE = readFileSync('tests/fixtures/sample.csv', 'utf8');

describe('parseCSV', () => {
    it('returns correct row count', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.rows).toBe(10);
    });

    it('parses RPM from column 7', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.rpm[0]).toBe(2400);
    });

    it('parses EGT1 from column 16', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.egt[0][0]).toBe(1380);
    });

    it('parses CHT4 from column 23', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.cht[3][0]).toBe(345);
    });

    it('parses latitude from column 27', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.lat[0]).toBeCloseTo(35.12, 2);
    });

    it('parses Operating_Condition string', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.opCondition[0]).toBe('ROP');
    });

    it('parses ml_phase string', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.mlPhase[0]).toBe('cruise');
    });

    it('computes maxCht correctly', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.maxCht).toBeGreaterThanOrEqual(345);
    });

    it('uses Float32Array for rpm', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.rpm).toBeInstanceOf(Float32Array);
    });

    it('uses Uint8Array for mlAnomaly', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.mlAnomaly).toBeInstanceOf(Uint8Array);
    });

    it('sets totalDistanceNm > 0 for moving flight', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.totalDistanceNm).toBeGreaterThan(0);
    });

    it('parses startUtc as a valid Date from date+time_z columns', () => {
        const fd = parseCSV(SAMPLE);
        expect(fd.startUtc).toBeInstanceOf(Date);
        expect(isNaN(fd.startUtc.getTime())).toBe(false);
        // sample.csv first row date=2026-05-11, time_z=12:00:00 PM → 2026-05-11T12:00:00Z
        expect(fd.startUtc.toISOString()).toBe('2026-05-11T12:00:00.000Z');
    });
});

describe('to24hUTC', () => {
    it('converts PM time correctly', () => {
        expect(to24hUTC('1:32:53 PM')).toBe('13:32:53');
    });

    it('converts 12:00 PM (noon) correctly', () => {
        expect(to24hUTC('12:00:00 PM')).toBe('12:00:00');
    });

    it('converts 12:00 AM (midnight) correctly', () => {
        expect(to24hUTC('12:00:00 AM')).toBe('00:00:00');
    });

    it('converts AM time correctly', () => {
        expect(to24hUTC('9:05:30 AM')).toBe('09:05:30');
    });
});

describe('segmentPhases', () => {
    it('groups consecutive identical phases', () => {
        const phases = segmentPhases(['climb','climb','cruise','cruise','cruise','descent']);
        expect(phases).toHaveLength(3);
        expect(phases[0]).toEqual({ name: 'climb', startIdx: 0, endIdx: 1 });
        expect(phases[1]).toEqual({ name: 'cruise', startIdx: 2, endIdx: 4 });
        expect(phases[2]).toEqual({ name: 'descent', startIdx: 5, endIdx: 5 });
    });

    it('handles single-phase flight', () => {
        const phases = segmentPhases(['ground','ground']);
        expect(phases).toHaveLength(1);
        expect(phases[0].endIdx).toBe(1);
    });
});

describe('haversineNm', () => {
    it('returns ~0 for identical points', () => {
        expect(haversineNm(35, -80, 35, -80)).toBeCloseTo(0, 5);
    });

    it('returns ~60nm for 1 degree latitude', () => {
        expect(haversineNm(35, -80, 36, -80)).toBeCloseTo(60.04, 0);
    });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm test
```

Expected: `Cannot find module '../js/csv-parser.js'`

- [ ] **Step 3: Implement `js/csv-parser.js`**

```javascript
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
```

- [ ] **Step 4: Run tests — all pass**

```bash
npm test
```

Expected: `18 passed`

- [ ] **Step 5: Commit**

```bash
git add js/csv-parser.js tests/csv-parser.test.js
git commit -m "feat(parser): CSV → FlightData typed arrays, startUtc parsing, phase segmentation, haversine"
```

---

## Task 5: oooi.js

**Files:**
- Create: `js/oooi.js`
- Create: `tests/oooi.test.js`

- [ ] **Step 1: Write failing tests**

`tests/oooi.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { detectOOOI, estimateFieldElev } from '../js/oooi.js';

function makeFD(rows, overrides = {}) {
    const rpm    = new Float32Array(rows);
    const altFt  = new Float32Array(rows);
    const speedKts = new Float32Array(rows);
    Object.assign(rpm, overrides.rpm || []);
    Object.assign(altFt, overrides.altFt || []);
    Object.assign(speedKts, overrides.speedKts || []);
    return { rows, rpm, altFt, speedKts, startUtc: new Date('2026-05-11T14:00:00Z') };
}

describe('detectOOOI', () => {
    it('detects Out when RPM sustained >= 500 for 3 rows', () => {
        const fd = makeFD(10, { rpm: [0, 0, 600, 600, 600, 600, 600, 600, 600, 0] });
        const o = detectOOOI(fd, 500, 500);
        expect(o.out).toBeInstanceOf(Date);
        // row 2 is first sustained 500+ RPM → 2s after startUtc
        expect(o.out.getTime()).toBe(new Date('2026-05-11T14:00:02Z').getTime());
    });

    it('detects Off when alt > depElev+200 AND speed > 40', () => {
        const fd = makeFD(10, {
            rpm:      [600, 600, 600, 600, 600, 600, 600, 600, 600, 600],
            altFt:    [500, 500, 500, 500, 750, 800, 850, 900, 950, 100],
            speedKts: [30,  30,  30,  30,  50,  80,  90,  100, 110, 10],
        });
        const o = detectOOOI(fd, 500, 0);
        // depElev=500, threshold=700; first row with alt>700 AND speed>40 is row 4
        expect(o.off.getTime()).toBe(new Date('2026-05-11T14:00:04Z').getTime());
    });

    it('detects In as last row with RPM > 0', () => {
        const fd = makeFD(10, { rpm: [600, 600, 600, 600, 600, 600, 600, 0, 0, 0] });
        const o = detectOOOI(fd, 0, 0);
        expect(o.in.getTime()).toBe(new Date('2026-05-11T14:00:06Z').getTime());
    });

    it('computes blockMinutes as In - Out', () => {
        const fd = makeFD(100, {
            rpm: new Float32Array(100).fill(600),
        });
        const o = detectOOOI(fd, 0, 0);
        expect(o.blockMinutes).toBeGreaterThan(0);
    });
});

describe('estimateFieldElev', () => {
    it('returns minimum positive altitude in the window', () => {
        const altFt = new Float32Array([0, 500, 520, 510, 530, 0]);
        expect(estimateFieldElev(altFt, 1, 5)).toBe(500);
    });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test tests/oooi.test.js
```

Expected: `Cannot find module '../js/oooi.js'`

- [ ] **Step 3: Implement `js/oooi.js`**

```javascript
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
```

- [ ] **Step 4: Run tests — all pass**

```bash
npm test tests/oooi.test.js
```

Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add js/oooi.js tests/oooi.test.js
git commit -m "feat(oooi): Out/Off/On/In detection from RPM and GPS altitude"
```

---

## Task 6: traffic-parser.js

**Files:**
- Create: `js/traffic-parser.js`
- Create: `tests/traffic-parser.test.js`

- [ ] **Step 1: Write failing tests**

`tests/traffic-parser.test.js`:

```javascript
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
        // own-ship at same position, 100ft below
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test tests/traffic-parser.test.js
```

- [ ] **Step 3: Implement `js/traffic-parser.js`**

```javascript
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
                    relAlt: t.altFt > ownAlt[idx] + 100 ? 'above'
                          : t.altFt < ownAlt[idx] - 100 ? 'below' : 'level',
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
```

- [ ] **Step 4: Run tests — all pass**

```bash
npm test tests/traffic-parser.test.js
```

Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add js/traffic-parser.js tests/traffic-parser.test.js
git commit -m "feat(traffic): NDJSON parser and proximity event detection"
```

---

## Task 7: flight-physics.js

**Files:**
- Create: `js/flight-physics.js`
- Create: `tests/flight-physics.test.js`

- [ ] **Step 1: Write failing tests**

`tests/flight-physics.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
    computeTAS, computeIAS, computePressureAlt,
    computeHeadwind, computeDMMS, applyAirspeeds,
} from '../js/flight-physics.js';

describe('computeTAS', () => {
    it('returns GS when wind is calm', () => {
        expect(computeTAS(120, 0, 0, 0)).toBeCloseTo(120, 1);
    });

    it('adds headwind component to get higher TAS', () => {
        // flying north (course=0), wind from north (windDir=0) → headwind
        const tas = computeTAS(120, 0, 10, 0);
        expect(tas).toBeCloseTo(130, 0);
    });

    it('subtracts tailwind to get lower TAS', () => {
        // flying north (0), wind from south (180) → tailwind
        const tas = computeTAS(120, 0, 10, 180);
        expect(tas).toBeCloseTo(110, 0);
    });
});

describe('computePressureAlt', () => {
    it('returns GPS alt when altimeter is 29.92', () => {
        expect(computePressureAlt(5000, 29.92)).toBeCloseTo(5000, 1);
    });

    it('adds correction for low altimeter setting', () => {
        // altimeter 29.42 → +500 ft
        expect(computePressureAlt(5000, 29.42)).toBeCloseTo(5500, 0);
    });
});

describe('computeIAS', () => {
    it('equals TAS at sea level in ISA conditions', () => {
        // At sea level (pressAlt=0), OAT_K=288.15: sigma=1, IAS=TAS
        expect(computeIAS(100, 0, 288.15)).toBeCloseTo(100, 1);
    });

    it('IAS < TAS at altitude', () => {
        const ias = computeIAS(150, 8000, 278);
        expect(ias).toBeLessThan(150);
    });
});

describe('computeHeadwind', () => {
    it('returns full wind speed when flying directly into wind', () => {
        // wind FROM 270 (west), course 270 → headwind = full wind speed
        expect(computeHeadwind(20, 270, 270)).toBeCloseTo(20, 1);
    });

    it('returns negative for tailwind', () => {
        // wind FROM 090 (east), course 270 → tailwind
        expect(computeHeadwind(20, 90, 270)).toBeCloseTo(-20, 1);
    });
});

describe('computeDMMS', () => {
    it('returns 1.404 * VS1', () => {
        expect(computeDMMS(50)).toBeCloseTo(70.2, 1);
    });
});

describe('applyAirspeeds', () => {
    it('populates tasKts and iasKts Float32Arrays', () => {
        const fd = {
            rows: 3,
            speedKts: new Float32Array([120, 122, 121]),
            course: new Float32Array([185, 185, 185]),
            altFt: new Float32Array([3500, 3500, 3500]),
            tasKts: null, iasKts: null,
            avgTas: 0, avgIas: 0, avgHeadwindKt: 0,
        };
        const winds = [
            { windSpeed: 10, windDir: 180, tempC: 10 },
            { windSpeed: 10, windDir: 180, tempC: 10 },
            { windSpeed: 10, windDir: 180, tempC: 10 },
        ];
        const altimeters = new Float32Array([29.92, 29.92, 29.92]);
        applyAirspeeds(fd, winds, altimeters);
        expect(fd.tasKts).toBeInstanceOf(Float32Array);
        expect(fd.iasKts).toBeInstanceOf(Float32Array);
        expect(fd.avgTas).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test tests/flight-physics.test.js
```

- [ ] **Step 3: Implement `js/flight-physics.js`**

```javascript
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
```

- [ ] **Step 4: Run tests — all pass**

```bash
npm test tests/flight-physics.test.js
```

Expected: `9 passed`

- [ ] **Step 5: Commit**

```bash
git add js/flight-physics.js tests/flight-physics.test.js
git commit -m "feat(physics): TAS wind triangle, IAS density correction, DMMS"
```

---

## Task 8: scorer.js

**Files:**
- Create: `js/scorer.js`
- Create: `tests/scorer.test.js`

- [ ] **Step 1: Write failing tests**

`tests/scorer.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { scoreEngineMgmt, scoreAirmanship, scoreApproach, colorForScore } from '../js/scorer.js';
import { readFileSync } from 'fs';
import { parseCSV } from '../js/csv-parser.js';

const fd = parseCSV(readFileSync('tests/fixtures/sample.csv', 'utf8'));

const THRESHOLDS = {
    chtCaution: 380, chtDanger: 435, egtDanger: 1650,
    oilTempMin: 100, oilTempMax: 245,
    vnoKias: 165, vneKias: 202, vs1Kias: 50, vrefKias: 65,
    typicalSfc: 0.42,
};

describe('scoreEngineMgmt', () => {
    it('returns a score between 0 and 100', () => {
        const s = scoreEngineMgmt(fd, THRESHOLDS);
        expect(s.overall).toBeGreaterThanOrEqual(0);
        expect(s.overall).toBeLessThanOrEqual(100);
    });

    it('returns sub-scores for all 5 categories', () => {
        const s = scoreEngineMgmt(fd, THRESHOLDS);
        expect(s).toHaveProperty('cht');
        expect(s).toHaveProperty('egtBalance');
        expect(s).toHaveProperty('mixture');
        expect(s).toHaveProperty('oilTemp');
        expect(s).toHaveProperty('carbIce');
    });

    it('scores CHT=100 when all CHTs stay below caution', () => {
        // sample.csv has max CHT 348 — well below 380 caution
        const s = scoreEngineMgmt(fd, THRESHOLDS);
        expect(s.cht).toBe(100);
    });

    it('applies red box floor of 20 when in red box at high power', () => {
        // Build a FlightData with >65% power and pctFromPeak < 50
        const redFD = { ...fd,
            pctPower: new Float32Array(10).fill(70),
            pctFromPeak: new Float32Array(10).fill(30),
            mlPhase: Array(10).fill('cruise'),
            opCondition: Array(10).fill(''),
        };
        const s = scoreEngineMgmt(redFD, THRESHOLDS);
        expect(s.mixture).toBeLessThanOrEqual(20);
    });
});

describe('scoreAirmanship', () => {
    it('returns a score between 0 and 100', () => {
        const s = scoreAirmanship(fd, THRESHOLDS, null);
        expect(s.overall).toBeGreaterThanOrEqual(0);
        expect(s.overall).toBeLessThanOrEqual(100);
    });

    it('has DMMS = 100 when no violations', () => {
        // sample has IAS null (no winds data) → DMMS unscored, returns 100 as default
        const s = scoreAirmanship(fd, THRESHOLDS, null);
        expect(s.dmms).toBe(100);
    });

    it('deducts 20 pts per DMMS violation', () => {
        const violFD = { ...fd,
            iasKts: new Float32Array(10).fill(60),   // below DMMS (70.2)
            bank: new Float32Array(10).fill(20),      // > 15°
            mlPhase: Array(10).fill('cruise'),
        };
        const s = scoreAirmanship(violFD, THRESHOLDS, null);
        expect(s.dmms).toBeLessThan(100);
    });
});

describe('scoreApproach', () => {
    it('returns null when no approach segments', () => {
        const noApproachFD = { ...fd,
            phases: [],
            approaches: [],
        };
        expect(scoreApproach(noApproachFD, THRESHOLDS)).toBeNull();
    });
});

describe('colorForScore', () => {
    it('returns green for 80+', () => { expect(colorForScore(85)).toBe('green'); });
    it('returns yellow for 60-79', () => { expect(colorForScore(70)).toBe('yellow'); });
    it('returns red for < 60', () => { expect(colorForScore(55)).toBe('red'); });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test tests/scorer.test.js
```

- [ ] **Step 3: Implement `js/scorer.js`**

```javascript
// js/scorer.js
export function colorForScore(s) {
    return s >= 80 ? 'green' : s >= 60 ? 'yellow' : 'red';
}

function clamp(v) { return Math.max(0, Math.min(100, v)); }
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

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
    const cruiseIdxs = [];
    for (let i = 0; i < n; i++) if (fd.mlPhase[i] === 'cruise') cruiseIdxs.push(i);
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

    const subs = [chtScore, egtScore, mixtureScore, oilScore, carbIceScore, ffScore];
    return {
        overall: clamp(Math.round(avg(subs))),
        cht: chtScore, egtBalance: egtScore, mixture: mixtureScore,
        oilTemp: oilScore, carbIce: carbIceScore, fuelEfficiency: ffScore,
    };
}

export function scoreAirmanship(fd, thr, trafficData) {
    const n = fd.rows;
    const DMMS = 1.404 * (thr.vs1Kias || 50);
    const cruiseIdxs = [], descentIdxs = [];
    for (let i = 0; i < n; i++) {
        if (fd.mlPhase[i] === 'cruise')  cruiseIdxs.push(i);
        if (fd.mlPhase[i] === 'descent') descentIdxs.push(i);
    }

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
        const expected = vref * 101;  // 3° glidepath: fpm ≈ GS(kts) * 101
        const pctDiff = Math.abs(avg(sinkRates) - expected) / expected * 100;
        sinkScore = clamp(100 - Math.max(0, pctDiff - 10) * 2);
    }

    const subs = [stabScore, sinkScore];
    return { overall: clamp(Math.round(avg(subs))), stabilization: stabScore, sinkRate: sinkScore };
}
```

- [ ] **Step 4: Run tests — all pass**

```bash
npm test tests/scorer.test.js
```

Expected: `10 passed`

- [ ] **Step 5: Commit**

```bash
git add js/scorer.js tests/scorer.test.js
git commit -m "feat(scorer): engine management, airmanship, approach scoring engine"
```

---

## Task 9: event-detector.js

**Files:**
- Create: `js/event-detector.js`
- Create: `tests/event-detector.test.js`

- [ ] **Step 1: Write failing tests**

`tests/event-detector.test.js`:

```javascript
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test tests/event-detector.test.js
```

- [ ] **Step 3: Implement `js/event-detector.js`**

```javascript
// js/event-detector.js
export function detectEvents(fd, trafficData, thr) {
    const events = [];
    const n = fd.rows;
    const DMMS = 1.404 * (thr.vs1Kias || 50);

    // CHT caution / danger — debounce: emit once per exceedance block
    for (let cyl = 0; cyl < 4; cyl++) {
        let cauBlock = false, danBlock = false;
        for (let i = 0; i < n; i++) {
            const v = fd.cht[cyl][i];
            if (v > (thr.chtDanger || 435)) {
                if (!danBlock) { events.push(_ev(i, 'CHT_DANGER', 'red', `CHT${cyl+1} ${v}°F`)); danBlock = true; }
            } else { danBlock = false; }
            if (v > (thr.chtCaution || 380) && v <= (thr.chtDanger || 435)) {
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

    // DMMS violation: IAS < DMMS+5 AND |bank| > 15
    if (fd.iasKts) {
        for (let i = 0; i < n; i++) {
            if (fd.iasKts[i] < DMMS + 5 && Math.abs(fd.bank[i]) > 15)
                events.push(_ev(i, 'DMMS_VIOLATION', 'red', `IAS ${fd.iasKts[i].toFixed(0)}kt bank ${fd.bank[i].toFixed(0)}°`));
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
```

- [ ] **Step 4: Run tests — all pass**

```bash
npm test tests/event-detector.test.js
```

Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
git add js/event-detector.js tests/event-detector.test.js
git commit -m "feat(events): all 13 event types with debouncing"
```

---

## Task 10: gpx-export.js

**Files:**
- Create: `js/gpx-export.js`
- Create: `tests/gpx-export.test.js`

- [ ] **Step 1: Write failing tests**

`tests/gpx-export.test.js`:

```javascript
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
        expect(gpx).toContain('lat="35.12"');
        expect(gpx).toContain('lon="-80.23"');
    });

    it('includes elevation', () => {
        const gpx = toGPX(fd, '20260511_KLKR-KGSP.csv');
        expect(gpx).toContain('<ele>');
    });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test tests/gpx-export.test.js
```

- [ ] **Step 3: Implement `js/gpx-export.js`**

```javascript
// js/gpx-export.js
export function toGPX(fd, filename) {
    const name = filename.replace(/\.csv$/, '');
    const pts = [];
    for (let i = 0; i < fd.rows; i++) {
        const lat  = fd.lat[i].toFixed(6);
        const lon  = fd.lon[i].toFixed(6);
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
```

- [ ] **Step 4: Run tests — all pass**

```bash
npm test tests/gpx-export.test.js
```

Expected: `4 passed`

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all logic tests passing (csv-parser, oooi, traffic-parser, flight-physics, scorer, event-detector, gpx-export).

- [ ] **Step 6: Commit**

```bash
git add js/gpx-export.js tests/gpx-export.test.js
git commit -m "feat(export): GPX 1.1 track export from FlightData"
```

---

## Task 11: index.html + style.css

**Files:**
- Create: `index.html`
- Create: `css/style.css`

- [ ] **Step 1: Download CDN libs to local `lib/` (no external CDN in cockpit use)**

```bash
mkdir -p lib
curl -L https://unpkg.com/leaflet@1.9.4/dist/leaflet.js -o lib/leaflet.js
curl -L https://unpkg.com/leaflet@1.9.4/dist/leaflet.css -o lib/leaflet.css
curl -L https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js -o lib/chart.umd.min.js
```

- [ ] **Step 2: Create `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FlyTab Debrief</title>
  <link rel="stylesheet" href="lib/leaflet.css">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <!-- Flight selector overlay (shown on load when no ?file= param) -->
  <div id="flight-selector" class="selector-overlay">
    <div class="selector-panel">
      <h1 class="selector-title">FlyTab Debrief</h1>
      <div id="flight-list" class="flight-list">Loading…</div>
    </div>
  </div>

  <!-- Main debrief layout (hidden until flight loaded) -->
  <div id="debrief-root" class="debrief-root hidden">

    <!-- Header -->
    <header id="debrief-header" class="debrief-header"></header>

    <!-- Body: map left, data right -->
    <div class="debrief-body">
      <div id="map-panel" class="map-panel">
        <div id="map" class="leaflet-map"></div>
        <div class="map-color-pills">
          <button class="color-pill active" data-channel="ml">ML SCORE</button>
          <button class="color-pill" data-channel="cht">CHT</button>
          <button class="color-pill" data-channel="alt">ALT</button>
          <button class="color-pill" data-channel="speed">SPEED</button>
        </div>
        <button id="traffic-toggle" class="traffic-toggle hidden">TRAFFIC ON</button>
      </div>

      <div class="data-panel">
        <!-- Scorecard -->
        <div id="scorecard" class="scorecard"></div>
        <!-- Charts -->
        <div class="charts-panel">
          <div class="chart-tabs">
            <button class="chart-tab active" data-tab="altspeed">Alt/Speed</button>
            <button class="chart-tab" data-tab="egt">EGT</button>
            <button class="chart-tab" data-tab="cht">CHT</button>
            <button class="chart-tab" data-tab="ml">ML</button>
            <button class="chart-tab" data-tab="fuel">Fuel</button>
          </div>
          <div id="chart-container" class="chart-container">
            <canvas id="chart-canvas"></canvas>
          </div>
        </div>
      </div>
    </div>

    <!-- Scrubber / playback bar -->
    <div class="playback-bar">
      <button id="play-btn" class="play-btn">▶</button>
      <div class="scrubber-wrap">
        <div id="event-ticks" class="event-ticks"></div>
        <input id="scrubber" type="range" min="0" max="100" value="0" class="scrubber">
      </div>
      <div class="speed-btns">
        <button class="speed-btn active" data-speed="1">1×</button>
        <button class="speed-btn" data-speed="2">2×</button>
        <button class="speed-btn" data-speed="5">5×</button>
        <button class="speed-btn" data-speed="10">10×</button>
      </div>
      <span id="time-display" class="time-display">--:--:--Z</span>
      <button id="event-list-btn" class="event-list-btn">EVENTS</button>
    </div>

    <!-- Event list panel -->
    <div id="event-panel" class="event-panel hidden"></div>

    <!-- AI review panel -->
    <div id="ai-panel" class="ai-panel hidden"></div>

    <!-- Notes modal -->
    <div id="notes-modal" class="notes-modal hidden">
      <div class="notes-inner">
        <h3>Flight Notes</h3>
        <textarea id="notes-text" rows="8"></textarea>
        <div class="notes-actions">
          <button id="notes-save">SAVE</button>
          <button id="notes-close">CLOSE</button>
        </div>
      </div>
    </div>

  </div><!-- /debrief-root -->

  <!-- Load order: libs → logic modules → UI modules → app -->
  <script src="lib/leaflet.js"></script>
  <script src="lib/chart.umd.min.js"></script>
  <script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `css/style.css` with design tokens and layout**

```css
/* ── Design tokens (cockpit palette, sunlight-readable) ──────────── */
:root {
  --bg-primary:    #ffffff;
  --bg-surface:    #f5f5f5;
  --text-primary:  #1a1a2e;
  --text-secondary:#444444;
  --text-label:    #666666;
  --text-muted:    #888888;
  --accent:        #0066cc;
  --border:        #e0e0e0;
  --border-light:  #f0f0f0;
  --border-strong: #b0b0b0;
  --color-success: #1a8c35;
  --color-caution: #b87000;
  --color-danger:  #cc2222;
  --color-info:    #0055bb;
  --font-instrument: 'Courier New', monospace;
  --font-ui:       system-ui, sans-serif;
  --touch-min:     56px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; font-family: var(--font-ui); background: var(--bg-primary); color: var(--text-primary); }

/* ── Utilities ────────────────────────────────────────────────────── */
.hidden { display: none !important; }

/* ── Flight selector ──────────────────────────────────────────────── */
.selector-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--bg-primary); z-index: 1000; }
.selector-panel   { width: min(480px, 95vw); }
.selector-title   { font-size: 1.6rem; font-weight: 800; color: var(--text-primary); margin-bottom: 24px; text-align: center; }
.flight-list      { display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; }
.flight-item      { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; min-height: var(--touch-min); }
.flight-item:hover { background: var(--bg-surface); }
.flight-item-name { font-family: var(--font-instrument); font-weight: 700; font-size: 0.9rem; }
.flight-item-badge{ font-size: 0.7rem; color: var(--color-success); font-weight: 700; }

/* ── Main layout ─────────────────────────────────────────────────── */
.debrief-root { display: flex; flex-direction: column; height: 100vh; }
.debrief-header { flex: 0 0 auto; padding: 10px 16px; background: var(--bg-surface); border-bottom: 1px solid var(--border); font-size: 0.82rem; }
.debrief-body  { flex: 1 1 0; display: flex; overflow: hidden; }
.map-panel     { flex: 1 1 50%; position: relative; }
.leaflet-map   { width: 100%; height: 100%; }
.data-panel    { flex: 1 1 50%; display: flex; flex-direction: column; border-left: 1px solid var(--border); overflow: hidden; }
.playback-bar  { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-surface); border-top: 1px solid var(--border); }

/* ── Header ──────────────────────────────────────────────────────── */
.hdr-route    { font-weight: 800; font-size: 1rem; color: var(--text-primary); }
.hdr-stats    { color: var(--text-secondary); }
.hdr-oooi     { font-family: var(--font-instrument); font-size: 0.8rem; color: var(--text-label); }
.hdr-metar    { font-family: var(--font-instrument); font-size: 0.75rem; color: var(--text-muted); }
.hdr-actions  { display: flex; gap: 8px; margin-top: 6px; }
.hdr-btn      { padding: 6px 14px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg-primary); font-weight: 700; font-size: 0.8rem; cursor: pointer; min-height: var(--touch-min); }
.hdr-btn:hover { background: var(--accent); color: #fff; border-color: var(--accent); }

/* ── Map controls ────────────────────────────────────────────────── */
.map-color-pills { position: absolute; top: 10px; left: 10px; z-index: 400; display: flex; gap: 4px; }
.color-pill      { padding: 4px 10px; border-radius: 12px; border: 1px solid var(--border-strong); background: var(--bg-primary); font-size: 0.72rem; font-weight: 700; cursor: pointer; }
.color-pill.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.traffic-toggle  { position: absolute; top: 10px; right: 10px; z-index: 400; padding: 4px 10px; border-radius: 12px; border: 1px solid var(--border-strong); background: var(--bg-primary); font-size: 0.72rem; font-weight: 700; cursor: pointer; }

/* ── Scorecard ───────────────────────────────────────────────────── */
.scorecard           { padding: 12px; border-bottom: 1px solid var(--border); }
.sc-overall          { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.sc-overall-label    { font-weight: 800; font-size: 0.9rem; }
.sc-overall-score    { font-family: var(--font-instrument); font-weight: 900; font-size: 1.4rem; }
.sc-bar-wrap         { flex: 1; height: 10px; background: var(--border-light); border-radius: 5px; overflow: hidden; }
.sc-bar              { height: 100%; border-radius: 5px; transition: width 0.4s; }
.sc-bar.green  { background: var(--color-success); }
.sc-bar.yellow { background: var(--color-caution); }
.sc-bar.red    { background: var(--color-danger); }
.sc-category         { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 0.82rem; }
.sc-cat-label        { width: 110px; color: var(--text-secondary); font-weight: 700; }
.sc-cat-score        { font-family: var(--font-instrument); font-weight: 900; width: 28px; }
.sc-view-toggles     { display: flex; gap: 6px; margin-top: 8px; }
.sc-toggle           { padding: 4px 10px; border: 1px solid var(--border-strong); border-radius: 4px; font-size: 0.75rem; font-weight: 700; cursor: pointer; }
.sc-toggle.active    { background: var(--accent); color: #fff; }

/* ── Charts ──────────────────────────────────────────────────────── */
.charts-panel    { flex: 1 1 0; display: flex; flex-direction: column; overflow: hidden; }
.chart-tabs      { display: flex; border-bottom: 1px solid var(--border); }
.chart-tab       { flex: 1; padding: 8px 4px; font-size: 0.75rem; font-weight: 700; border: none; background: none; cursor: pointer; color: var(--text-label); }
.chart-tab.active { color: var(--accent); border-bottom: 2px solid var(--accent); }
.chart-container { flex: 1 1 0; padding: 8px; position: relative; }

/* ── Playback bar ────────────────────────────────────────────────── */
.play-btn        { width: 36px; height: 36px; border-radius: 50%; border: 2px solid var(--border-strong); background: var(--bg-primary); font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.scrubber-wrap   { flex: 1; position: relative; }
.event-ticks     { position: absolute; top: 0; left: 0; right: 0; height: 100%; pointer-events: none; }
.scrubber        { width: 100%; accent-color: var(--accent); }
.speed-btns      { display: flex; gap: 2px; }
.speed-btn       { padding: 4px 8px; border: 1px solid var(--border-strong); border-radius: 3px; font-size: 0.75rem; font-weight: 700; cursor: pointer; background: var(--bg-primary); }
.speed-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.time-display    { font-family: var(--font-instrument); font-weight: 700; font-size: 0.85rem; width: 75px; }
.event-list-btn  { padding: 4px 10px; border: 1px solid var(--border-strong); border-radius: 4px; font-size: 0.75rem; font-weight: 700; cursor: pointer; }

/* ── Event panel ─────────────────────────────────────────────────── */
.event-panel     { position: absolute; bottom: 60px; right: 0; width: 340px; max-height: 40vh; overflow-y: auto; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px 0 0 4px; z-index: 500; padding: 8px; }
.event-row       { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border-light); font-size: 0.78rem; cursor: pointer; }
.event-row:hover { background: var(--bg-surface); }
.ev-time         { font-family: var(--font-instrument); font-weight: 700; color: var(--text-muted); width: 55px; flex-shrink: 0; }
.ev-type         { font-weight: 800; width: 130px; flex-shrink: 0; }
.ev-type.red     { color: var(--color-danger); }
.ev-type.orange  { color: var(--color-caution); }
.ev-type.purple  { color: #7b2d8b; }
.ev-detail       { color: var(--text-secondary); }

/* ── AI review panel ─────────────────────────────────────────────── */
.ai-panel        { padding: 12px; border-top: 1px solid var(--border); background: var(--bg-surface); overflow-y: auto; max-height: 200px; font-size: 0.85rem; line-height: 1.5; }
.ai-loading      { color: var(--text-muted); font-style: italic; }

/* ── Notes modal ─────────────────────────────────────────────────── */
.notes-modal     { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); z-index: 1000; }
.notes-inner     { background: var(--bg-primary); border-radius: 8px; padding: 20px; width: min(500px, 90vw); }
.notes-inner h3  { font-weight: 800; margin-bottom: 12px; }
.notes-inner textarea { width: 100%; resize: vertical; padding: 8px; border: 1px solid var(--border-strong); border-radius: 4px; font-family: var(--font-ui); font-size: 0.9rem; }
.notes-actions   { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
.notes-actions button { padding: 8px 20px; border-radius: 4px; font-weight: 700; cursor: pointer; border: 1px solid var(--border-strong); }
```

- [ ] **Step 4: Open browser, verify layout renders**

```bash
bash start-debrief.sh &
open http://localhost:8092
```

Expected: selector overlay with "FlyTab Debrief" title and an empty flight list (no CSVs yet).

- [ ] **Step 5: Commit**

```bash
git add index.html css/style.css lib/
git commit -m "feat(ui): HTML skeleton, design tokens, two-panel layout, cockpit CSS"
```

---

## Task 12: app.js — Flight List + Loading Sequence

**Files:**
- Create: `js/app.js`

- [ ] **Step 1: Create `js/app.js`**

```javascript
// js/app.js
import { parseCSV }               from './csv-parser.js';
import { detectOOOI }             from './oooi.js';
import { parseTrafficNDJSON, computeProximityEvents, closestApproach } from './traffic-parser.js';
import { scoreEngineMgmt, scoreAirmanship, scoreApproach } from './scorer.js';
import { detectEvents }           from './event-detector.js';
import { initReplay }             from './replay.js';
import { initCharts }             from './charts.js';
import { initClaudeReview }       from './claude-review.js';

const API = '';  // relative — same origin as server

async function loadFlightList() {
    const r = await fetch(`${API}/api/flights`);
    const flights = await r.json();
    const list = document.getElementById('flight-list');
    if (!flights.length) {
        list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px">No flights found in ~/flights</p>';
        return;
    }
    list.innerHTML = flights.map(f => `
        <div class="flight-item" data-name="${f.name}">
          <span class="flight-item-name">${f.name}</span>
          ${f.hasTraffic ? '<span class="flight-item-badge">+ TRAFFIC</span>' : ''}
        </div>
    `).join('');
    list.querySelectorAll('.flight-item').forEach(el =>
        el.addEventListener('click', () => openFlight(el.dataset.name))
    );
}

async function openFlight(filename) {
    // Show loading state
    document.getElementById('flight-selector').classList.add('hidden');
    document.getElementById('debrief-root').classList.remove('hidden');

    // Fetch CSV
    const csvResp = await fetch(`${API}/api/flights/${encodeURIComponent(filename)}`);
    const csvText = await csvResp.text();
    const fd = parseCSV(csvText);
    fd.filename = filename;

    // Parse dep/dest from filename: YYYYMMDD_KLKR-KGSP.csv
    const m = filename.match(/\d{8}_([A-Z0-9]{3,4})-([A-Z0-9]{3,4})/);
    if (m) { fd.depIcao = m[1]; fd.destIcao = m[2]; }

    // Fetch traffic if available
    let trafficData = null;
    const trafficFilename = filename.replace(/\.csv$/, '_traffic.ndjson');
    try {
        const tr = await fetch(`${API}/api/flights/${encodeURIComponent(trafficFilename)}`);
        if (tr.ok) {
            const ndjson = await tr.text();
            trafficData = parseTrafficNDJSON(ndjson);
            trafficData.proximityEvents = computeProximityEvents(
                trafficData.snapshots, fd.lat, fd.lon, fd.altFt
            );
        }
    } catch (_) {}

    // OOOI (field elevations from server if available, else auto-detect)
    fd.oooi = detectOOOI(fd);
    fd.blockMinutes = fd.oooi.blockMinutes;
    fd.airMinutes   = fd.oooi.airMinutes;

    // Fetch METARs (fire-and-forget, fill in when done)
    fetchMETARs(fd);

    // Score
    const thr = await loadThresholds();
    const scores = {
        engineMgmt: scoreEngineMgmt(fd, thr),
        airmanship: scoreAirmanship(fd, thr, trafficData),
        approach:   scoreApproach(fd, thr),
    };
    scores.overall = Math.round(
        ([scores.engineMgmt.overall, scores.airmanship.overall,
          scores.approach?.overall ?? 100].reduce((a, b) => a + b, 0)) / 3
    );

    // Events
    const events = detectEvents(fd, trafficData, thr);

    // Render header
    renderHeader(fd, scores);

    // Init UI modules
    initReplay(fd, trafficData, events);
    initCharts(fd);
    renderScorecard(scores);
    renderEvents(events);
    initClaudeReview(fd, scores, events, trafficData);

    // Traffic toggle visibility
    const trafficToggle = document.getElementById('traffic-toggle');
    if (trafficData) trafficToggle.classList.remove('hidden');

    // Wire scrubber
    wireScrubber(fd, events);

    // Wire view toggles
    wireViewToggles(scores, events);

    // Save training log entry
    appendTrainingLog(filename, scores, events, trafficData);
}

async function loadThresholds() {
    // Try to fetch from FlyTab home server; fall back to hard-coded RV-9A defaults
    try {
        const r = await fetch('http://192.168.1.77:8090/aircraft-config.json',
            { signal: AbortSignal.timeout(2000) });
        if (r.ok) return await r.json();
    } catch (_) {}
    return {
        chtCaution: 380, chtDanger: 435, egtDanger: 1650,
        oilTempMin: 100, oilTempMax: 245,
        vnoKias: 165, vneKias: 202, vs1Kias: 50, vrefKias: 65,
        typicalSfc: 0.42,
    };
}

async function fetchMETARs(fd) {
    if (!fd.depIcao || !fd.destIcao) return;
    try {
        const [dep, dest] = await Promise.all([
            fetch('/api/metar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ icao: fd.depIcao }) }).then(r => r.json()),
            fetch('/api/metar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ icao: fd.destIcao }) }).then(r => r.json()),
        ]);
        fd.depMetar  = dep.metar  || '';
        fd.destMetar = dest.metar || '';
        // Re-render header with METARs
        document.querySelector('.hdr-metar-dep')?.textContent  && (document.querySelector('.hdr-metar-dep').textContent  = fd.depMetar);
        document.querySelector('.hdr-metar-dest')?.textContent && (document.querySelector('.hdr-metar-dest').textContent = fd.destMetar);
    } catch (_) {}
}

function renderHeader(fd, scores) {
    const fmt = d => d ? d.toISOString().slice(11, 16) + 'Z' : '--:--Z';
    const o = fd.oooi || {};
    document.getElementById('debrief-header').innerHTML = `
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
          <span class="hdr-route">${fd.depIcao || '?'} → ${fd.destIcao || '?'}</span>
          <span class="hdr-stats">Block ${fd.blockMinutes.toFixed(0)}m · Air ${fd.airMinutes.toFixed(0)}m · ${fd.totalDistanceNm.toFixed(0)} nm</span>
        </div>
        <div class="hdr-oooi">OUT ${fmt(o.out)} OFF ${fmt(o.off)} ON ${fmt(o.on)} IN ${fmt(o.in)}</div>
        <div class="hdr-metar-dep hdr-metar">${fd.depMetar}</div>
        <div class="hdr-metar-dest hdr-metar">${fd.destMetar}</div>
        <div class="hdr-actions">
          <button class="hdr-btn" id="ai-review-btn">AI REVIEW</button>
          <button class="hdr-btn" id="export-gpx-btn">EXPORT GPX</button>
          <button class="hdr-btn" id="notes-btn">NOTES</button>
          <button class="hdr-btn" id="back-btn">← BACK</button>
        </div>
    `;
    document.getElementById('back-btn').addEventListener('click', () => location.reload());
    document.getElementById('notes-btn').addEventListener('click', () => openNotes(fd.filename));
    document.getElementById('export-gpx-btn').addEventListener('click', () => exportGPX(fd));
    document.getElementById('ai-review-btn').addEventListener('click', () => {
        document.getElementById('ai-panel').classList.remove('hidden');
        initClaudeReview(fd, scores, [], null);
    });
}

function renderScorecard(scores) {
    const { colorForScore } = window._scorer || {};
    const col = s => s >= 80 ? 'green' : s >= 60 ? 'yellow' : 'red';
    const row = (label, s) => `
        <div class="sc-category">
          <span class="sc-cat-label">${label}</span>
          <div class="sc-bar-wrap"><div class="sc-bar ${col(s.overall)}" style="width:${s.overall}%"></div></div>
          <span class="sc-cat-score">${s.overall}</span>
        </div>`;
    document.getElementById('scorecard').innerHTML = `
        <div class="sc-overall">
          <span class="sc-overall-label">Overall</span>
          <div class="sc-bar-wrap"><div class="sc-bar ${col(scores.overall)}" style="width:${scores.overall}%"></div></div>
          <span class="sc-overall-score">${scores.overall}</span>
        </div>
        ${row('Engine Mgmt', scores.engineMgmt)}
        ${row('Airmanship', scores.airmanship)}
        ${scores.approach ? row('Approach', scores.approach) : ''}
        <div class="sc-view-toggles">
          <button class="sc-toggle active" data-view="grades">GRADES</button>
          <button class="sc-toggle active" data-view="data">DATA</button>
          <button class="sc-toggle active" data-view="events">EVENTS</button>
        </div>
    `;
}

function renderEvents(events) {
    const panel = document.getElementById('event-panel');
    const fmt = s => {
        const m = Math.floor(s / 60), sec = s % 60;
        return `${String(m).padStart(2,'0')}:${String(Math.round(sec)).padStart(2,'0')}`;
    };
    panel.innerHTML = events.map(e => `
        <div class="event-row" data-tsec="${e.tSec}">
          <span class="ev-time">${fmt(e.tSec)}</span>
          <span class="ev-type ${e.level}">${e.type}</span>
          <span class="ev-detail">${e.detail}</span>
        </div>
    `).join('') || '<p style="padding:8px;color:var(--text-muted)">No events detected</p>';

    panel.querySelectorAll('.event-row').forEach(row => {
        row.addEventListener('click', () => {
            const t = parseInt(row.dataset.tsec);
            document.getElementById('scrubber').value = t;
            document.getElementById('scrubber').dispatchEvent(new Event('input'));
        });
    });
}

function wireScrubber(fd, events) {
    const scrubber = document.getElementById('scrubber');
    scrubber.max = fd.rows - 1;

    // Event ticks
    const ticks = document.getElementById('event-ticks');
    ticks.innerHTML = events.map(e => {
        const pct = (e.tSec / (fd.rows - 1)) * 100;
        const color = e.level === 'red' ? 'var(--color-danger)' :
                      e.level === 'purple' ? '#7b2d8b' : 'var(--color-caution)';
        return `<div style="position:absolute;left:${pct}%;width:2px;height:100%;background:${color};top:0"></div>`;
    }).join('');

    let playing = false, speed = 1, rafId = null, lastTime = null;
    const playBtn = document.getElementById('play-btn');

    document.querySelectorAll('.speed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            speed = parseInt(btn.dataset.speed);
        });
    });

    function tick(ts) {
        if (!playing) return;
        if (lastTime !== null) {
            const elapsed = (ts - lastTime) / 1000 * speed;
            const cur = parseInt(scrubber.value);
            const next = Math.min(fd.rows - 1, cur + Math.floor(elapsed));
            if (next !== cur) {
                scrubber.value = next;
                scrubber.dispatchEvent(new Event('input'));
            }
            if (next >= fd.rows - 1) { playing = false; playBtn.textContent = '▶'; return; }
        }
        lastTime = ts;
        rafId = requestAnimationFrame(tick);
    }

    playBtn.addEventListener('click', () => {
        playing = !playing;
        playBtn.textContent = playing ? '⏸' : '▶';
        if (playing) { lastTime = null; rafId = requestAnimationFrame(tick); }
        else if (rafId) cancelAnimationFrame(rafId);
    });

    scrubber.addEventListener('input', () => {
        const idx = parseInt(scrubber.value);
        updateTimeDisplay(fd, idx);
        window._replay?.seek(idx);
        window._charts?.seek(idx);
    });

    document.getElementById('event-list-btn').addEventListener('click', () => {
        document.getElementById('event-panel').classList.toggle('hidden');
    });
}

function updateTimeDisplay(fd, idx) {
    if (!fd.startUtc) return;
    const t = new Date(fd.startUtc.getTime() + idx * 1000);
    document.getElementById('time-display').textContent =
        t.toISOString().slice(11, 19) + 'Z';
}

function wireViewToggles(scores, events) {
    document.querySelectorAll('.sc-toggle').forEach(btn => {
        btn.addEventListener('click', () => btn.classList.toggle('active'));
    });
}

async function openNotes(filename) {
    const modal = document.getElementById('notes-modal');
    modal.classList.remove('hidden');
    const r = await fetch(`/api/notes/${encodeURIComponent(filename)}`);
    const data = await r.json();
    document.getElementById('notes-text').value = data.text || '';
    document.getElementById('notes-save').onclick = async () => {
        await fetch(`/api/notes/${encodeURIComponent(filename)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: document.getElementById('notes-text').value }),
        });
        modal.classList.add('hidden');
    };
    document.getElementById('notes-close').onclick = () => modal.classList.add('hidden');
}

async function exportGPX(fd) {
    const { toGPX } = await import('./gpx-export.js');
    const gpx = toGPX(fd, fd.filename);
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fd.filename.replace(/\.csv$/, '.gpx');
    a.click();
}

function appendTrainingLog(filename, scores, events, trafficData) {
    const entry = {
        date: new Date().toISOString().slice(0, 10),
        route: filename.replace(/\.csv$/, ''),
        scores: { overall: scores.overall, engineMgmt: scores.engineMgmt.overall,
                  airmanship: scores.airmanship.overall, approach: scores.approach?.overall ?? null },
        eventCounts: events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {}),
        trafficProximityEvents: trafficData?.proximityEvents?.length ?? 0,
        closestTrafficNm: closestApproach(trafficData?.proximityEvents || [])?.horizNm ?? null,
    };
    fetch('/api/training-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
    }).catch(() => {});  // best-effort
}

// ── Init ─────────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const preload = params.get('file');
if (preload) {
    openFlight(preload);
} else {
    loadFlightList();
}
```

- [ ] **Step 2: Add `/api/training-log` POST endpoint to server**

In `server/debrief-server.py`, add to `do_POST`:

```python
elif p == '/api/training-log':
    self._append_training_log()
```

Add method:

```python
def _append_training_log(self):
    n = int(self.headers.get('Content-Length', 0))
    line = self.rfile.read(n).decode().strip() + '\n'
    log_path = Path.home() / '.flytab-debrief' / 'training-log.jsonl'
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, 'a') as f:
        f.write(line)
    self._json({'ok': True})
```

- [ ] **Step 3: Drop a sample CSV into ~/flights and test in browser**

```bash
cp tests/fixtures/sample.csv ~/flights/20260511_KLKR-KGSP.csv
open http://localhost:8092
```

Expected: flight list shows `20260511_KLKR-KGSP.csv`, click opens debrief with header and scorecard populated.

- [ ] **Step 4: Commit**

```bash
git add js/app.js server/debrief-server.py
git commit -m "feat(app): flight list, load sequence, header, scorecard, notes, GPX export wiring"
```

---

## Task 13: replay.js — Map Replay

**Files:**
- Create: `js/replay.js`

- [ ] **Step 1: Create `js/replay.js`**

```javascript
// js/replay.js
// Leaflet is loaded globally from lib/leaflet.js

let _map, _polyline, _marker, _trafficMarkers = [], _trafficData = null;
let _fd = null, _colorChannel = 'ml', _showTraffic = true;

export function initReplay(fd, trafficData, events) {
    _fd = fd;
    _trafficData = trafficData;

    if (!_map) {
        _map = L.map('map', { zoomControl: true });
        // Primary: sectional tiles from FlyTab home server (same source as FlyTab cockpit)
        // Fallback: OSM when home server unreachable
        const sectional = L.tileLayer('http://192.168.1.77:8090/tiles/sectional/{z}/{x}/{y}.png', {
            maxZoom: 12, attribution: 'FAA Sectional',
        });
        const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap', maxZoom: 18,
        });
        sectional.addTo(_map);
        sectional.on('tileerror', () => { sectional.remove(); osm.addTo(_map); });
    } else {
        _map.eachLayer(l => { if (!(l instanceof L.TileLayer)) _map.removeLayer(l); });
    }

    _renderTrack();
    _renderMarker(0);
    _fitBounds();
    _wireColorPills();
    _wireTrafficToggle();

    window._replay = { seek };
}

function _renderTrack() {
    const pts = [];
    for (let i = 0; i < _fd.rows; i++) {
        if (_fd.lat[i] && _fd.lon[i]) pts.push([_fd.lat[i], _fd.lon[i]]);
    }
    if (_polyline) _map.removeLayer(_polyline);
    _polyline = L.polyline(pts, { color: '#0066cc', weight: 3, opacity: 0.8 }).addTo(_map);
    _colorTrack();
}

function _colorTrack() {
    if (_polyline) { _map.removeLayer(_polyline); _polyline = null; }
    const group = L.layerGroup().addTo(_map);

    // Render one polyline per phase segment (max ~10 segments per flight).
    // Per-point polylines (4000+ layers) cause severe Leaflet performance degradation.
    for (const seg of _fd.phases) {
        const pts = [];
        for (let i = seg.startIdx; i <= seg.endIdx; i++) {
            if (_fd.lat[i] && _fd.lon[i]) pts.push([_fd.lat[i], _fd.lon[i]]);
        }
        if (pts.length < 2) continue;
        // Color by the midpoint value of the segment
        const mid = Math.round((seg.startIdx + seg.endIdx) / 2);
        const color = _valueColor(_channelValue(mid));
        L.polyline(pts, { color, weight: 3, opacity: 0.85 }).addTo(group);
    }
    _polyline = group;
}

function _channelValue(i) {
    if (_colorChannel === 'ml')    return _fd.mlScore[i];
    if (_colorChannel === 'cht')   return Math.max(...[0,1,2,3].map(c => _fd.cht[c][i])) / 435;
    if (_colorChannel === 'alt')   return _fd.altFt[i] / 15000;
    if (_colorChannel === 'speed') return _fd.speedKts[i] / 200;
    return 0;
}

function _valueColor(v) {
    // 0=green, 0.5=yellow, 1=red interpolation
    const clamped = Math.max(0, Math.min(1, v));
    if (clamped < 0.5) {
        const t = clamped * 2;
        return `rgb(${Math.round(26 + (184-26)*t)},${Math.round(140 + (112-140)*t)},${Math.round(53 + 0*t)})`;
    }
    const t = (clamped - 0.5) * 2;
    return `rgb(${Math.round(184 + (204-184)*t)},${Math.round(112 + (34-112)*t)},${Math.round(0 + 34*t)})`;
}

function _renderMarker(idx) {
    const lat = _fd.lat[idx], lon = _fd.lon[idx];
    if (!lat || !lon) return;
    const course = _fd.course[idx] || 0;
    const icon = L.divIcon({
        className: '',
        html: `<div style="width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:20px solid #1a1a2e;transform:rotate(${course}deg);transform-origin:center bottom"></div>`,
        iconSize: [16, 20], iconAnchor: [8, 10],
    });
    if (_marker) _map.removeLayer(_marker);
    _marker = L.marker([lat, lon], { icon }).addTo(_map);
}

function _renderTraffic(idx) {
    _trafficMarkers.forEach(m => _map.removeLayer(m));
    _trafficMarkers = [];
    if (!_trafficData || !_showTraffic) return;

    const snap = _trafficData.snapshots.find(s =>
        Math.abs(s.tSec - idx) <= 5
    );
    if (!snap) return;

    const ownAlt = _fd.altFt[idx];
    snap.targets.forEach(t => {
        const diff = t.altFt - ownAlt;
        const color = Math.abs(diff) < 1000 ? '#b87000' : diff > 0 ? '#0055bb' : '#888888';
        const icon = L.divIcon({
            className: '',
            html: `<div style="width:12px;height:12px;background:${color};border-radius:50%;border:1.5px solid #fff;opacity:0.85"></div>`,
            iconSize: [12, 12], iconAnchor: [6, 6],
        });
        const m = L.marker([t.lat, t.lon], { icon })
            .bindPopup(`<b>${t.callsign || t.icao}</b><br>${t.altFt.toFixed(0)}ft · ${t.speedKts.toFixed(0)}kt · ${t.squawk}`)
            .addTo(_map);
        _trafficMarkers.push(m);
    });
}

function _fitBounds() {
    const pts = [];
    for (let i = 0; i < _fd.rows; i++)
        if (_fd.lat[i] && _fd.lon[i]) pts.push([_fd.lat[i], _fd.lon[i]]);
    if (pts.length) _map.fitBounds(pts);
}

function _wireColorPills() {
    document.querySelectorAll('.color-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-pill').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _colorChannel = btn.dataset.channel;
            _colorTrack();
        });
    });
}

function _wireTrafficToggle() {
    const btn = document.getElementById('traffic-toggle');
    btn.addEventListener('click', () => {
        _showTraffic = !_showTraffic;
        btn.textContent = _showTraffic ? 'TRAFFIC ON' : 'TRAFFIC OFF';
        seek(parseInt(document.getElementById('scrubber').value));
    });
}

export function seek(idx) {
    _renderMarker(idx);
    _renderTraffic(idx);
}
```

- [ ] **Step 2: Open browser, load sample flight, verify map renders**

```bash
open http://localhost:8092/?file=20260511_KLKR-KGSP.csv
```

Expected: Leaflet map shows a colored track, aircraft marker at position 0, map fitted to track bounds.

- [ ] **Step 3: Test scrubber moves marker**

Drag the scrubber slider. Expected: aircraft marker moves along the track.

- [ ] **Step 4: Commit**

```bash
git add js/replay.js
git commit -m "feat(replay): Leaflet map replay, color-coded track, aircraft marker, traffic markers"
```

---

## Task 14: charts.js

**Files:**
- Create: `js/charts.js`

- [ ] **Step 1: Create `js/charts.js`**

```javascript
// js/charts.js
// Chart.js loaded globally from lib/chart.umd.min.js

let _chart = null, _fd = null, _activeTab = 'altspeed';

const CHART_COLORS = {
    alt:  '#0066cc', gs: '#1a8c35', tas: '#b87000', ias: '#7b2d8b',
    egt:  ['#cc2222','#b87000','#0066cc','#1a8c35'],
    cht:  ['#cc2222','#b87000','#0066cc','#1a8c35'],
    ml:   '#7b2d8b',
    ff:   '#0066cc', gal: '#1a8c35',
};

export function initCharts(fd) {
    _fd = fd;
    document.querySelectorAll('.chart-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            _activeTab = tab.dataset.tab;
            _renderChart();
        });
    });
    _renderChart();
    window._charts = { seek };
}

function _renderChart() {
    if (_chart) { _chart.destroy(); _chart = null; }
    const canvas = document.getElementById('chart-canvas');
    const labels = Array.from({ length: _fd.rows }, (_, i) => i);

    const configs = {
        altspeed: _altSpeedConfig(labels),
        egt:      _egtConfig(labels),
        cht:      _chtConfig(labels),
        ml:       _mlConfig(labels),
        fuel:     _fuelConfig(labels),
    };
    _chart = new Chart(canvas, configs[_activeTab]);
}

function _base(labels, datasets) {
    return {
        type: 'line',
        data: { labels, datasets },
        options: {
            animation: false,
            responsive: true, maintainAspectRatio: false,
            elements: { point: { radius: 0 } },
            plugins: { legend: { labels: { boxWidth: 12, font: { size: 10 } } } },
            scales: { x: { ticks: { maxTicksLimit: 6, font: { size: 10 } } } },
        },
    };
}

function _ds(label, data, color, dash = []) {
    return { label, data, borderColor: color, backgroundColor: 'transparent',
             borderWidth: 1.5, borderDash: dash, parsing: false };
}

function _altSpeedConfig(labels) {
    const datasets = [
        _ds('Alt (ft)', Array.from(_fd.altFt), CHART_COLORS.alt),
        _ds('GS (kt)',  Array.from(_fd.speedKts), CHART_COLORS.gs),
    ];
    if (_fd.tasKts) datasets.push(_ds('TAS* (kt)', Array.from(_fd.tasKts), CHART_COLORS.tas, [4, 2]));
    if (_fd.iasKts) datasets.push(_ds('IAS* (kt)', Array.from(_fd.iasKts), CHART_COLORS.ias, [2, 2]));
    return _base(labels, datasets);
}

function _egtConfig(labels) {
    return _base(labels, [0,1,2,3].map(i =>
        _ds(`EGT${i+1}`, Array.from(_fd.egt[i]), CHART_COLORS.egt[i])
    ));
}

function _chtConfig(labels) {
    return _base(labels, [0,1,2,3].map(i =>
        _ds(`CHT${i+1}`, Array.from(_fd.cht[i]), CHART_COLORS.cht[i])
    ));
}

function _mlConfig(labels) {
    return _base(labels, [
        _ds('ML Score', Array.from(_fd.mlScore), CHART_COLORS.ml),
        _ds('Anomaly', Array.from(_fd.mlAnomaly), '#cc2222'),
    ]);
}

function _fuelConfig(labels) {
    return _base(labels, [
        _ds('Fuel Flow (GPH)', Array.from(_fd.fuelFlow), CHART_COLORS.ff),
        _ds('Gallons Rem',     Array.from(_fd.gallonsRem), CHART_COLORS.gal),
    ]);
}

export function seek(idx) {
    if (!_chart) return;
    // Draw vertical cursor line via annotation — using chart plugin if available,
    // otherwise move a CSS overlay element
    const canvas = document.getElementById('chart-canvas');
    const meta = _chart.getDatasetMeta(0);
    if (!meta?.data?.[idx]) return;
    const x = meta.data[idx].x;
    let line = document.getElementById('chart-cursor');
    if (!line) {
        line = document.createElement('div');
        line.id = 'chart-cursor';
        line.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:rgba(0,0,0,0.4);pointer-events:none;z-index:10';
        canvas.parentElement.style.position = 'relative';
        canvas.parentElement.appendChild(line);
    }
    line.style.left = x + 'px';
}
```

- [ ] **Step 2: Open browser, verify all 5 chart tabs render**

```bash
open http://localhost:8092/?file=20260511_KLKR-KGSP.csv
```

Click each chart tab. Expected: charts render for Alt/Speed, EGT, CHT, ML, Fuel. Scrubbing moves cursor line.

- [ ] **Step 3: Commit**

```bash
git add js/charts.js
git commit -m "feat(charts): 5 tabbed Chart.js panels with scrubber cursor sync"
```

---

## Task 15: claude-review.js

**Files:**
- Create: `js/claude-review.js`

- [ ] **Step 1: Create `js/claude-review.js`**

```javascript
// js/claude-review.js
import { closestApproach } from './traffic-parser.js';

export function initClaudeReview(fd, scores, events, trafficData) {
    const panel = document.getElementById('ai-panel');
    if (!panel) return;

    // Check for cached review
    fetch(`/api/review/${encodeURIComponent(fd.filename)}`).then(r => r.json()).then(cached => {
        if (cached?.narrative) {
            _renderNarrative(panel, cached.narrative, fd.filename, fd, scores, events, trafficData);
        } else {
            panel.innerHTML = `
                <p class="ai-loading">AI review not yet generated.</p>
                <button id="ai-generate-btn" class="hdr-btn" style="margin-top:8px">GENERATE REVIEW</button>
            `;
            document.getElementById('ai-generate-btn')?.addEventListener('click', () =>
                _generateReview(fd, scores, events, trafficData, panel)
            );
        }
    }).catch(() => {
        panel.innerHTML = '<p class="ai-loading">Could not load review.</p>';
    });
}

async function _generateReview(fd, scores, events, trafficData, panel) {
    panel.innerHTML = '<p class="ai-loading">Generating review… (15-30 seconds)</p>';
    const payload = _buildPayload(fd, scores, events, trafficData);
    try {
        const r = await fetch('/api/claude', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload }),
        });
        const data = await r.json();
        if (data.error) throw new Error(data.error);
        // Cache it
        await fetch(`/api/review/${encodeURIComponent(fd.filename)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ narrative: data.narrative }),
        });
        _renderNarrative(panel, data.narrative, fd.filename, fd, scores, events, trafficData);
    } catch (err) {
        panel.innerHTML = `<p style="color:var(--color-danger)">Review failed: ${err.message}</p>`;
    }
}

function _renderNarrative(panel, narrative, filename, fd, scores, events, trafficData) {
    panel.innerHTML = `
        <div style="line-height:1.6;white-space:pre-wrap">${narrative}</div>
        <button id="ai-refresh-btn" class="hdr-btn" style="margin-top:12px;font-size:0.75rem">REFRESH AI REVIEW</button>
    `;
    document.getElementById('ai-refresh-btn')?.addEventListener('click', async () => {
        await fetch(`/api/review/${encodeURIComponent(filename)}`, { method: 'PUT',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ narrative: null }) });
        _generateReview(fd, scores, events, trafficData, panel);
    });
}

function _buildPayload(fd, scores, events, trafficData) {
    const fmt = d => d ? d.toISOString().slice(11, 16) + 'Z' : '--:--Z';
    const o = fd.oooi || {};
    const closest = closestApproach(trafficData?.proximityEvents || []);

    const phaseStats = {};
    for (const phase of fd.phases) {
        const idxs = [];
        for (let i = phase.startIdx; i <= phase.endIdx; i++) idxs.push(i);
        if (!idxs.length) continue;
        const avgOf = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
        phaseStats[phase.name] = {
            durationMin: Math.round(idxs.length / 60),
            avgCht: Math.round(avgOf(idxs.map(i => Math.max(...[0,1,2,3].map(c => fd.cht[c][i]))))),
            avgEgt: Math.round(avgOf(idxs.map(i => Math.max(...[0,1,2,3].map(c => fd.egt[c][i]))))),
            avgFuelFlow: parseFloat(avgOf(idxs.map(i => fd.fuelFlow[i])).toFixed(1)),
        };
    }

    return {
        flight:   `${fd.depIcao || '?'}→${fd.destIcao || '?'}`,
        date:     new Date().toISOString().slice(0, 10),
        aircraft: 'RV-9A N194JT, Lycoming O-360 A1A',
        oooi:     { outZ: fmt(o.out), offZ: fmt(o.off), onZ: fmt(o.on), inZ: fmt(o.in) },
        duration: { blockMin: Math.round(fd.blockMinutes), airMin: Math.round(fd.airMinutes),
                    distNm: Math.round(fd.totalDistanceNm) },
        conditions: { depMetar: fd.depMetar, destMetar: fd.destMetar,
                      avgHeadwindKt: Math.round(fd.avgHeadwindKt || 0),
                      avgTasKt: Math.round(fd.avgTas || 0), avgIasKt: Math.round(fd.avgIas || 0) },
        scores:   { overall: scores.overall, engineMgmt: scores.engineMgmt.overall,
                    airmanship: scores.airmanship.overall, approach: scores.approach?.overall ?? null },
        events:   events.slice(0, 20).map(e => ({ timeMin: Math.round(e.tSec / 60), type: e.type, detail: e.detail })),
        phaseStats,
        dmmsViolations:  events.filter(e => e.type === 'DMMS_VIOLATION').length,
        redBoxSeconds:   events.filter(e => e.type === 'RED_BOX').length,
        carbIceSeconds:  events.filter(e => e.type === 'CARB_ICE_RISK').length,
        closestTraffic:  closest ? { callsign: closest.callsign, horizNm: parseFloat(closest.horizNm.toFixed(1)),
                                     vertFt: closest.vertFt, timeMin: Math.round(closest.tSec / 60) } : null,
    };
}
```

- [ ] **Step 2: Set ANTHROPIC_API_KEY and test AI review**

```bash
export ANTHROPIC_API_KEY=your_key_here
# Restart server
pkill -f debrief-server.py; bash start-debrief.sh &
open http://localhost:8092/?file=20260511_KLKR-KGSP.csv
```

Click `AI REVIEW` → `GENERATE REVIEW`. Expected: 3-5 paragraph narrative appears within 30 seconds, then cached on subsequent opens.

- [ ] **Step 3: Commit**

```bash
git add js/claude-review.js
git commit -m "feat(ai-review): Claude API payload builder, generate/cache/refresh panel"
```

---

## Task 16: Full Integration Test

- [ ] **Step 1: Run complete unit test suite**

```bash
npm test
```

Expected: all tests pass (csv-parser, oooi, traffic-parser, flight-physics, scorer, event-detector, gpx-export).

- [ ] **Step 2: Run Python server tests**

```bash
pytest tests/test_server.py -v
```

Expected: all 10 pass.

- [ ] **Step 3: End-to-end browser test with sample CSV**

```bash
cp tests/fixtures/sample.csv ~/flights/20260511_KLKR-KGSP.csv
bash start-debrief.sh &
open http://localhost:8092
```

Walk through:
- [ ] Flight list shows the sample flight
- [ ] Click opens debrief with header, scorecard, map, charts
- [ ] Scrubber moves aircraft marker and chart cursor
- [ ] Play button animates replay
- [ ] All 5 chart tabs render
- [ ] EVENTS button shows event panel (no events expected for clean sample)
- [ ] EXPORT GPX downloads a `.gpx` file
- [ ] NOTES: type text, save, reopen — text persists

- [ ] **Step 4: Test with a real flight CSV**

Copy an actual FlyTab recording from `~/flights/` (if SFTP uploads exist) and open it. Verify scoring, events, and OOOI times look reasonable for a real flight.

- [ ] **Step 5: Test Tailscale access**

```bash
curl http://<tailscale-ip>:8092/api/health
```

Expected: `{"ok": true}`

- [ ] **Step 6: Tag release and commit**

```bash
git add -A
git commit -m "feat: flytab-debrief core complete — server, parser, scorer, events, UI, AI review"
git tag v1.0.0
```

---

## Notes on FlyTab Aircraft Config

`loadThresholds()` in `app.js` tries to fetch `aircraft-config.json` from the FlyTab home server at `192.168.1.77:8090`. If unreachable (away from home WiFi, home server not running), it falls back to hard-coded RV-9A N194JT defaults. Thresholds that matter most:

| Key | Default | Source |
|-----|---------|--------|
| `chtCaution` | 380°F | cockpit-config.json |
| `chtDanger`  | 435°F | cockpit-config.json |
| `vs1Kias`    | 50 kt | aircraft-config.json |
| `vnoKias`    | 165 kt | aircraft-config.json |
| `vneKias`    | 202 kt | aircraft-config.json |
| `vrefKias`   | 65 kt  | aircraft-config.json |
| `typicalSfc` | 0.42   | aircraft-config.json |

Update these defaults in `loadThresholds()` if the aircraft config changes.
