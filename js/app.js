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
    document.getElementById('flight-selector').classList.add('hidden');
    document.getElementById('debrief-root').classList.remove('hidden');

    const csvResp = await fetch(`${API}/api/flights/${encodeURIComponent(filename)}`);
    const csvText = await csvResp.text();
    const fd = parseCSV(csvText);
    fd.filename = filename;

    const m = filename.match(/\d{8}_([A-Z0-9]{3,4})-([A-Z0-9]{3,4})/);
    if (m) { fd.depIcao = m[1]; fd.destIcao = m[2]; }

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

    fd.oooi = detectOOOI(fd);
    fd.blockMinutes = fd.oooi.blockMinutes;
    fd.airMinutes   = fd.oooi.airMinutes;

    fetchMETARs(fd);

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

    const events = detectEvents(fd, trafficData, thr);

    renderHeader(fd, scores);

    initReplay(fd, trafficData, events);
    initCharts(fd);
    renderScorecard(scores);
    renderEvents(events);
    initClaudeReview(fd, scores, events, trafficData);

    const trafficToggle = document.getElementById('traffic-toggle');
    if (trafficData) trafficToggle.classList.remove('hidden');

    wireScrubber(fd, events);
    wireViewToggles(scores, events);
    appendTrainingLog(filename, scores, events, trafficData);
}

async function loadThresholds() {
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
        document.querySelector('.hdr-metar-dep') &&
            (document.querySelector('.hdr-metar-dep').textContent = fd.depMetar);
        document.querySelector('.hdr-metar-dest') &&
            (document.querySelector('.hdr-metar-dest').textContent = fd.destMetar);
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
    });
}

function renderScorecard(scores) {
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
    }).catch(() => {});
}

// ── Init ──────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const preload = params.get('file');
if (preload) {
    openFlight(preload);
} else {
    loadFlightList();
}
