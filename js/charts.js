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
