// js/claude-review.js
import { closestApproach } from './traffic-parser.js';

export function initClaudeReview(fd, scores, events, trafficData) {
    const panel = document.getElementById('ai-panel');
    if (!panel) return;

    fetch(`/api/review/${encodeURIComponent(fd.filename)}`).then(r => r.json()).then(cached => {
        if (cached?.narrative) {
            _renderNarrative(panel, cached.narrative, fd.filename, fd, scores, events, trafficData);
        } else {
            panel.innerHTML = `
                <p class="ai-loading">AI review not yet generated.</p>
                <button id="ai-generate-btn" class="hdr-btn" style="margin-top:8px">GENERATE REVIEW</button>
            `;
            document.getElementById('ai-generate-btn')?.addEventListener('click', () =>
                _generateReview(fd, scores, events, trafficData, panel)
            );
        }
    }).catch(() => {
        panel.innerHTML = '<p class="ai-loading">Could not load review.</p>';
    });
}

async function _generateReview(fd, scores, events, trafficData, panel) {
    panel.innerHTML = '<p class="ai-loading">Generating review… (15-30 seconds)</p>';
    const payload = _buildPayload(fd, scores, events, trafficData);
    try {
        const r = await fetch('/api/claude', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload }),
        });
        const data = await r.json();
        if (data.error) throw new Error(data.error);
        await fetch(`/api/review/${encodeURIComponent(fd.filename)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ narrative: data.narrative }),
        });
        _renderNarrative(panel, data.narrative, fd.filename, fd, scores, events, trafficData);
    } catch (err) {
        panel.innerHTML = `<p style="color:var(--color-danger)">Review failed: ${err.message}</p>`;
    }
}

function _renderNarrative(panel, narrative, filename, fd, scores, events, trafficData) {
    panel.innerHTML = `
        <div style="line-height:1.6;white-space:pre-wrap">${narrative}</div>
        <button id="ai-refresh-btn" class="hdr-btn" style="margin-top:12px;font-size:0.75rem">REFRESH AI REVIEW</button>
    `;
    document.getElementById('ai-refresh-btn')?.addEventListener('click', async () => {
        await fetch(`/api/review/${encodeURIComponent(filename)}`, { method: 'PUT',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ narrative: null }) });
        _generateReview(fd, scores, events, trafficData, panel);
    });
}

function _buildPayload(fd, scores, events, trafficData) {
    const fmt = d => d ? d.toISOString().slice(11, 16) + 'Z' : '--:--Z';
    const o = fd.oooi || {};
    const closest = closestApproach(trafficData?.proximityEvents || []);

    const phaseStats = {};
    for (const phase of fd.phases) {
        const idxs = [];
        for (let i = phase.startIdx; i <= phase.endIdx; i++) idxs.push(i);
        if (!idxs.length) continue;
        const avgOf = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
        phaseStats[phase.name] = {
            durationMin: Math.round(idxs.length / 60),
            avgCht: Math.round(avgOf(idxs.map(i => Math.max(...[0,1,2,3].map(c => fd.cht[c][i]))))),
            avgEgt: Math.round(avgOf(idxs.map(i => Math.max(...[0,1,2,3].map(c => fd.egt[c][i]))))),
            avgFuelFlow: parseFloat(avgOf(idxs.map(i => fd.fuelFlow[i])).toFixed(1)),
        };
    }

    return {
        flight:   `${fd.depIcao || '?'}→${fd.destIcao || '?'}`,
        date:     fd.startUtc ? fd.startUtc.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
        aircraft: 'RV-9A N194JT, Lycoming O-360 A1A',
        oooi:     { outZ: fmt(o.out), offZ: fmt(o.off), onZ: fmt(o.on), inZ: fmt(o.in) },
        duration: { blockMin: Math.round(fd.blockMinutes), airMin: Math.round(fd.airMinutes),
                    distNm: Math.round(fd.totalDistanceNm) },
        conditions: { depMetar: fd.depMetar, destMetar: fd.destMetar,
                      avgHeadwindKt: Math.round(fd.avgHeadwindKt || 0),
                      avgTasKt: Math.round(fd.avgTas || 0), avgIasKt: Math.round(fd.avgIas || 0) },
        scores:   { overall: scores.overall, engineMgmt: scores.engineMgmt.overall,
                    airmanship: scores.airmanship.overall, approach: scores.approach?.overall ?? null },
        events:   events.slice(0, 20).map(e => ({ timeMin: Math.round(e.tSec / 60), type: e.type, detail: e.detail })),
        phaseStats,
        dmmsViolations:  events.filter(e => e.type === 'DMMS_VIOLATION').length,
        redBoxSeconds:   events.filter(e => e.type === 'RED_BOX').length,
        carbIceSeconds:  events.filter(e => e.type === 'CARB_ICE_RISK').length,
        closestTraffic:  closest ? { callsign: closest.callsign, horizNm: parseFloat(closest.horizNm.toFixed(1)),
                                     vertFt: closest.vertFt, timeMin: Math.round(closest.tSec / 60) } : null,
    };
}
