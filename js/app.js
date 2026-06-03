// js/app.js
import { parseCSV }               from './csv-parser.js';
import { detectOOOI }             from './oooi.js';
import { parseTrafficNDJSON, computeProximityEvents, closestApproach } from './traffic-parser.js';
import { computeChtRoc, scoreEngineMgmt, scoreAirmanship, scoreApproach, scorePhases } from './scorer.js';
import { detectEvents }           from './event-detector.js';
import { initReplay }             from './replay.js';
import { initCharts }             from './charts.js';
import { initPhaseSidebar }       from './phase-sidebar.js';
import { initScorePanel } from './score-panel.js';
import { initEngineCluster }      from './engine-cluster.js';
import { initVspeeds, getVspeeds } from './vspeeds.js';
import { initAiReview }           from './ai-review.js';
import { applyAirspeeds }         from './flight-physics.js';
import { detectPhases }            from './phase-detector.js';

const API = '';

function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadFlightList() {
    const r = await fetch(`${API}/api/flights`);
    const flights = await r.json();
    const list = document.getElementById('flight-list');
    if (!flights.length) {
        list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px">No flights found in ~/flights</p>';
        return;
    }
    list.innerHTML = flights.map(f => `
        <div class="flight-item" data-name="${escHtml(f.name)}">
          <span class="flight-item-name">${escHtml(f.name)}</span>
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
    if (!csvResp.ok) {
        document.getElementById('hdr-route').textContent = `Error loading ${filename}`;
        return;
    }
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

    const isoWinds = Array.from({ length: fd.rows }, (_, i) => ({
        windSpeed: 0, windDir: 0,
        tempC: 15 - fd.altFt[i] * 0.002,
    }));
    applyAirspeeds(fd, isoWinds, new Float32Array(fd.rows).fill(29.92));

    // Compute CHT ROC and attach to fd before scoring
    fd.chtRoc = computeChtRoc(fd);

    // Physics-based phase detection — must run after detectOOOI
    // Populates fd.phases, fd.approaches, and fd.altRate
    detectPhases(fd);

    // Load any saved pilot corrections and overlay onto segments
    try {
        const saved = await fetch(`${API}/api/phases/${encodeURIComponent(filename)}`);
        if (saved.ok) {
            const { segments } = await saved.json();
            if (Array.isArray(segments)) {
                for (const cor of segments) {
                    const seg = fd.phases[cor.segmentIdx];
                    if (seg) seg.pilotLabel = cor.pilotLabel;
                }
            }
        }
    } catch (_) {}

    fetchMETARs(fd);

    const rawThr = await loadThresholds();

    // V-speeds: init modal, then get merged thresholds (overrides win over defaults)
    const tailMatch = filename.match(/N\d+[A-Z]+/i);
    initVspeeds(rawThr, tailMatch ? tailMatch[0] : 'default');
    const thr = getVspeeds();

    const scores = {
        engineMgmt: scoreEngineMgmt(fd, thr),
        airmanship: scoreAirmanship(fd, thr, trafficData),
        approach:   scoreApproach(fd, thr),
    };
    const scoreCats = [scores.engineMgmt.overall, scores.airmanship.overall];
    if (scores.approach) scoreCats.push(scores.approach.overall);
    scores.overall = Math.round(scoreCats.reduce((a, b) => a + b, 0) / scoreCats.length);

    const phaseScores = scorePhases(fd, thr, trafficData);
    const events = detectEvents(fd, trafficData, thr);

    // Expose for browser console debugging
    window._fd = fd;
    window._phaseScores = phaseScores;
    window._events = events;

    renderHeader(fd);

    initPhaseSidebar(
        phaseScores,
        (rowIdx, phaseIdx) => {
            const scrubber = document.getElementById('scrubber');
            scrubber.value = rowIdx;
            scrubber.dispatchEvent(new Event('input'));
            window._charts?.zoomToPhase(phaseIdx);
        },
        async (seg, segIdx) => {
            // Save all corrections to server
            const corrected = phaseScores
                .filter(p => p.pilotLabel !== null)
                .map((p, i) => ({ segmentIdx: phaseScores.indexOf(p), pilotLabel: p.pilotLabel }));
            fetch(`${API}/api/phases/${encodeURIComponent(filename)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ segments: corrected }),
            }).catch(() => {});

            // Append training entry
            const avgOf = (arr, s, e) => {
                let sum = 0, cnt = 0;
                for (let i = s; i <= e; i++) { sum += arr[i]; cnt++; }
                return cnt > 0 ? parseFloat((sum / cnt).toFixed(2)) : 0;
            };
            const s = seg.startIdx, e = seg.endIdx;
            fetch(`${API}/api/training-log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type:          'phase_correction',
                    flightDate:    fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : '',
                    flightFile:    filename,
                    segmentIdx:    segIdx,
                    startIdx:      s,
                    endIdx:        e,
                    durationSec:   seg.durationSec,
                    computedLabel: seg.name,
                    mlLabel:       seg.mlLabel,
                    pilotLabel:    seg.pilotLabel,
                    stats: {
                        avgAltFt:      Math.round(avgOf(fd.altFt, s, e)),
                        avgAltRateFpm: Math.round(avgOf(fd.altRate, s, e)),
                        avgSpeedKts:   Math.round(avgOf(fd.speedKts, s, e)),
                        avgRpm:        Math.round(avgOf(fd.rpm, s, e)),
                        avgPctPower:   Math.round(avgOf(fd.pctPower, s, e)),
                        avgFuelFlow:   parseFloat(avgOf(fd.fuelFlow, s, e).toFixed(1)),
                        maxChtF:       Math.round(Math.max(...[0,1,2,3].flatMap(c =>
                            Array.from({length: e - s + 1}, (_, k) => fd.cht[c][s + k])))),
                        avgBank:       parseFloat(Math.abs(avgOf(fd.bank, s, e)).toFixed(1)),
                    },
                }),
            }).catch(() => {});
        }
    );

    initScorePanel(fd, phaseScores, events, thr);
    initReplay(fd, trafficData, phaseScores);
    initEngineCluster(fd, thr);
    initCharts(fd, phaseScores);
    initAiReview(fd, scores, phaseScores, events, trafficData);

    wireScrubber(fd, events, phaseScores);
    wireTabSwitching();
    appendTrainingLog(filename, scores, events, trafficData, fd);
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
    const offUtc = fd.oooi?.off?.toISOString() || '';
    const onUtc  = fd.oooi?.on?.toISOString()  || '';
    try {
        const [dep, dest] = await Promise.all([
            fetch('/api/metar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ icao: fd.depIcao, utc: offUtc }) }).then(r => r.json()),
            fetch('/api/metar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ icao: fd.destIcao, utc: onUtc }) }).then(r => r.json()),
        ]);
        fd.depMetar  = dep.metar  || '';
        fd.destMetar = dest.metar || '';
    } catch (_) {}
}

function renderHeader(fd) {
    const route = `${fd.depIcao || '?'} → ${fd.destIcao || '?'}`;
    const stats = `Block ${fd.blockMinutes.toFixed(0)}m · Air ${fd.airMinutes.toFixed(0)}m · ${fd.totalDistanceNm.toFixed(0)} nm`;
    document.getElementById('hdr-route').textContent = route;
    document.getElementById('hdr-stats').textContent = stats;
    document.getElementById('back-btn').addEventListener('click', () => location.reload());
}

function wireScrubber(fd, events, phaseScores) {
    const scrubber = document.getElementById('scrubber');
    scrubber.max = fd.rows - 1;

    const ticks = document.getElementById('event-ticks');
    if (ticks) {
        ticks.innerHTML = events.map(e => {
            const pct = (e.tSec / (fd.rows - 1)) * 100;
            const color = e.level === 'red' ? '#cc2222' : e.level === 'purple' ? '#7b2d8b' : '#b87000';
            return `<div style="position:absolute;left:${pct}%;width:2px;height:100%;background:${color};top:0;opacity:0.7"></div>`;
        }).join('');
    }

    let playing = false, speed = 1, rafId = null, lastTime = null, accumulator = 0;
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
            accumulator += (ts - lastTime) / 1000 * speed;
            const advance = Math.floor(accumulator);
            if (advance > 0) {
                accumulator -= advance;
                const cur = parseInt(scrubber.value);
                const next = Math.min(fd.rows - 1, cur + advance);
                scrubber.value = next;
                scrubber.dispatchEvent(new Event('input'));
                if (next >= fd.rows - 1) { playing = false; if (playBtn) playBtn.textContent = '▶'; accumulator = 0; return; }
            }
        }
        lastTime = ts;
        rafId = requestAnimationFrame(tick);
    }

    if (playBtn) {
        playBtn.addEventListener('click', () => {
            playing = !playing;
            playBtn.textContent = playing ? '⏸' : '▶';
            if (playing) { lastTime = null; accumulator = 0; rafId = requestAnimationFrame(tick); }
            else if (rafId) cancelAnimationFrame(rafId);
        });
    }

    scrubber.addEventListener('input', () => {
        const idx = parseInt(scrubber.value);
        updateTimeDisplay(fd, idx);
        window._replay?.seek(idx);
        window._charts?.seek(idx);
        window._scorePanel?.seek(idx);
        window._phaseSidebar?.seek(idx);
        window._engineCluster?.seek(idx);
    });
}

function updateTimeDisplay(fd, idx) {
    if (!fd.startUtc) return;
    const t = new Date(fd.startUtc.getTime() + idx * 1000);
    const el = document.getElementById('time-display');
    if (el) el.textContent = t.toISOString().slice(11, 19) + 'Z';
}

function wireTabSwitching() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _switchTab(btn.dataset.tab);
        });
    });
}

function _switchTab(tab) {
    const threePanel    = document.getElementById('three-panel');
    const chartPanel    = document.getElementById('chart-panel');
    const reviewPanel   = document.getElementById('review-panel');
    const mapPanel      = document.getElementById('map-panel');
    const engineCluster = document.getElementById('engine-cluster');
    const trackChart    = document.getElementById('track-chart-wrap');
    const engineChart   = document.getElementById('engine-chart-wrap');

    threePanel?.classList.toggle('hidden', tab === 'review');
    chartPanel?.classList.toggle('hidden', tab === 'review');
    reviewPanel?.classList.toggle('hidden', tab !== 'review');

    if (tab !== 'review') {
        mapPanel?.classList.toggle('hidden', tab !== 'track');
        engineCluster?.classList.toggle('hidden', tab !== 'engine');
        trackChart?.classList.toggle('hidden', tab !== 'track');
        engineChart?.classList.toggle('hidden', tab !== 'engine');
    }

    // Invalidate Leaflet map size when switching back to track tab
    if (tab === 'track') {
        setTimeout(() => {
            const mapEl = document.getElementById('map');
            if (mapEl && mapEl._leaflet_id) {
                const map = window.L && L.Map ? undefined : undefined;
                // Trigger resize by dispatching resize event
                window.dispatchEvent(new Event('resize'));
            }
        }, 50);
    }
}

function appendTrainingLog(filename, scores, events, trafficData, fd) {
    const entry = {
        date: fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
        route: filename.replace(/\.csv$/, ''),
        scores: { overall: scores.overall, engineMgmt: scores.engineMgmt.overall,
                  airmanship: scores.airmanship.overall, approach: scores.approach?.overall ?? null },
        eventCounts: events.reduce((acc, e) => { acc[e.type] = (acc[e.type]||0)+1; return acc; }, {}),
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
if (preload) openFlight(preload);
else loadFlightList();
