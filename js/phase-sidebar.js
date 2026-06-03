// js/phase-sidebar.js

const PHASE_ICONS = {
    ground: '■', startup: '⚡', warmup: '◌', taxi: '▷', runup: '◉',
    climb: '▶', cruise: '→', descent: '▼', approach: '↙', landing: '■',
};

const PHASE_LABELS = {
    ground: 'Ground', startup: 'Startup', warmup: 'Warmup', taxi: 'Taxi', runup: 'Runup',
    climb: 'Climb', cruise: 'Cruise', descent: 'Descent', approach: 'Approach', landing: 'Landing',
};

const REPEATABLE = new Set(['climb', 'cruise', 'descent']);

let _phaseScores = null;
let _onSeekCb = null;
let _onCorrectCb = null;
let _openCorrectionIdx = -1;

function scoreColor(s) { return s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red'; }
function scoreHex(s)   { return s >= 80 ? '#1a8c35' : s >= 60 ? '#b87000' : '#cc2222'; }
function fmtDuration(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function _numberedLabel(phaseScores, idx) {
    const name = phaseScores[idx].name;
    if (!REPEATABLE.has(name)) return PHASE_LABELS[name] || name;
    let count = 0;
    for (let i = 0; i <= idx; i++) { if (phaseScores[i].name === name) count++; }
    return `${PHASE_LABELS[name]} ${count}`;
}

function _renderSidebar(phaseScores) {
    const el = document.getElementById('phase-sidebar');
    if (!el) return;

    const disagreeCount  = phaseScores.filter(p => !p.mlAgreement && !p.pilotLabel).length;
    const confirmedCount = phaseScores.filter(p => p.pilotLabel !== null).length;

    const headerParts = ['PHASES'];
    if (disagreeCount > 0)  headerParts.push(`<span class="disagree">${disagreeCount} disagreement${disagreeCount !== 1 ? 's' : ''}</span>`);
    if (confirmedCount > 0) headerParts.push(`<span class="confirmed">${confirmedCount} confirmed</span>`);
    const header = headerParts.length > 1
        ? `<div class="ps-sidebar-header">${headerParts.join(' · ')}</div>`
        : '';

    const rows = phaseScores.map((ps, idx) => {
        const label     = _numberedLabel(phaseScores, idx);
        const effective = ps.pilotLabel ?? ps.name;

        let badge = '';
        if (ps.pilotLabel !== null) {
            const txt = ps.pilotLabel !== ps.name
                ? `✓ corrected: ${PHASE_LABELS[ps.pilotLabel] || ps.pilotLabel}`
                : '✓ confirmed';
            badge = `<div class="ps-confirmed-badge">${txt}</div>`;
        } else if (!ps.mlAgreement) {
            badge = `<div class="ps-ml-badge" data-correct="${idx}">⚠ ML: ${PHASE_LABELS[ps.mlLabel] || ps.mlLabel}</div>`;
        }

        const correction = _openCorrectionIdx === idx ? _correctionPanel(ps, idx) : '';

        return `
            <div class="ps-phase" data-idx="${idx}" data-start="${ps.startIdx}">
              <div class="ps-phase-name">
                <span class="ps-phase-icon">${PHASE_ICONS[effective] || '→'}</span>
                <span>${label}</span>
              </div>
              <div class="ps-meta">${ps.distNm.toFixed(1)} nm · ${fmtDuration(ps.durationSec)}</div>
              <div class="ps-score">
                <span class="ps-score-badge ${scoreColor(ps.score)}">${ps.score}</span>
                <div class="ps-score-bar">
                  <div class="ps-score-fill" style="width:${ps.score}%;background:${scoreHex(ps.score)}"></div>
                </div>
              </div>
              ${badge}
              ${correction}
            </div>`;
    }).join('');

    el.innerHTML = header + rows;

    el.querySelectorAll('.ps-phase').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('.ps-correction-panel')) return;
            if (e.target.dataset.correct !== undefined) {
                const clickedIdx = parseInt(e.target.dataset.correct);
                _openCorrectionIdx = _openCorrectionIdx === clickedIdx ? -1 : clickedIdx;
                _renderSidebar(_phaseScores);
                return;
            }
            _openCorrectionIdx = -1;
            const startIdx = parseInt(row.dataset.start);
            _onSeekCb?.(startIdx, parseInt(row.dataset.idx));
        });
    });

    el.querySelectorAll('.ps-confirm-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const selected = el.querySelector(`input[name="phase-label-${idx}"]:checked`);
            if (!selected) return;
            _phaseScores[idx].pilotLabel = selected.value;
            _openCorrectionIdx = -1;
            _renderSidebar(_phaseScores);
            _onCorrectCb?.(_phaseScores[idx], idx);
        });
    });

    el.querySelectorAll('.ps-cancel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _openCorrectionIdx = -1;
            _renderSidebar(_phaseScores);
        });
    });
}

function _correctionPanel(ps, idx) {
    const ALL_PHASES = ['startup','warmup','taxi','runup','climb','cruise','descent','approach','landing'];
    const current = ps.pilotLabel ?? ps.name;
    const opts = ALL_PHASES.map(p => `
        <label class="ps-label-opt">
          <input type="radio" name="phase-label-${idx}" value="${p}" ${p === current ? 'checked' : ''}>
          ${PHASE_LABELS[p]}
        </label>`).join('');
    return `
        <div class="ps-correction-panel">
          <div class="ps-correction-title">LABEL THIS SEGMENT</div>
          <div class="ps-label-grid">${opts}</div>
          <div class="ps-correction-actions">
            <button class="ps-confirm-btn" data-idx="${idx}">Confirm ✓</button>
            <button class="ps-cancel-btn">Cancel</button>
          </div>
        </div>`;
}

export function initPhaseSidebar(phaseScores, onSeekCb, onCorrectCb) {
    _phaseScores       = phaseScores;
    _onSeekCb          = onSeekCb;
    _onCorrectCb       = onCorrectCb;
    _openCorrectionIdx = -1;
    _renderSidebar(phaseScores);
    window._phaseSidebar = { seek: _seekSidebar };
}

function _seekSidebar(rowIdx) {
    if (!_phaseScores) return;
    const el = document.getElementById('phase-sidebar');
    if (!el) return;
    const active = _phaseScores.findIndex(ps => rowIdx >= ps.startIdx && rowIdx <= ps.endIdx);
    el.querySelectorAll('.ps-phase').forEach((row, i) =>
        row.classList.toggle('active', i === active));
}
