// js/weather-replay.js

const INTENSITY_COLORS = [
    null,       // 0 — no return
    '#00ee00',  // 1
    '#00bb00',  // 2
    '#008800',  // 3
    '#ffee00',  // 4
    '#ffcc00',  // 5
    '#ff8800',  // 6
    '#ff4400',  // 7
    '#ff0000',  // 8
    '#cc0000',  // 9
    '#990000',  // 10
    '#cc00ff',  // 11
    '#aa00dd',  // 12
    '#880099',  // 13
    '#ffffff',  // 14
    '#ffffff',  // 15
];

let _map = null;
let _data = null;   // { header, events }
let _layers = {};
let _prefs = {};

const WINDOWS = {
    nexrad: 900,          // 15 min
    metar: Infinity,      // latest per ICAO only
    pirep: 3600,          // 1 hr
    sigmet: Infinity,     // until expires_at
    airmet: Infinity,     // until expires_at
    cwa: 7200,            // 2 hrs
    winds: Infinity,      // latest per station+alt
    notam: Infinity,      // until expires_at
};

const DEFAULTS = {
    nexrad: true, metar: true, pirep: true,
    sigmet: true, airmet: true, cwa: true,
    winds: false, notam: true,
};

export function parseWeatherNDJSON(text) {
    const lines = text.trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    let header;
    try { header = JSON.parse(lines[0]); } catch (_) { return null; }
    if (header.version !== 1) return null;
    const events = {
        nexrad: [], metar: [], pirep: [], sigmet: [],
        airmet: [], cwa: [], winds: [], notam: [],
    };
    for (const line of lines.slice(1)) {
        try {
            const e = JSON.parse(line);
            if (e.type && events[e.type] !== undefined) events[e.type].push(e);
        } catch (_) {}
    }
    return { header, events };
}

export function initWeather(weatherData, map) {
    // Remove any previously added layers before reinitializing
    for (const layer of Object.values(_layers)) {
        if (_map && _map.hasLayer(layer)) _map.removeLayer(layer);
    }

    _data = weatherData;
    _map = map;

    _layers = {
        nexrad: L.layerGroup(),
        metar:  L.layerGroup(),
        pirep:  L.layerGroup(),
        sigmet: L.layerGroup(),
        airmet: L.layerGroup(),
        cwa:    L.layerGroup(),
        winds:  L.layerGroup(),
        notam:  L.layerGroup(),
    };

    _loadPrefs();
    for (const [key, layer] of Object.entries(_layers)) {
        if (_prefs[key] !== false) layer.addTo(_map);
    }
}

export function renderWeather(T) {
    if (!_data || !_map) return;

    _renderNexrad(T);
    _renderMetar(T);
    _renderPirep(T);
    _renderSigmetAirmetCwa(T);
    _renderWinds(T);
    _renderNotam(T);
}

export function setWeatherLayerVisible(key, visible) {
    if (!_layers[key]) return;
    if (visible) {
        if (!_map.hasLayer(_layers[key])) _layers[key].addTo(_map);
    } else {
        if (_map.hasLayer(_layers[key])) _map.removeLayer(_layers[key]);
    }
    _prefs[key] = visible;
    _savePrefs();
}

export function getWeatherLayerVisible(key) {
    return _prefs[key] !== false;
}

// ── NEXRAD ────────────────────────────────────────────────────────────────

function _renderNexrad(T) {
    _layers.nexrad.clearLayers();
    if (_prefs.nexrad === false || !_data.events.nexrad.length) return;

    // Collect blocks visible at time T (received within last 15 min)
    // Use a Map to keep only the latest block per cell key
    const visible = new Map();
    for (const e of _data.events.nexrad) {
        if (e.t > T) break; // events are in ascending t order — NDJSON line order preserved by parser
        if (T - e.t > WINDOWS.nexrad) continue;
        for (const b of (e.blocks || [])) {
            const key = `${b.lat},${b.lon},${b.radarType}`;
            visible.set(key, b);
        }
    }

    for (const b of visible.values()) {
        for (let i = 0; i < b.intensity.length; i++) {
            const val = b.intensity[i];
            if (!val || val < 1) continue;
            const color = INTENSITY_COLORS[Math.min(val, 15)];
            if (!color) continue;

            // Each block spans (h × w) degrees. Intensity array covers cells
            // left-to-right, top-to-bottom within the block.
            // For simplicity treat the whole block as one rectangle.
            // (Full sub-cell rendering would require knowing block dimensions.)
            const south = b.lat - b.h;
            const east  = b.lon + b.w;
            L.rectangle([[south, b.lon], [b.lat, east]], {
                color, weight: 0, fillColor: color, fillOpacity: 0.75,
                interactive: false,
            }).addTo(_layers.nexrad);
            break; // use first non-zero cell as representative for the block
        }
    }
}

// ── METAR ─────────────────────────────────────────────────────────────────

const CAT_COLORS = { VFR: '#1a8c35', MVFR: '#0055bb', IFR: '#cc2222', LIFR: '#880088' };

function _renderMetar(T) {
    _layers.metar.clearLayers();
    if (_prefs.metar === false || !_data.events.metar.length) return;

    // Latest entry per ICAO at time T
    const latest = new Map();
    for (const e of _data.events.metar) {
        if (e.t > T) continue;
        if (!latest.has(e.icao) || e.t > latest.get(e.icao).t) latest.set(e.icao, e);
    }

    // We need lat/lon — METARs don't carry coords, so skip if not resolvable.
    // fly-debrief has access to FlyTab home server for NASR; for now show popups
    // only on station markers placed at the pilot's own position (skipped for MVP).
    // TODO: resolve ICAO → lat/lon via NASR if needed.
}

// ── PIREP ─────────────────────────────────────────────────────────────────

const SEV_COLORS = ['#888', '#1a8c35', '#00cc99', '#ffcc00', '#ff8800', '#cc2222'];

function _renderPirep(T) {
    _layers.pirep.clearLayers();
    if (_prefs.pirep === false || !_data.events.pirep.length) return;

    for (const e of _data.events.pirep) {
        if (e.t > T || T - e.t > WINDOWS.pirep) continue;
        if (e.lat == null || e.lon == null) continue;
        const color = SEV_COLORS[Math.min(e.severity ?? 1, 5)];
        const icon = L.divIcon({
            className: '',
            html: `<div style="width:12px;height:12px;background:${color};transform:rotate(45deg);border:1px solid #000;opacity:0.85"></div>`,
            iconSize: [12, 12], iconAnchor: [6, 6],
        });
        const urgentBadge = e.urgent ? '<b style="color:#cc2222">UUA</b> ' : '';
        const typeLabel = e.pirepType || 'PIREP';
        const sevLabel = e.severity ? `Severity ${e.severity}/5` : '';
        const altLabel = e.altitude ? `${e.altitude.toLocaleString()}ft` : '';
        L.marker([e.lat, e.lon], { icon })
            .bindPopup(`<div style="font-family:var(--font-ui);min-width:200px">
                <b>${urgentBadge}${_esc(typeLabel).toUpperCase()}</b> ${sevLabel}<br>
                ${altLabel}<br>
                <small style="white-space:pre-wrap">${_esc(e.raw)}</small>
            </div>`)
            .addTo(_layers.pirep);
    }
}

// ── SIGMET / AIRMET / CWA ─────────────────────────────────────────────────

const ADVISORY_STYLES = {
    sigmet:  { color: '#ff2222', fillOpacity: 0.12 },
    airmet:  { color: '#ccaa00', fillOpacity: 0.12 },
    cwa:     { color: '#ff6600', fillOpacity: 0.18 },
};

function _isExpired(e, T) {
    if (!_data?.header?.t0) return false;
    if (!e.expires_at) return false;
    const expiresT = Math.floor(new Date(e.expires_at).getTime() / 1000);
    if (isNaN(expiresT)) return false;
    // Compare wall-clock expires_at against flight-relative T (both in seconds from t0)
    return (expiresT - _data.header.t0) < T;
}

function _renderSigmetAirmetCwa(T) {
    for (const key of ['sigmet', 'airmet', 'cwa']) {
        _layers[key].clearLayers();
        if (_prefs[key] === false) continue;
        const wind = WINDOWS[key];
        const style = ADVISORY_STYLES[key];
        for (const e of (_data.events[key] || [])) {
            if (e.t > T) continue;
            if (T - e.t > wind) continue;
            if (_isExpired(e, T)) continue;
            if (!e.points || e.points.length < 3) continue;
            const label = key.toUpperCase();
            const expiry = e.expires_at ? `Expires ${e.expires_at.slice(11, 16)}Z` : '';
            // points: [[lat, lon], ...] — Leaflet order, stored as-is from fisb-client.js _extractPolygonPoints
            L.polygon(e.points, { color: style.color, weight: 1.5,
                fillColor: style.color, fillOpacity: style.fillOpacity })
                .bindPopup(`<div style="font-family:var(--font-ui);max-width:320px">
                    <b>${label}</b> ${expiry}<br>
                    <small style="white-space:pre-wrap">${_esc(e.raw)}</small>
                </div>`)
                .addTo(_layers[key]);
        }
    }
}

// ── WINDS ──────────────────────────────────────────────────────────────────

function _renderWinds(T) {
    _layers.winds.clearLayers();
    if (_prefs.winds === false || !_data.events.winds.length) return;

    // Latest per station+alt at time T
    const latest = new Map();
    for (const e of _data.events.winds) {
        if (e.t > T) continue;
        const key = `${e.station}:${e.alt}`;
        if (!latest.has(key) || e.t > latest.get(key).t) latest.set(key, e);
    }

    for (const w of latest.values()) {
        if (w.lat == null || w.lon == null) continue;
        // Rotate arrow to direction of flow (wind blows FROM w.dir, so arrow points TO w.dir+180)
        const rot = ((w.dir || 0) + 180) % 360;
        const icon = L.divIcon({
            className: '',
            html: `<div style="transform:rotate(${rot}deg);font-size:1rem;line-height:1;color:#1a1a2e">↑</div>
                   <div style="font-size:0.6rem;white-space:nowrap;color:#444;text-align:center">${w.spd}kt/${Math.round((w.alt||0)/1000)}k</div>`,
            iconSize: [40, 28], iconAnchor: [20, 8],
        });
        L.marker([w.lat, w.lon], { icon })
            .bindPopup(`<b>${w.station}</b> ${(w.alt||0).toLocaleString()}ft<br>${w.dir}° @ ${w.spd}kt, ${w.temp ?? '—'}°C`)
            .addTo(_layers.winds);
    }
}

// ── NOTAM ──────────────────────────────────────────────────────────────────

function _renderNotam(T) {
    _layers.notam.clearLayers();
    if (_prefs.notam === false || !_data.events.notam.length) return;

    for (const e of _data.events.notam) {
        if (e.t > T) continue;
        if (_isExpired(e, T)) continue;
        if (e.lat == null || e.lon == null) continue;
        if (e.tfr) {
            const r = (e.radius_nm || 5) * 1852; // nm → meters
            L.circle([e.lat, e.lon], {
                radius: r, color: '#cc2222', weight: 2,
                fillColor: '#cc2222', fillOpacity: 0.08,
                dashArray: '6,4',
            })
                .bindPopup(`<b>TFR</b><br><small>${_esc((e.raw || '').slice(0, 200))}</small>`)
                .addTo(_layers.notam);
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _loadPrefs() {
    _prefs = { ...DEFAULTS };
    try {
        const saved = JSON.parse(localStorage.getItem('weatherPrefs') || '{}');
        Object.assign(_prefs, saved);
    } catch (_) {}
}

function _savePrefs() {
    try { localStorage.setItem('weatherPrefs', JSON.stringify(_prefs)); } catch (_) {}
}
