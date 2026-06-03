// js/vspeeds.js

const V_SPEED_DEFS = [
    { key: 'vrKias',   label: 'Vr',  desc: 'Rotation speed' },
    { key: 'vs0Kias',  label: 'Vs0', desc: 'Stall, flaps down' },
    { key: 'vs1Kias',  label: 'VS1', desc: 'Stall, flaps up' },
    { key: 'vxKias',   label: 'Vx',  desc: 'Best angle of climb' },
    { key: 'vyKias',   label: 'Vy',  desc: 'Best rate of climb' },
    { key: 'vcmKias',  label: 'Vcm', desc: 'Recommended touchdown' },
    { key: 'vrefKias', label: 'Vref', desc: 'Landing reference' },
    { key: 'vneKias',  label: 'Vne', desc: 'Never exceed' },
    { key: 'vnoKias',  label: 'Vno', desc: 'Max structural cruise' },
];

let _defaults = {};
let _tailNumber = '';

export function initVspeeds(defaults, tailNumber) {
    _defaults = defaults || {};
    _tailNumber = tailNumber || 'default';
    _buildTable();
    document.getElementById('vspeeds-btn')?.addEventListener('click', () => {
        document.getElementById('vspeeds-modal')?.classList.remove('hidden');
    });
    document.getElementById('vspeeds-cancel')?.addEventListener('click', () => {
        document.getElementById('vspeeds-modal')?.classList.add('hidden');
    });
    document.getElementById('vspeeds-save')?.addEventListener('click', _save);
}

function _storageKey() { return `vspeeds_${_tailNumber}`; }

function _loadOverrides() {
    try { return JSON.parse(localStorage.getItem(_storageKey()) || '{}'); }
    catch (_) { return {}; }
}

function _buildTable() {
    const table = document.getElementById('vspeeds-table');
    if (!table) return;
    const overrides = _loadOverrides();
    table.innerHTML = `
        <thead>
          <tr>
            <th>Speed</th><th>Description</th>
            <th style="text-align:right">Default (kt)</th>
            <th style="text-align:right">Override (kt)</th>
          </tr>
        </thead>
        <tbody>
          ${V_SPEED_DEFS.map(def => `
            <tr>
              <td style="font-weight:800;font-family:var(--font-instrument)">${def.label}</td>
              <td style="color:var(--text-muted)">${def.desc}</td>
              <td style="text-align:right;font-family:var(--font-instrument)">${_defaults[def.key] ?? '—'}</td>
              <td style="text-align:right">
                <input type="number" data-key="${def.key}"
                  value="${overrides[def.key] ?? ''}"
                  placeholder="${_defaults[def.key] ?? ''}"
                  min="0" max="400" step="1">
              </td>
            </tr>
          `).join('')}
        </tbody>
    `;
}

function _save() {
    const table = document.getElementById('vspeeds-table');
    const overrides = {};
    table?.querySelectorAll('input[data-key]').forEach(inp => {
        const v = parseFloat(inp.value);
        if (!isNaN(v) && v > 0) overrides[inp.dataset.key] = v;
    });
    try { localStorage.setItem(_storageKey(), JSON.stringify(overrides)); } catch (_) {}
    document.getElementById('vspeeds-modal')?.classList.add('hidden');
}

// Returns merged thresholds: overrides win over defaults.
export function getVspeeds() {
    const overrides = _loadOverrides();
    return { ..._defaults, ...overrides };
}
