// Vale Command UI — connection dialog

import state from './state.js';
import { invoke } from './ipc.js';
import { doTermOpen } from './term.js';
import { escapeHtml } from './events.js';

// ── Dialog ──

export function showConnDialog() {
  state.connType = 'pty';
  document.getElementById('conn-modal').classList.add('show');
  highlightTypeBtns();
  renderConnFields();
  loadSavedConns();
  clearConnError();
}

export function closeConnDialog() {
  document.getElementById('conn-modal').classList.remove('show');
}

export function switchConnType(kind) {
  state.connType = kind;
  highlightTypeBtns();
  renderConnFields();
  if (kind === 'serial') refreshSerialPorts();
}

function highlightTypeBtns() {
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.kind === state.connType);
  });
}

// ── Fields ──

function renderConnFields() {
  const div = document.getElementById('conn-fields');
  if (state.connType === 'pty') {
    div.innerHTML =
      '<div class="field-row"><label>Shell (blank = default)</label><input type="text" id="field-target" placeholder="bash / powershell"></div>';
  } else if (state.connType === 'ssh') {
    div.innerHTML =
      '<div class="field-row"><label>Host</label><input type="text" id="field-target" placeholder="user@host:22"></div>' +
      '<div class="field-row"><label>Password (optional)</label><input type="password" id="field-password"></div>' +
      '<div class="check-row"><label><input type="checkbox" id="field-remember"> Remember password</label></div>';
  } else {
    div.innerHTML =
      '<div class="field-row"><label>Port</label><input type="text" id="field-target" placeholder="/dev/ttyUSB0?baud=115200"></div>' +
      '<div class="field-row" id="serial-ports"></div>';
  }
}

async function refreshSerialPorts() {
  const r = await invoke('list_serial_ports');
  const div = document.getElementById('serial-ports');
  if (!div) return;
  if (r.ok && r.result && r.result.length) {
    div.innerHTML = '<label>Available ports</label>' +
      r.result.map(p => `<div class="saved-item" data-action="quickConnectSerial" data-port="${p.port_name}">${p.port_name}${p.description ? ' — ' + p.description : ''}</div>`).join('');
  } else {
    div.innerHTML = '<label class="muted-label">No serial ports found</label>';
  }
}

// ── Saved connections ──

function loadSavedConns() {
  try {
    state.savedConns = JSON.parse(localStorage.getItem('vale_command_conns') || '[]');
  } catch (_) {
    state.savedConns = [];
  }
  renderSavedList();
}

function saveConn(kind, target) {
  state.savedConns = state.savedConns.filter(c => !(c.kind === kind && c.target === target));
  state.savedConns.unshift({ kind, target, label: target });
  if (state.savedConns.length > 20) state.savedConns.pop();
  localStorage.setItem('vale_command_conns', JSON.stringify(state.savedConns));
  renderSavedList();
}

function deleteSavedConn(idx) {
  state.savedConns.splice(idx, 1);
  localStorage.setItem('vale_command_conns', JSON.stringify(state.savedConns));
  renderSavedList();
}

function renderSavedList() {
  const div = document.getElementById('saved-connections');
  if (!state.savedConns.length) {
    div.innerHTML = '';
    return;
  }
  div.innerHTML = '<div class="saved-title">Saved</div>' +
    state.savedConns.map((c, i) =>
      `<div class="saved-item" data-action="quickConnect" data-idx="${i}">${escapeHtml(c.label || c.target)} (${c.kind})<button class="saved-del" data-action="deleteSavedConn" data-idx="${i}">×</button></div>`
    ).join('');
}

export async function quickConnect(idx) {
  const c = state.savedConns[idx];
  if (!c) return;
  switchConnType(c.kind);
  document.getElementById('field-target').value = c.target;
  // Pre-fill saved password from OS keychain
  if (c.kind === 'ssh') {
    const r = await invoke('secret_get', { target: c.target });
    if (r.ok && r.result && r.result.password) {
      const pw = document.getElementById('field-password');
      if (pw) pw.value = r.result.password;
      const rm = document.getElementById('field-remember');
      if (rm) rm.checked = true;
    }
  }
}

// ── Do connect ──

function showConnError(msg) {
  clearConnError();
  const div = document.createElement('div');
  div.className = 'conn-error';
  div.textContent = msg;
  document.getElementById('conn-fields').appendChild(div);
}

function clearConnError() {
  document.querySelectorAll('#conn-fields .conn-error').forEach(el => el.remove());
}

function setConnecting(on) {
  state.connecting = on;
  const btn = document.querySelector('#conn-modal .btn-connect');
  if (btn) {
    btn.disabled = on;
    btn.textContent = on ? 'Connecting…' : 'Connect';
  }
}

export async function doConnect() {
  if (state.connecting) return; // guard against double-click double-sessions
  const target = document.getElementById('field-target')?.value?.trim() || '';
  const password = document.getElementById('field-password')?.value || '';
  const kind = state.connType;

  if (!target && kind !== 'pty') {
    showConnError(kind === 'ssh' ? 'Host is required (user@host:port)' : 'Port is required');
    return;
  }
  setConnecting(true);
  clearConnError();
  const result = await doTermOpen(kind, target, password);
  setConnecting(false);
  if (result.ok) {
    saveConn(kind, target);
    // Save/delete password via OS keychain
    const remember = document.getElementById('field-remember');
    if (remember && remember.checked) {
      invoke('secret_set', { target, password });
    }
    closeConnDialog();
  } else {
    showConnError(result.error || 'Connection failed');
  }
}

// ── Modal keyboard / backdrop handling ──

document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('conn-modal');
  if (modal && modal.classList.contains('show') && e.key === 'Escape') {
    closeConnDialog();
  }
});

document.getElementById('conn-modal')?.addEventListener('mousedown', (e) => {
  if (e.target.id === 'conn-modal') closeConnDialog(); // backdrop click
});

document.getElementById('conn-modal')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    e.preventDefault();
    doConnect();
  }
});

export { deleteSavedConn };
