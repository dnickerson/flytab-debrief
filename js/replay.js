// js/replay.js

const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

let _map, _trackGroup, _marker, _trafficMarkers = [];
let _fd = null, _trafficData = null, _phaseScores = null;

// Traffic display prefs — loaded from localStorage
let _trafficPrefs = {
    callsign: true, altitude: true, speed: false,
    heading: false, squawk: false, altColor: true, proxRing: true,
};

export function initReplay(fd, trafficData, phaseScores) {
    _fd = fd;
    _trafficData = trafficData;
    _phaseScores = phaseScores;
    _loadTrafficPrefs();

    if (!_map) {
        _map = L.map('map', { zoomControl: true });
        window._replayMap = _map;

        const TILE_BASE = 'http://192.168.1.77:8090/tiles';
        const sectional = L.tileLayer(`${TILE_BASE}/sectional/{z}/{x}/{y}.webp`, {
            maxZoom: 12, attribution: 'FAA Sectional',
        });
        const ifrLow = L.tileLayer(`${TILE_BASE}/ifr-low/{z}/{x}/{y}.webp`, {
            maxZoom: 10, attribution: 'FAA IFR Low',
        });
        const ifrArea = L.tileLayer(`${TILE_BASE}/ifr-area/{z}/{x}/{y}.webp`, {
            minZoom: 10, maxZoom: 12, attribution: 'FAA IFR Area',
        });
        const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap', maxZoom: 18,
        });

        // Try sectional first; fall back to OSM if home server unreachable
        let homeServerOk = true;
        sectional.on('tileerror', () => {
            if (homeServerOk) { homeServerOk = false; sectional.remove(); osm.addTo(_map); }
        });
        sectional.addTo(_map);

        L.control.layers(
            { 'VFR Sectional': sectional, 'IFR Low': ifrLow, 'IFR Area': ifrArea, 'Street Map': osm },
            {},
            { position: 'bottomleft', collapsed: true }
        ).addTo(_map);
    } else {
        _map.eachLayer(l => { if (!(l instanceof L.TileLayer)) _map.removeLayer(l); });
    }

    _renderTrack();
    _renderMarker(0);
    _fitBounds();
    _wireTrafficMenu();

    window._replay = { seek };
}

function _scoreColor(score) {
    return score >= 80 ? '#1a8c35' : score >= 60 ? '#b87000' : '#cc2222';
}

function _renderTrack() {
    if (_trackGroup) { _map.removeLayer(_trackGroup); _trackGroup = null; }
    _trackGroup = L.layerGroup().addTo(_map);
    for (const ps of (_phaseScores || [])) {
        const pts = [];
        for (let i = ps.startIdx; i <= ps.endIdx; i++) {
            if (_fd.lat[i] && _fd.lon[i]) pts.push([_fd.lat[i], _fd.lon[i]]);
        }
        if (pts.length < 2) continue;
        L.polyline(pts, { color: _scoreColor(ps.score), weight: 3, opacity: 0.85 }).addTo(_trackGroup);
    }
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
    if (!_trafficData) return;

    const snap = _trafficData.snapshots.find(s => Math.abs(s.tSec - idx) <= 5);
    if (!snap) return;

    const ownAlt = _fd.altFt[idx];
    const prefs = _trafficPrefs;

    for (const t of snap.targets) {
        const diff = t.altFt - ownAlt;
        const isProx = Math.abs(diff) < 1000;
        const colorHex = (!prefs.altColor) ? '#0066cc'
            : isProx ? '#b87000'
            : diff > 0 ? '#0055bb'
            : '#888888';

        // Build label HTML
        const parts = [];
        if (prefs.callsign && (t.callsign || t.icao))
            parts.push(`<div style="font-weight:700;white-space:nowrap;font-size:0.72rem">${_esc(t.callsign || t.icao)}</div>`);
        const sub = [];
        if (prefs.altitude) sub.push(`${t.altFt.toFixed(0)}ft`);
        if (prefs.speed)    sub.push(`${t.speedKts.toFixed(0)}kt`);
        if (prefs.heading)  sub.push(`${t.heading.toFixed(0)}°`);
        if (sub.length) parts.push(`<div style="font-size:0.68rem;white-space:nowrap;color:#444">${sub.join(' · ')}</div>`);

        const pulseStyle = (prefs.proxRing && isProx)
            ? 'animation:pulse 1s infinite;'
            : '';
        const iconHtml = `
            <div style="display:flex;flex-direction:column;align-items:center;line-height:1.2">
              <div style="font-size:1rem;color:${colorHex};transform:rotate(${t.heading}deg);display:inline-block;${pulseStyle}">✈</div>
              ${parts.join('')}
            </div>`;

        const icon = L.divIcon({
            className: '', html: iconHtml,
            iconSize: [64, 52], iconAnchor: [32, 12],
        });

        let popupContent = `<b>${_esc(t.callsign || t.icao)}</b><br>${t.altFt.toFixed(0)}ft · ${t.speedKts.toFixed(0)}kt · hdg ${t.heading.toFixed(0)}°`;
        popupContent += `<br>Squawk: ${_esc(t.squawk || '—')} · ICAO: ${_esc(t.icao)}`;

        const m = L.marker([t.lat, t.lon], { icon })
            .bindPopup(popupContent)
            .addTo(_map);
        _trafficMarkers.push(m);
    }
}

function _fitBounds() {
    const pts = [];
    for (let i = 0; i < _fd.rows; i++)
        if (_fd.lat[i] && _fd.lon[i]) pts.push([_fd.lat[i], _fd.lon[i]]);
    if (pts.length) _map.fitBounds(pts);
}

function _wireTrafficMenu() {
    const menuBtn = document.getElementById('traffic-menu-btn');
    const menu    = document.getElementById('traffic-menu');
    if (!menuBtn || !menu) return;

    if (_trafficData) menuBtn.classList.remove('hidden');

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== menuBtn) menu.classList.add('hidden');
    });

    menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
        const field = cb.dataset.field;
        cb.checked = _trafficPrefs[field] !== false;
        cb.addEventListener('change', () => {
            _trafficPrefs[field] = cb.checked;
            _saveTrafficPrefs();
            seek(parseInt(document.getElementById('scrubber').value));
        });
    });
}

function _loadTrafficPrefs() {
    try {
        const saved = JSON.parse(localStorage.getItem('trafficPrefs') || '{}');
        Object.assign(_trafficPrefs, saved);
    } catch (_) {}
}

function _saveTrafficPrefs() {
    try { localStorage.setItem('trafficPrefs', JSON.stringify(_trafficPrefs)); } catch (_) {}
}

export function seek(idx) {
    _renderMarker(idx);
    _renderTraffic(idx);
}
