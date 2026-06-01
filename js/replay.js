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

    _colorTrack();
    _renderMarker(0);
    _fitBounds();
    _wireColorPills();
    _wireTrafficToggle();

    window._replay = { seek };
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
        return `rgb(${Math.round(26 + (184-26)*t)},${Math.round(140 + (112-140)*t)},${Math.round(53)})`;
    }
    const t = (clamped - 0.5) * 2;
    return `rgb(${Math.round(184 + (204-184)*t)},${Math.round(112 + (34-112)*t)},${Math.round(34*t)})`;
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

    const snap = _trafficData.snapshots.find(s => Math.abs(s.tSec - idx) <= 5);
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
