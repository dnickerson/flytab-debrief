// js/phase-sidebar.js

const PHASE_ICONS = {
    ground: '■', startup: '⚡', warmup: '◌', taxi: '▷', runup: '◉',
    climb: '▶', cruise: '→', descent: '▼', approach: '↙', landing: '■',
};

const PHASE_LABELS = {
    ground: 'Ground', startup: 'Startup', warmup: 'Warmup', taxi: 'Taxi', runup: 'Runup',
    climb: 'Climb', cruise: 'Cruise', descent: 'Descent', approach: 'Approach', landing: 'Landing',
};

// Ground sub-phases that are deduplicated within each ground block.
const GROUND_SUBS = new Set(['ground', 'startup', 'warmup', 'taxi', 'runup']);
// Flight phases that repeat in-flight and are numbered.
const REPEATABLE  = new Set(['climb', 'cruise', 'descent']);

let _phaseScores = null;
let _onSeekCb    = null;
let _onCorrectCb = null;
let _openCorrectionIdx = -1;

function scoreColor(s) { return s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red'; }
function scoreHex(s)   { return s >= 80 ? '#1a8c35' : s >= 60 ? '#b87000' : '#cc2222'; }
function fmtDuration(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Build the display-level phase list from raw phaseScores.
//
// Canonical output sequence:
//   startup → warmup → taxi → runup          (pre-takeoff, one row per type)
//   climb / cruise / descent / approach       (in-flight, numbered when repeated)
//   landing → taxi                            (post-landing, one row per type)
//
// Ground sub-phases within each block are deduplicated by name: the first
// occurrence navigates to its startIdx; subsequent occurrences accumulate
// into the same display row (duration and distance sum). Underlying
// phaseScores data is NOT mutated — this is display-only.
function _buildDisplayList(phaseScores) {
    const FLIGHT = new Set(['climb', 'cruise', 'descent', 'approach']);

    // Partition into pre-takeoff / in-flight / post-landing blocks
    let firstFlight = phaseScores.findIndex(p => FLIGHT.has(p.name));
    let lastFlight  = -1;
    for (let i = phaseScores.length - 1; i >= 0; i--) {
        if (FLIGHT.has(phaseScores[i].name)) { lastFlight = i; break; }
    }

    const display = [];

    // ── Pre-takeoff ground block ────────────────────────────────────────
    // Collect all ground sub-phase segments, aggregate by type, then emit
    // in canonical order regardless of when each type first occurred.
    const PRE_ORDER = ['startup', 'warmup', 'taxi', 'runup', 'ground'];
    const preEnd = firstFlight === -1 ? phaseScores.length : firstFlight;
    const seenPre = new Map(); // name → display entry
    for (let i = 0; i < preEnd; i++) {
        const ps = phaseScores[i];
        if (!GROUND_SUBS.has(ps.name)) continue;
        if (!seenPre.has(ps.name)) {
            seenPre.set(ps.name, {
                name: ps.name, startIdx: ps.startIdx,
                durationSec: ps.durationSec, distNm: ps.distNm,
                score: ps.score, originalIndices: [i], _originalIdx: i,
            });
        } else {
            const entry = seenPre.get(ps.name);
            entry.durationSec += ps.durationSec;
            entry.distNm = parseFloat((entry.distNm + ps.distNm).toFixed(1));
            entry.score  = Math.round((entry.score * entry.originalIndices.length + ps.score) /
                           (entry.originalIndices.length + 1));
            entry.originalIndices.push(i);
        }
    }
    // Emit in canonical order, skipping types that didn't occur
    for (const name of PRE_ORDER) {
        if (seenPre.has(name)) display.push(seenPre.get(name));
    }

    // ── In-flight phases ─────────────────────────────────────────────────
    // Number each repeatable type independently within the flight block.
    const flightCounts = {};
    for (let i = Math.max(0, firstFlight); i <= lastFlight && lastFlight >= 0; i++) {
        const ps = phaseScores[i];
        const entry = { ...ps, originalIndices: [i], _originalIdx: i };
        if (REPEATABLE.has(ps.name)) {
            flightCounts[ps.name] = (flightCounts[ps.name] || 0) + 1;
            entry._flightNum = flightCounts[ps.name];
        }
        display.push(entry);
    }

    // ── Post-landing block ───────────────────────────────────────────────
    const postStart = lastFlight >= 0 ? lastFlight + 1 : preEnd;
    const seenPost = new Map();
    for (let i = postStart; i < phaseScores.length; i++) {
        const ps = phaseScores[i];
        if (!seenPost.has(ps.name)) {
            const entry = {
                name: ps.name, startIdx: ps.startIdx,
                durationSec: ps.durationSec, distNm: ps.distNm,
                score: ps.score, originalIndices: [i], _originalIdx: i,
            };
            seenPost.set(ps.name, entry);
            display.push(entry);
        } else {
            const entry = seenPost.get(ps.name);
            entry.durationSec += ps.durationSec;
            entry.distNm = parseFloat((entry.distNm + ps.distNm).toFixed(1));
            entry.score  = Math.round((entry.score * entry.originalIndices.length + ps.score) /
                           (entry.originalIndices.length + 1));
            entry.originalIndices.push(i);
        }
    }

    return display;
}

function _displayLabel(entry) {
    const base = PHASE_LABELS[entry.name] || entry.name;
    if (entry._flightNum !== undefined) {
        // Only add a number when this phase type appears more than once in-flight
        return entry._flightNum > 1 || _flightTypeCount(entry) > 1
            ? `${base} ${entry._flightNum}` : base;
    }
    return base;
}

// Count how many times a flight-phase type appears in the current display list.
// Computed lazily per render; cheap for typical flight lengths.
let _displayList = [];
function _flightTypeCount(entry) {
    return _displayList.filter(e => e.name === entry.name && e._flightNum !== undefined).length;
}

function _renderSidebar(phaseScores) {
    const el = document.getElementById('phase-sidebar');
    if (!el) return;

    _displayList = _buildDisplayList(phaseScores);

    const disagreeCount  = phaseScores.filter(p => !p.mlAgreement && !p.pilotLabel).length;
    const confirmedCount = phaseScores.filter(p => p.pilotLabel !== null).length;

    const headerParts = ['PHASES'];
    if (disagreeCount > 0)  headerParts.push(`<span class="disagree">${disagreeCount} disagreement${disagreeCount !== 1 ? 's' : ''}</span>`);
    if (confirmedCount > 0) headerParts.push(`<span class="confirmed">${confirmedCount} confirmed</span>`);
    const header = headerParts.length > 1
        ? `<div class="ps-sidebar-header">${headerParts.join(' · ')}</div>` : '';

    const rows = _displayList.map((entry, di) => {
        const label     = _displayLabel(entry);
        const origIdx   = entry._originalIdx;
        const ps        = phaseScores[origIdx];
        const effective = ps?.pilotLabel ?? entry.name;
        const isGrouped = entry.originalIndices.length > 1;

        // Badges: only on non-grouped entries (individual segments have ML labels)
        let badge = '';
        if (!isGrouped && ps) {
            if (ps.pilotLabel !== null) {
                const txt = ps.pilotLabel !== ps.name
                    ? `✓ corrected: ${PHASE_LABELS[ps.pilotLabel] || ps.pilotLabel}`
                    : '✓ confirmed';
                badge = `<div class="ps-confirmed-badge">${txt}</div>`;
            } else if (!ps.mlAgreement) {
                badge = `<div class="ps-ml-badge" data-correct="${origIdx}">⚠ ML: ${PHASE_LABELS[ps.mlLabel] || ps.mlLabel}</div>`;
            }
        }

        // Correction panel: only on individual (non-grouped) entries
        const correction = (!isGrouped && _openCorrectionIdx === origIdx)
            ? _correctionPanel(ps, origIdx) : '';

        const groupedNote = isGrouped
            ? `<span style="font-size:0.68rem;color:var(--text-muted)"> ×${entry.originalIndices.length}</span>` : '';

        return `
            <div class="ps-phase" data-di="${di}" data-start="${entry.startIdx}" data-orig="${origIdx}">
              <div class="ps-phase-name">
                <span class="ps-phase-icon">${PHASE_ICONS[effective] || '→'}</span>
                <span>${label}${groupedNote}</span>
              </div>
              <div class="ps-meta">${entry.distNm.toFixed(1)} nm · ${fmtDuration(entry.durationSec)}</div>
              <div class="ps-score">
                <span class="ps-score-badge ${scoreColor(entry.score)}">${entry.score}</span>
                <div class="ps-score-bar">
                  <div class="ps-score-fill" style="width:${entry.score}%;background:${scoreHex(entry.score)}"></div>
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
            const origIdx  = parseInt(row.dataset.orig);
            _onSeekCb?.(startIdx, origIdx);
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
    if (!_phaseScores || !_displayList.length) return;
    const el = document.getElementById('phase-sidebar');
    if (!el) return;
    // Find the display entry whose underlying segment contains rowIdx
    const activeEntry = _displayList.findIndex(entry =>
        entry.originalIndices.some(i => {
            const ps = _phaseScores[i];
            return rowIdx >= ps.startIdx && rowIdx <= ps.endIdx;
        })
    );
    el.querySelectorAll('.ps-phase').forEach((row, i) =>
        row.classList.toggle('active', i === activeEntry));
}
