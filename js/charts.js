// js/charts.js

const C = {
    alt:  '#0066cc', agl: '#7b2d8b', ias: '#b87000', gs: '#1a8c35',
    bank: '#cc2222', pitch: '#444444',
    egt:  ['#cc2222','#b87000','#0066cc','#1a8c35'],
    cht:  ['#ee4444','#cc6600','#2244cc','#228833'],
    roc:  ['#ff8888','#ffaa44','#8888ff','#44aa44'],
    ff:   '#0066cc', mp: '#1a8c35', rpm: '#b87000',
    grid: '#e0e0e0',
};

let _trackChart = null, _engineChart = null;
let _fd = null, _phaseScores = null;

const TRACK_OVERLAYS = [
    { key: 'altMsl', label: 'Alt MSL', default: true },
    { key: 'gs',     label: 'GS',      default: true },
    { key: 'ias',    label: 'IAS est', default: true },
    { key: 'bank',   label: 'Bank',    default: true },
    { key: 'pitch',  label: 'Pitch',   default: false },
];

const ENGINE_OVERLAYS = [
    { key: 'egt',    label: 'EGT 1-4', default: true },
    { key: 'cht',    label: 'CHT 1-4', default: true },
    { key: 'roc',    label: 'CHT ROC', default: false },
    { key: 'ff',     label: 'Fuel Flow', default: true },
    { key: 'mp',     label: 'MP',      default: false },
    { key: 'rpm',    label: 'RPM',     default: false },
];

let _trackActive = new Set(TRACK_OVERLAYS.filter(o => o.default).map(o => o.key));
let _engineActive = new Set(ENGINE_OVERLAYS.filter(o => o.default).map(o => o.key));
let _trackZoom = null;  // {min, max} row indices, null = full flight

export function initCharts(fd, phaseScores) {
    _fd = fd;
    _phaseScores = phaseScores;
    _buildToggles('track-toggles', TRACK_OVERLAYS, _trackActive, _onTrackToggle);
    _buildToggles('engine-toggles', ENGINE_OVERLAYS, _engineActive, _onEngineToggle);
    _renderTrackChart();
    _renderEngineChart();
    window._charts = { seek: seekCharts, zoomToPhase };
}

function _buildToggles(containerId, overlays, activeSet, onChange) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;
    wrap.innerHTML = overlays.map(o => `
        <button class="toggle-pill ${activeSet.has(o.key) ? 'active' : ''}" data-key="${o.key}">${o.label}</button>
    `).join('') + `<button class="toggle-pill zoom" data-zoom="1">⟳ Full</button>`;

    wrap.querySelectorAll('.toggle-pill[data-key]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            if (activeSet.has(key)) activeSet.delete(key);
            else activeSet.add(key);
            btn.classList.toggle('active', activeSet.has(key));
            onChange();
        });
    });
    wrap.querySelector('[data-zoom]')?.addEventListener('click', () => {
        _trackZoom = null;
        _renderTrackChart();
    });
}

function _onTrackToggle() { _renderTrackChart(); }
function _onEngineToggle() { _renderEngineChart(); }

export function zoomToPhase(phaseIdx) {
    if (!_phaseScores || phaseIdx < 0 || phaseIdx >= _phaseScores.length) return;
    const ps = _phaseScores[phaseIdx];
    _trackZoom = { min: ps.startIdx, max: ps.endIdx };
    _renderTrackChart();
}

function _labels() {
    const min = _trackZoom?.min ?? 0;
    const max = _trackZoom?.max ?? (_fd.rows - 1);
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

function _slice(arr, labels) {
    return labels.map(i => arr[i]);
}

function _renderTrackChart() {
    if (_trackChart) { _trackChart.destroy(); _trackChart = null; }
    const canvas = document.getElementById('track-chart');
    if (!canvas) return;
    const labels = _labels();
    const datasets = [];

    if (_trackActive.has('altMsl')) datasets.push({
        label: 'Alt MSL (ft)', data: _slice(_fd.altFt, labels),
        borderColor: C.alt, backgroundColor: 'transparent', borderWidth: 1.5,
        pointRadius: 0, yAxisID: 'yAlt',
    });
    if (_trackActive.has('gs')) datasets.push({
        label: 'GS (kt)', data: _slice(_fd.speedKts, labels),
        borderColor: C.gs, backgroundColor: 'transparent', borderWidth: 1.5,
        pointRadius: 0, yAxisID: 'ySpd',
    });
    if (_trackActive.has('ias') && _fd.iasKts) datasets.push({
        label: 'IAS est (kt)', data: _slice(_fd.iasKts, labels),
        borderColor: C.ias, backgroundColor: 'transparent', borderWidth: 1.5,
        borderDash: [4,2], pointRadius: 0, yAxisID: 'ySpd',
    });
    if (_trackActive.has('bank')) datasets.push({
        label: 'Bank (°)', data: _slice(_fd.bank, labels),
        borderColor: C.bank, backgroundColor: 'transparent', borderWidth: 1,
        borderDash: [2,2], pointRadius: 0, yAxisID: 'yAtt',
    });
    if (_trackActive.has('pitch')) datasets.push({
        label: 'Pitch (°)', data: _slice(_fd.pitch, labels),
        borderColor: C.pitch, backgroundColor: 'transparent', borderWidth: 1,
        borderDash: [2,2], pointRadius: 0, yAxisID: 'yAtt',
    });

    _trackChart = _makeChart('track-chart', labels.map(String), datasets, {
        yAlt: { position: 'left',  title: 'Alt (ft)',   color: C.alt },
        ySpd: { position: 'right', title: 'Speed (kt)', color: C.gs, noGrid: true },
        yAtt: { position: 'right', title: 'Attitude (°)', color: C.bank, noGrid: true, min: -60, max: 60 },
    });

    _renderPhaseBand();
}

function _renderEngineChart() {
    if (_engineChart) { _engineChart.destroy(); _engineChart = null; }
    const canvas = document.getElementById('engine-chart');
    if (!canvas) return;
    const n = _fd.rows;
    const labels = Array.from({ length: n }, (_, i) => String(i));
    const datasets = [];

    if (_engineActive.has('egt')) {
        [0,1,2,3].forEach(c => datasets.push({
            label: `EGT${c+1}`, data: Array.from(_fd.egt[c]),
            borderColor: C.egt[c], backgroundColor: 'transparent',
            borderWidth: 1.5, pointRadius: 0, yAxisID: 'yTemp',
        }));
    }
    if (_engineActive.has('cht')) {
        [0,1,2,3].forEach(c => datasets.push({
            label: `CHT${c+1}`, data: Array.from(_fd.cht[c]),
            borderColor: C.cht[c], backgroundColor: 'transparent',
            borderWidth: 1.5, pointRadius: 0, yAxisID: 'yTemp',
        }));
    }
    if (_engineActive.has('roc') && _fd.chtRoc) {
        [0,1,2,3].forEach(c => datasets.push({
            label: `ROC${c+1}`, data: Array.from(_fd.chtRoc[c]),
            borderColor: C.roc[c], backgroundColor: 'transparent',
            borderWidth: 1, borderDash: [3,2], pointRadius: 0, yAxisID: 'yRoc',
        }));
    }
    if (_engineActive.has('ff')) datasets.push({
        label: 'Fuel Flow (gph)', data: Array.from(_fd.fuelFlow),
        borderColor: C.ff, backgroundColor: 'transparent',
        borderWidth: 1.5, pointRadius: 0, yAxisID: 'yFF',
    });
    if (_engineActive.has('mp') && _fd.mp) datasets.push({
        label: 'MP (inHg)', data: Array.from(_fd.mp),
        borderColor: C.mp, backgroundColor: 'transparent',
        borderWidth: 1.5, pointRadius: 0, yAxisID: 'yMp',
    });
    if (_engineActive.has('rpm')) datasets.push({
        label: 'RPM', data: Array.from(_fd.rpm),
        borderColor: C.rpm, backgroundColor: 'transparent',
        borderWidth: 1.5, pointRadius: 0, yAxisID: 'yRpm',
    });

    _engineChart = _makeChart('engine-chart', labels, datasets, {
        yTemp: { position: 'left',  title: 'Temp (°F)', color: C.egt[0] },
        yRoc:  { position: 'right', title: 'ROC (°F/min)', color: C.roc[0], noGrid: true },
        yFF:   { position: 'right', title: 'GPH', color: C.ff, noGrid: true },
        yMp:   { position: 'right', title: 'MP (inHg)', color: C.mp, noGrid: true, min: 0, max: 35 },
        yRpm:  { position: 'right', title: 'RPM', color: C.rpm, noGrid: true },
    });
}

function _makeChart(canvasId, labels, datasets, axes) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const scales = { x: { ticks: { maxTicksLimit: 6, font: { size: 9 } }, grid: { color: C.grid } } };
    for (const [id, cfg] of Object.entries(axes)) {
        scales[id] = {
            type: 'linear',
            position: cfg.position,
            title: { display: true, text: cfg.title, color: cfg.color, font: { size: 9 } },
            ticks: { font: { size: 9 } },
            grid: cfg.noGrid ? { drawOnChartArea: false } : { color: C.grid },
        };
        if (cfg.min !== undefined) scales[id].min = cfg.min;
        if (cfg.max !== undefined) scales[id].max = cfg.max;
    }
    try {
        return new Chart(canvas, {
            type: 'line',
            data: { labels, datasets },
            options: {
                animation: false, responsive: true, maintainAspectRatio: false,
                elements: { point: { radius: 0 } },
                plugins: { legend: { labels: { boxWidth: 10, font: { size: 9 } } } },
                scales,
            },
        });
    } catch (e) {
        console.error('Chart error:', e);
        return null;
    }
}

function _renderPhaseBand() {
    const band = document.getElementById('phase-band');
    if (!band || !_phaseScores) return;
    const total = _fd.rows - 1;
    band.innerHTML = _phaseScores.map(ps => {
        const left = (ps.startIdx / total * 100).toFixed(2);
        const width = ((ps.endIdx - ps.startIdx) / total * 100).toFixed(2);
        const color = ps.score >= 80 ? '#1a8c35' : ps.score >= 60 ? '#b87000' : '#cc2222';
        return `<div style="position:absolute;left:${left}%;width:${width}%;height:4px;background:${color}"></div>`;
    }).join('');
}

export function seekCharts(rowIdx) {
    _seekOnChart(_trackChart, 'track-chart', rowIdx);
    _seekOnChart(_engineChart, 'engine-chart', rowIdx);
}

function _seekOnChart(chart, canvasId, rowIdx) {
    if (!chart) return;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const meta = chart.getDatasetMeta(0);
    if (!meta?.data?.[rowIdx]) return;
    const x = meta.data[rowIdx]?.x;
    if (x == null) return;
    let line = canvas.parentElement.querySelector('.chart-cursor');
    if (!line) {
        line = document.createElement('div');
        line.className = 'chart-cursor';
        line.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:rgba(0,0,0,0.35);pointer-events:none;z-index:10';
        canvas.parentElement.style.position = 'relative';
        canvas.parentElement.appendChild(line);
    }
    line.style.left = x + 'px';
}
