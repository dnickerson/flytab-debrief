#!/usr/bin/env python3
"""flytab-debrief server — port 8092, 0.0.0.0"""
import json, mimetypes, os, re, urllib.request
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
        elif p == '/api/training-log': self._append_training_log()
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
        if not re.fullmatch(r'[A-Z0-9]{3,4}', icao):
            return self._json({'error': 'invalid icao'}, 400)
        url = f'https://aviationweather.gov/api/data/metar?ids={icao}&format=raw&taf=false'
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                self._json({'metar': r.read().decode().strip()})
        except Exception as e:
            self._json({'error': str(e)}, 500)

    def _proxy_claude(self):
        api_key = os.environ.get('ANTHROPIC_API_KEY', '')
        if not api_key:
            # Fall back to Claude Code's OAuth token when on the home server
            creds = Path.home() / '.claude' / '.credentials.json'
            if creds.exists():
                try:
                    api_key = json.loads(creds.read_text())['claudeAiOauth']['accessToken']
                except (KeyError, json.JSONDecodeError):
                    pass
        if not api_key:
            return self._json({'error': 'No API key: set ANTHROPIC_API_KEY or log in to Claude Code'}, 500)
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
        self._cors(); self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


if __name__ == '__main__':
    FLIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    print(f'flytab-debrief on :{PORT}')
    HTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
