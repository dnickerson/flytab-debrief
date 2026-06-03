// js/score-panel.js

let _fd = null, _phaseScores = null, _events = null, _thr = null;

export function initScorePanel(fd, phaseScores, events, thr) {
    _fd = fd;
    _phaseScores = phaseScores;
    _events = events;
    _thr = thr;
    const el = document.getElementById('score-panel');
    if (el) el.innerHTML = '<div class="sp-header"><span class="sp-phase-name">—</span></div>';
    window._scorePanel = { seek };
}

export function seek(rowIdx) {
    const el = document.getElementById('score-panel');
    if (!el || !_fd) return;

    const phase = _phaseScores?.find(ps => rowIdx >= ps.startIdx && rowIdx <= ps.endIdx);
    const phaseName = phase?.name || 'ground';
    const phaseScore = phase?.score ?? 0;

    const zuluTime = _fd.startUtc
        ? new Date(_fd.startUtc.getTime() + rowIdx * 1000).toISOString().slice(11, 19) + 'Z'
        : '--:--:--Z';

    const thr = _thr || {};
    const chtCaution = thr.chtCaution || 380;
    const chtDanger  = thr.chtDanger  || 435;
    const vno = thr.vnoKias || 165;
    const vne = thr.vneKias || 202;

    // Airmanship parameters
    const bank    = _fd.bank[rowIdx] ?? 0;
    const ias     = _fd.iasKts?.[rowIdx] ?? null;
    const altStd  = _altStdDevNear(rowIdx, 30);

    const bankStatus  = Math.abs(bank) > 45 ? 'fail' : Math.abs(bank) > 30 ? 'warn' : 'pass';
    const iasStatus   = ias !== null ? (ias > vne - 10 ? 'fail' : ias > vno ? 'warn' : 'pass') : null;
    const altStatus   = altStd > 300 ? 'warn' : 'pass';

    // Engine parameters
    const maxCht  = Math.max(_fd.cht[0][rowIdx], _fd.cht[1][rowIdx], _fd.cht[2][rowIdx], _fd.cht[3][rowIdx]);
    const hotCyl  = [0,1,2,3].reduce((best, c) => _fd.cht[c][rowIdx] > _fd.cht[best][rowIdx] ? c : best, 0);
    const chtStatus = maxCht > chtDanger ? 'fail' : maxCht > chtCaution ? 'warn' : 'pass';

    const maxRoc  = _fd.chtRoc
        ? Math.max(...[0,1,2,3].map(c => Math.abs(_fd.chtRoc[c][rowIdx])))
        : 0;
    const rocActive = _fd.pctPower[rowIdx] > 65;
    const rocStatus = (rocActive && maxRoc > 50) ? 'warn' : 'pass';

    const egtSpread = _egtSpread(rowIdx);
    const egtStatus = egtSpread > 100 ? 'fail' : egtSpread > 50 ? 'warn' : 'pass';

    const opCond   = _fd.opCondition[rowIdx] || '';
    const mixStatus = opCond ? 'pass' : (phaseName === 'cruise' ? 'warn' : 'pass');

    const oilTemp   = _fd.oilTemp[rowIdx];
    const oilMin    = thr.oilTempMin || 100;
    const oilMax    = thr.oilTempMax || 245;
    const oilStatus = oilTemp > 0 ? (oilTemp > oilMax ? 'fail' : oilTemp < oilMin ? 'warn' : 'pass') : 'pass';

    // Approach parameters
    const isApproach = phaseName === 'approach' || phaseName === 'landing';
    const sinkFpm = rowIdx > 0 ? ((_fd.altFt[rowIdx - 1] - _fd.altFt[rowIdx]) * 60) : 0;
    const sinkStatus = isApproach ? (sinkFpm > 1000 ? 'fail' : sinkFpm > 750 ? 'warn' : 'pass') : null;

    // Nearby events (±30s)
    const nearby = _events
        ? _events.filter(e => Math.abs(e.tSec - rowIdx) <= 30).slice(0, 4)
        : [];

    const scoreColor = phaseScore >= 80 ? 'var(--color-success)' : phaseScore >= 60 ? 'var(--color-caution)' : 'var(--color-danger)';
    const phaseLabel = { ground:'Ground',climb:'Climb',cruise:'Cruise',descent:'Descent',approach:'Approach',landing:'Landing' }[phaseName] || phaseName;

    el.innerHTML = `
        <div class="sp-header">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span class="sp-phase-name">${phaseLabel.toUpperCase()}</span>
            <span class="sp-score-val" style="color:${scoreColor}">${phaseScore}</span>
          </div>
          <div class="sp-time">${zuluTime}</div>
        </div>

        <div class="sp-section-title">AIRMANSHIP</div>
        ${_row('Bank', `${Math.abs(bank).toFixed(0)}°`, bankStatus, bankStatus !== 'pass' ? '>30°' : '')}
        ${ias !== null ? _row('IAS', `${ias.toFixed(0)} kt`, iasStatus, iasStatus !== 'pass' ? `Vno ${vno}` : '') : ''}
        ${_row('Ground speed', `${(_fd.speedKts[rowIdx] ?? 0).toFixed(0)} kt`, 'pass', '')}
        ${_fd.altRate && Math.abs(_fd.altRate[rowIdx]) >= 50 ? (
            _fd.altRate[rowIdx] > 0
                ? _row('Rate of climb', `+${_fd.altRate[rowIdx].toFixed(0)} fpm`, 'pass', '')
                : _row('Rate of descent', `${_fd.altRate[rowIdx].toFixed(0)} fpm`, 'pass', '')
        ) : ''}
        ${_row('Alt stability', `±${altStd.toFixed(0)} ft`, altStatus, '')}

        <div class="sp-section-title">ENGINE</div>
        ${_row(`CHT${hotCyl+1}`, `${maxCht.toFixed(0)}°F`, chtStatus, chtStatus !== 'pass' ? `>${chtCaution}` : '')}
        ${_fd.chtRoc ? _row('CHT ROC', `${maxRoc.toFixed(0)}°F/min`, rocStatus, rocActive && rocStatus !== 'pass' ? '>50°/min' : '') : ''}
        ${_row('EGT spread', `${egtSpread.toFixed(0)}°F`, egtStatus, egtStatus !== 'pass' ? '>50°F' : '')}
        ${_row('Mixture', opCond || '—', mixStatus, '')}
        ${oilTemp > 0 ? _row('Oil temp', `${oilTemp.toFixed(0)}°F`, oilStatus, '') : ''}

        ${isApproach ? `
        <div class="sp-section-title">APPROACH</div>
        ${sinkStatus ? _row('Sink rate', `${sinkFpm.toFixed(0)} fpm`, sinkStatus, sinkStatus !== 'pass' ? '<1000 fpm' : '') : ''}
        ${ias !== null ? _row('IAS vs Vref', `${(ias - (thr.vrefKias||65)).toFixed(0)} kt`, Math.abs(ias-(thr.vrefKias||65)) > 10 ? 'warn':'pass', '') : ''}
        ` : `<div class="sp-na" style="padding:6px 0">Approach: n/a</div>`}

        ${nearby.length ? `
        <div class="sp-events-title">EVENTS ±30s</div>
        ${nearby.map(e => `
          <div class="sp-event-row">
            <span class="sp-event-time">${_fmtSec(e.tSec)}</span>
            <span class="sp-event-type ${e.level}">${e.type}</span>
          </div>
        `).join('')}
        ` : ''}
    `;
}

function _row(label, val, status, thr) {
    const icon = status === 'fail' ? '✗' : status === 'warn' ? '⚠' : '✓';
    return `<div class="sp-row ${status}">
      <span class="sp-icon">${icon}</span>
      <span class="sp-label">${label}</span>
      <span class="sp-val">${val}</span>
      ${thr ? `<span class="sp-thr">${thr}</span>` : ''}
    </div>`;
}

function _egtSpread(idx) {
    const vals = [0,1,2,3].map(c => _fd.egt[c][idx]).filter(v => v > 0);
    if (vals.length < 2) return 0;
    return Math.max(...vals) - Math.min(...vals);
}

function _altStdDevNear(idx, halfWindow) {
    const start = Math.max(0, idx - halfWindow);
    const end   = Math.min(_fd.rows - 1, idx + halfWindow);
    const vals  = [];
    for (let i = start; i <= end; i++) vals.push(_fd.altFt[i]);
    if (vals.length < 2) return 0;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
}

function _fmtSec(s) {
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
