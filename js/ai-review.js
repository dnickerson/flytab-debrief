// js/ai-review.js
import { closestApproach } from './traffic-parser.js';

export function initAiReview(fd, scores, phaseScores, events, trafficData) {
    const panel = document.getElementById('review-panel');
    if (!panel) return;

    const col = s => s >= 80 ? 'green' : s >= 60 ? 'amber' : 'red';
    const bar = s => `<div class="review-score-bar-wrap"><div class="review-score-bar ${col(s)}" style="width:${s}%"></div></div>`;

    const topEvents = [...events]
        .sort((a, b) => (b.level === 'red' ? 2 : b.level === 'orange' ? 1 : 0) -
                        (a.level === 'red' ? 2 : a.level === 'orange' ? 1 : 0))
        .slice(0, 3);

    const fmt = d => d ? d.toISOString().slice(11, 16) + 'Z' : '--:--Z';
    const o = fd.oooi || {};

    panel.innerHTML = `
        <div class="review-top">
          <div class="review-summary">
            <h4>FLIGHT SUMMARY</h4>
            <div class="review-flight-info">
              <div><b>${fd.depIcao || '?'} → ${fd.destIcao || '?'}</b></div>
              <div>${fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : '—'}
                   &nbsp; ${fmt(o.off)} – ${fmt(o.on)}</div>
              <div>Block ${fd.blockMinutes.toFixed(0)} min · Air ${fd.airMinutes.toFixed(0)} min · ${fd.totalDistanceNm.toFixed(0)} nm</div>
              ${fd.depMetar  ? `<div style="font-size:0.75rem;margin-top:4px;color:var(--text-muted)">${fd.depMetar}</div>`  : ''}
              ${fd.destMetar ? `<div style="font-size:0.75rem;color:var(--text-muted)">${fd.destMetar}</div>` : ''}
            </div>
          </div>
          <div class="review-scores">
            <h4>SCORE BREAKDOWN</h4>
            <div class="review-score-row">
              <span class="review-score-label">Engine Mgmt</span>${bar(scores.engineMgmt.overall)}
              <span class="review-score-num">${scores.engineMgmt.overall}</span>
            </div>
            <div class="review-score-row">
              <span class="review-score-label">Airmanship</span>${bar(scores.airmanship.overall)}
              <span class="review-score-num">${scores.airmanship.overall}</span>
            </div>
            ${scores.approach ? `
            <div class="review-score-row">
              <span class="review-score-label">Approach</span>${bar(scores.approach.overall)}
              <span class="review-score-num">${scores.approach.overall}</span>
            </div>` : ''}
            <div class="review-score-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">
              <span class="review-score-label"><b>Overall</b></span>${bar(scores.overall)}
              <span class="review-score-num"><b>${scores.overall}</b></span>
            </div>
            ${topEvents.length ? `
            <div style="margin-top:10px">
              <div style="font-size:0.7rem;font-weight:800;color:var(--text-label);margin-bottom:4px">TOP EVENTS</div>
              ${topEvents.map(e => `
                <div class="review-event-item">
                  <span style="color:${e.level==='red'?'var(--color-danger)':'var(--color-caution)'}">⚠</span>
                  ${e.type} — ${e.detail}
                </div>`).join('')}
            </div>` : ''}
          </div>
        </div>
        <div class="review-narrative" id="review-narrative">
          <div class="review-generate-wrap">
            <button class="hdr-btn" id="review-generate-btn">Generate AI Review ▶</button>
            <span id="review-status" style="font-size:0.8rem;color:var(--text-muted)"></span>
          </div>
          <div id="review-content"></div>
        </div>
    `;

    // Try loading cached review
    fetch(`/api/review/${encodeURIComponent(fd.filename)}`)
        .then(r => r.json())
        .then(cached => {
            if (cached?.narrative) _renderNarrative(cached.narrative);
        })
        .catch(() => {});

    document.getElementById('review-generate-btn')?.addEventListener('click', () =>
        _generateReview(fd, scores, events, trafficData)
    );
}

function _generateReview(fd, scores, events, trafficData) {
    const status = document.getElementById('review-status');
    const btn    = document.getElementById('review-generate-btn');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Generating… (15–30 seconds)';

    const payload = _buildPayload(fd, scores, events, trafficData);
    fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) throw new Error(data.error);
        fetch(`/api/review/${encodeURIComponent(fd.filename)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ narrative: data.narrative }),
        }).catch(() => {});
        _renderNarrative(data.narrative);
        if (status) status.textContent = '';
    })
    .catch(err => {
        if (status) status.textContent = `Failed: ${err.message}`;
        if (btn) btn.disabled = false;
    });
}

function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _renderNarrative(narrative) {
    const content = document.getElementById('review-content');
    const btn = document.getElementById('review-generate-btn');
    const status = document.getElementById('review-status');
    if (btn) { btn.textContent = 'Refresh ↺'; btn.disabled = false; }
    if (status) status.textContent = '';
    if (!content) return;

    // Split narrative into sections by category headers
    const sections = _parseSections(narrative);
    content.innerHTML = sections.map(sec => `
        <div class="review-section">
          ${sec.title ? `<div class="review-section-hdr" data-open="1">▼ ${_esc(sec.title)}</div>` : ''}
          <div class="review-section-body">${_esc(sec.body).replace(/\n\n/g,'<br><br>').replace(/\n/g,' ')}</div>
        </div>
    `).join('');

    content.querySelectorAll('.review-section-hdr').forEach(hdr => {
        hdr.addEventListener('click', () => {
            const open = hdr.dataset.open === '1';
            hdr.dataset.open = open ? '0' : '1';
            hdr.textContent = (open ? '▶ ' : '▼ ') + hdr.textContent.slice(2);
            const body = hdr.nextElementSibling;
            if (body) body.style.display = open ? 'none' : '';
        });
    });
}

function _parseSections(text) {
    const lines = text.split('\n');
    const sections = [];
    let current = { title: '', body: '' };
    const headingRe = /^(Engine Management|Airmanship|Approach|Summary|Overall)/i;
    for (const line of lines) {
        if (headingRe.test(line.trim())) {
            if (current.body.trim()) sections.push(current);
            current = { title: line.trim(), body: '' };
        } else {
            current.body += line + '\n';
        }
    }
    if (current.body.trim() || current.title) sections.push(current);
    return sections.length > 0 ? sections : [{ title: '', body: text }];
}

function _buildPayload(fd, scores, events, trafficData) {
    const fmt = d => d ? d.toISOString().slice(11, 16) + 'Z' : '--:--Z';
    const o = fd.oooi || {};
    const closest = closestApproach(trafficData?.proximityEvents || []);
    const avgOf = (arr) => arr.reduce((a,b) => a+b, 0) / arr.length;

    const phaseStats = {};
    for (const phase of fd.phases) {
        const idxs = [];
        for (let i = phase.startIdx; i <= phase.endIdx; i++) idxs.push(i);
        if (!idxs.length) continue;
        phaseStats[phase.name] = {
            durationMin: Math.round(idxs.length / 60),
            avgCht: Math.round(avgOf(idxs.map(i => Math.max(...[0,1,2,3].map(c => fd.cht[c][i]))))),
            avgEgt: Math.round(avgOf(idxs.map(i => Math.max(...[0,1,2,3].map(c => fd.egt[c][i]))))),
            avgFuelFlow: parseFloat(avgOf(idxs.map(i => fd.fuelFlow[i])).toFixed(1)),
        };
    }

    return {
        flight:   `${fd.depIcao || '?'}→${fd.destIcao || '?'}`,
        date:     fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : '—',
        aircraft: 'RV-9A N194JT, Lycoming O-360 A1A',
        oooi:     { outZ: fmt(o.out), offZ: fmt(o.off), onZ: fmt(o.on), inZ: fmt(o.in) },
        duration: { blockMin: Math.round(fd.blockMinutes), airMin: Math.round(fd.airMinutes),
                    distNm: Math.round(fd.totalDistanceNm) },
        conditions: { depMetar: fd.depMetar, destMetar: fd.destMetar,
                      avgHeadwindKt: Math.round(fd.avgHeadwindKt || 0) },
        scores:   { overall: scores.overall, engineMgmt: scores.engineMgmt.overall,
                    airmanship: scores.airmanship.overall, approach: scores.approach?.overall ?? null },
        events:   events.slice(0, 20).map(e => ({ timeMin: Math.round(e.tSec/60), type: e.type, detail: e.detail })),
        phaseStats,
        dmmsViolations: events.filter(e => e.type === 'DMMS_VIOLATION').length,
        redBoxSeconds:  events.filter(e => e.type === 'RED_BOX').length,
        chtRocEvents:   events.filter(e => e.type === 'CHT_ROC_CAUTION').length,
        closestTraffic: closest ? { callsign: closest.callsign, horizNm: parseFloat(closest.horizNm.toFixed(1)),
                                    vertFt: closest.vertFt } : null,
    };
}
