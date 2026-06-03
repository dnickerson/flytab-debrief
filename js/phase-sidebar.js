// js/phase-sidebar.js

const PHASE_ICONS = {
    ground: '■', climb: '▶', cruise: '→', descent: '▼',
    approach: '↙', landing: '→',
};

const PHASE_LABELS = {
    ground: 'Ground', climb: 'Climb', cruise: 'Cruise', descent: 'Descent',
    approach: 'Approach', landing: 'Landing',
};

function scoreColor(s) {
    return s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red';
}

function scoreHex(s) {
    return s >= 80 ? '#1a8c35' : s >= 60 ? '#b87000' : '#cc2222';
}

function fmtDuration(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function initPhaseSidebar(phaseScores, onSeekCb) {
    const el = document.getElementById('phase-sidebar');
    if (!el) return;

    el.innerHTML = phaseScores.map((ps, idx) => `
        <div class="ps-phase" data-idx="${idx}" data-start="${ps.startIdx}">
          <div class="ps-phase-name">
            <span class="ps-phase-icon">${PHASE_ICONS[ps.name] || '→'}</span>
            <span>${PHASE_LABELS[ps.name] || ps.name}</span>
          </div>
          <div class="ps-meta">${ps.distNm.toFixed(1)} nm · ${fmtDuration(ps.durationSec)}</div>
          <div class="ps-score">
            <span class="ps-score-badge ${scoreColor(ps.score)}">${ps.score}</span>
            <div class="ps-score-bar">
              <div class="ps-score-fill" style="width:${ps.score}%;background:${scoreHex(ps.score)}"></div>
            </div>
          </div>
        </div>
    `).join('');

    el.querySelectorAll('.ps-phase').forEach(row => {
        row.addEventListener('click', () => {
            const startIdx = parseInt(row.dataset.start);
            onSeekCb(startIdx, parseInt(row.dataset.idx));
        });
    });

    window._phaseSidebar = { seek: seekSidebar.bind(null, phaseScores) };
}

function seekSidebar(phaseScores, rowIdx) {
    const el = document.getElementById('phase-sidebar');
    if (!el) return;
    const activePhaseIdx = phaseScores.findIndex(
        ps => rowIdx >= ps.startIdx && rowIdx <= ps.endIdx
    );
    el.querySelectorAll('.ps-phase').forEach((row, i) => {
        row.classList.toggle('active', i === activePhaseIdx);
    });
}
