// Vale Command UI — shared tab-bar items (browser tabs & terminal sessions)
//
// Both bars use one markup idiom — an item with a close button — differing
// only in the data-key attribute (data-tab vs data-sid), the select/close
// data-action names, and the label source. Those are parameterized.

import { escapeHtml } from './events.js';

export function renderTabItem({ bar, key, keyAttr, label, selectAction, closeAction, icon = '×', title = null }) {
  const sel = `[data-${keyAttr}="${CSS.escape(key)}"]`;
  if (bar.querySelector(sel)) return;
  const el = document.createElement('span');
  el.className = 'tab-item';
  el.dataset[keyAttr] = key;
  el.dataset.action = selectAction;
  if (title !== null) el.title = title;
  el.innerHTML =
    `<span class="tab-title">${escapeHtml(label)}</span>` +
    `<button class="tab-close" data-action="${closeAction}" data-${keyAttr}="${CSS.escape(key)}" title="Close">${icon}</button>`;
  // Selection handled by the delegated data-action handler in app.js;
  // the close button wins closest('[data-action]') so no bubbling guard is needed.
  bar.appendChild(el);
}

export function highlightTabItem({ bar, key, keyAttr }) {
  bar.querySelectorAll('.tab-item').forEach(t => {
    t.classList.toggle('active', t.dataset[keyAttr] === key);
  });
}

export function updateCloseButtons(bar) {
  // Show close buttons only when more than one item exists
  const count = bar.querySelectorAll('.tab-item').length;
  bar.querySelectorAll('.tab-close').forEach(b => {
    b.style.display = count > 1 ? '' : 'none';
  });
}

export function removeTabItem({ bar, key, keyAttr }) {
  const el = bar.querySelector(`[data-${keyAttr}="${CSS.escape(key)}"]`);
  if (el) el.remove();
}
