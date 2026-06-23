#!/usr/bin/env python3
"""flytab-debrief server — port 8092, 0.0.0.0"""
import json, mimetypes, os, re, urllib.parse, urllib.request
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None

FLIGHTS_DIR = Path(os.environ.get('FLIGHTS_DIR', Path.home() / 'flights'))
PORT = int(os.environ.get('DEBRIEF_PORT', 8092))
STATIC_DIR = Path(__file__).parent.parent

# Only allow CORS for local origins: localhost, home LAN (192.168.*), Tailscale (100.*)
_ALLOWED_ORIGIN = re.compile(
    r'^https?://(localhost|127\.0\.0\.1'
    r'|192\.168\.\d{1,3}\.\d{1,3}'
    r'|100\.\d{1,3}\.\d{1,3}\.\d{1,3})'
    r'(:\d+)?$'
)


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
        elif p.startswith('/api/phases/'):
            self._get_phases(urllib.parse.unquote(p[len('/api/phases/'):]))
        else:
            self._static(p)

    def do_PUT(self):
        p = self.path
        if p.startswith('/api/notes/'):
            self._put_notes(p[len('/api/notes/'):])
        elif p.startswith('/api/review/'):
            self._put_review(p[len('/api/review/'):])
        elif p.startswith('/api/phases/'):
            self._put_phases(urllib.parse.unquote(p[len('/api/phases/'):]))
        else:
            self._err(404)

    def do_POST(self):
        p = self.path
        if p == '/api/winds':   self._proxy_winds()
        elif p == '/api/metar': self._proxy_metar()
        elif p == '/api/terrain': self._proxy_terrain()
        elif p == '/api/claude': self._proxy_claude()
        elif p == '/api/training-log': self._append_training_log()
        else: self._err(404)

    # ── helpers ──────────────────────────────────────────────────────────────

    def _cors(self):
        origin = self.headers.get('Origin', '')
        if _ALLOWED_ORIGIN.match(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
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

    def _find_traffic_file(self, stem):
        """Return Path to traffic ndjson for a CSV stem, or None.
        Tries exact match first, then falls back to any traffic file
        sharing the same YYYYMMDD date prefix (handles the case where
        FlyTab renamed the CSV to a route name but the traffic rename
        failed, leaving the original time-based name on disk).
        """
        exact = FLIGHTS_DIR / (stem + '_traffic.ndjson')
        if exact.exists():
            return exact
        date_prefix = stem[:8]
        if len(date_prefix) == 8 and date_prefix.isdigit():
            matches = sorted(FLIGHTS_DIR.glob(f'{date_prefix}_*_traffic.ndjson'))
            if matches:
                return matches[0]
        return None

    def _list_flights(self):
        FLIGHTS_DIR.mkdir(parents=True, exist_ok=True)
        files = sorted(FLIGHTS_DIR.glob('*.csv'), reverse=True)
        result = [{'name': f.name,
                   'hasTraffic': self._find_traffic_file(f.stem) is not None,
                   'hasWeather': (FLIGHTS_DIR / (f.stem + '_weather.ndjson')).exists()}
                  for f in files]
        self._json(result)

    def _serve_flight(self, name):
        if not self._safe_name(name): return self._err(404)
        path = FLIGHTS_DIR / name
        if not path.exists():
            # Traffic file fallback: if the exact name isn't found, look for a
            # same-date match (handles CSV rename succeeding when traffic rename failed)
            if name.endswith('_traffic.ndjson'):
                stem = name[:-len('_traffic.ndjson')]
                found = self._find_traffic_file(stem)
                if found:
                    path = found
                else:
                    return self._err(404)
            else:
                return self._err(404)
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

    def _get_phases(self, name):
        if not self._safe_name(name):
            return self._err(404)
        path = FLIGHTS_DIR / (name + '.phases.json')
        if path.exists():
            self._json({'segments': json.loads(path.read_text())})
        else:
            self._json({'segments': None})

    def _put_phases(self, name):
        if not self._safe_name(name):
            return self._err(404)
        n = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(n))
        path = FLIGHTS_DIR / (name + '.phases.json')
        path.write_text(json.dumps(body.get('segments', []), indent=2))
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
        utc  = body.get('utc', '')   # ISO8601 flight event time (Off or On)
        if not re.fullmatch(r'[A-Z0-9]{3,4}', icao):
            return self._json({'error': 'invalid icao'}, 400)

        # Compute how many hours back we need to reach the flight time
        flight_dt = None
        hours_back = 3
        if utc:
            try:
                flight_dt = datetime.fromisoformat(utc.replace('Z', '+00:00'))
                delta_h = (datetime.now(timezone.utc) - flight_dt).total_seconds() / 3600
                hours_back = max(3, int(delta_h) + 3)
                hours_back = min(hours_back, 168)   # AWC cap: 7 days
            except ValueError:
                pass

        # JSON format gives us obsTime for closest-match selection
        url = (f'https://aviationweather.gov/api/data/metar'
               f'?ids={icao}&format=json&taf=false&hours={hours_back}')
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                records = json.loads(r.read())
            if not records:
                return self._json({'metar': ''})

            if flight_dt and len(records) > 1:
                def _obs_dt(rec):
                    try:
                        return datetime.fromtimestamp(int(rec['obsTime']), tz=timezone.utc)
                    except (KeyError, ValueError, TypeError):
                        return datetime.min.replace(tzinfo=timezone.utc)
                best = min(records, key=lambda r: abs((_obs_dt(r) - flight_dt).total_seconds()))
            else:
                best = records[0]

            self._json({'metar': best.get('rawOb', '')})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _proxy_terrain(self):
        if not requests:
            return self._json({'error': 'requests library not installed'}, 500)
        body = self._read_body()
        points = body.get('points', [])
        if not points:
            self._json({'elevations': []})
            return
        # Batch to max 100 points per request to open-elevation.com
        elevations = []
        batch_size = 100
        for i in range(0, len(points), batch_size):
            batch = points[i:i+batch_size]
            try:
                resp = requests.post(
                    'https://api.open-elevation.com/api/v1/lookup',
                    json={'locations': [{'latitude': p['lat'], 'longitude': p['lon']} for p in batch]},
                    timeout=10,
                )
                results = resp.json().get('results', [])
                elevations.extend(r.get('elevation', 0) * 3.28084 for r in results)  # m → ft
            except Exception:
                elevations.extend(0 for _ in batch)
        self._json({'elevations': elevations})

    def _proxy_claude(self):
        api_key = os.environ.get('ANTHROPIC_API_KEY', '')
        if not api_key:
            return self._json({'error': 'No API key: set ANTHROPIC_API_KEY environment variable'}, 500)
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
        auth_headers = {'x-api-key': api_key}
        req = urllib.request.Request(
            'https://api.anthropic.com/v1/messages', data=req_body,
            headers={'Content-Type': 'application/json',
                     **auth_headers,
                     'anthropic-version': '2023-06-01',
                     'anthropic-beta': 'prompt-caching-2024-07-31'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                self._json({'narrative': json.loads(r.read())['content'][0]['text']})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _append_training_log(self):
        n = int(self.headers.get('Content-Length', 0))
        line = self.rfile.read(n).decode().strip() + '\n'
        log_path = Path.home() / '.flytab-debrief' / 'training-log.jsonl'
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, 'a') as f:
            f.write(line)
        self._json({'ok': True})

    def _static(self, path):
        if path in ('', '/'):
            path = '/index.html'
        fp = STATIC_DIR / path.lstrip('/')
        # Guard: block any traversal outside the repo root
        try:
            fp.resolve().relative_to(STATIC_DIR.resolve())
        except ValueError:
            return self._err(404)
        if not fp.exists() or not fp.is_file():
            return self._err(404)
        ct, _ = mimetypes.guess_type(str(fp))
        data = fp.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ct or 'application/octet-stream')
        # No-store on static assets: this is an actively-edited personal tool, and the
        # browser was caching stale ES modules (no ETag/Last-Modified from BaseHTTPRequestHandler),
        # so JS edits silently failed to appear until a manual hard refresh.
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self._cors(); self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    FLIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    print(f'flytab-debrief on :{PORT}')
    HTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
