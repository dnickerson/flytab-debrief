// js/engine-cluster.js

let _fd = null, _thr = null;

export function initEngineCluster(fd, thr) {
    _fd = fd;
    _thr = thr;
    const el = document.getElementById('engine-cluster');
    if (!el) return;
    el.innerHTML = `
        <div class="ec-grid" id="egt-grid"></div>
        <div class="ec-grid" id="cht-grid"></div>
        <div class="ec-strip" id="ec-strip"></div>
    `;
    seek(0);
    window._engineCluster = { seek };
}

export function seek(idx) {
    if (!_fd) return;
    const thr = _thr || {};
    const chtCaution = thr.chtCaution || 380;
    const chtDanger  = thr.chtDanger  || 435;
    const egtDanger  = thr.egtDanger  || 1650;

    const egtGrid = document.getElementById('egt-grid');
    const chtGrid = document.getElementById('cht-grid');
    const strip   = document.getElementById('ec-strip');
    if (!egtGrid || !chtGrid || !strip) return;

    const maxEgt = Math.max(...[0,1,2,3].map(c => _fd.egt[c][idx]));
    const maxCht = Math.max(...[0,1,2,3].map(c => _fd.cht[c][idx]));

    egtGrid.innerHTML = [0,1,2,3].map(c => {
        const v = _fd.egt[c][idx];
        const cls = v > egtDanger ? 'danger' : v === maxEgt && v > 1200 ? 'caution' : '';
        return `<div class="ec-tile ${cls}">
          <div class="ec-tile-label">EGT ${c+1}</div>
          <div class="ec-tile-value">${v > 0 ? v.toFixed(0) : '—'}°</div>
        </div>`;
    }).join('');

    chtGrid.innerHTML = [0,1,2,3].map(c => {
        const v   = _fd.cht[c][idx];
        const roc = _fd.chtRoc ? _fd.chtRoc[c][idx] : null;
        const rocStr = roc !== null ? `${roc >= 0 ? '+' : ''}${roc.toFixed(0)}°/min` : '';
        const rocWarn = roc !== null && _fd.pctPower[idx] > 65 && Math.abs(roc) > 50;
        const cls = v > chtDanger ? 'danger' : v > chtCaution ? 'caution' : '';
        return `<div class="ec-tile ${cls}">
          <div class="ec-tile-label">CHT ${c+1}</div>
          <div class="ec-tile-value">${v > 0 ? v.toFixed(0) : '—'}°</div>
          ${roc !== null ? `<div class="ec-tile-roc ${rocWarn ? 'warn' : ''}">${rocStr}</div>` : ''}
        </div>`;
    }).join('');

    const rpm = _fd.rpm[idx];
    const ff  = _fd.fuelFlow[idx];
    const pwr = _fd.pctPower[idx];
    const op  = _fd.opCondition[idx] || '—';
    const gal = _fd.gallonsRem[idx];
    strip.innerHTML = `
        <span><span class="label">RPM</span> ${rpm.toFixed(0)}</span>
        <span><span class="label">FF</span> ${ff.toFixed(1)} gph</span>
        <span><span class="label">PWR</span> ${pwr.toFixed(0)}%</span>
        <span><span class="label">Op</span> ${op}</span>
        <span><span class="label">Fuel rem</span> ${gal.toFixed(1)} gal</span>
    `;
}
