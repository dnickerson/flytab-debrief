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
