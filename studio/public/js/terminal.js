// terminal.js — xterm.js panel backed by server-held PTY sessions
"use strict";
window.VS = window.VS || {};

VS.terminal = (() => {
  const panel = document.getElementById("terminal-panel");
  const tablist = document.getElementById("term-tablist");
  const hosts = document.getElementById("term-hosts");
  const terms = new Map(); // id -> {id,name,ws,term,fit,hostEl,dead,tabEl,hostWrap}
  let activeId = null;

  function toggle(force) {
    const show = force != null ? force : panel.hidden;
    panel.hidden = !show;
    if (show) {
      if (!terms.size) newTerminal();
      else refitActive();
    }
  }

  function refitActive() {
    const t = terms.get(activeId);
    if (t && t.fit) setTimeout(() => t.fit.fit(), 30);
  }

  async function newTerminal(cwd) {
    let info;
    try {
      info = await VS.api("/api/term", {
        method: "POST",
        body: { cwd: cwd || undefined, cols: 80, rows: 24 },
      });
    } catch (e) {
      VS.toast("无法创建终端: " + e.message, "error");
      return;
    }
    attach(info.id);
  }

  function attach(id) {
    // reuse existing view
    const existing = terms.get(id);
    if (existing) {
      activate(id);
      return;
    }
    const term = new window.Terminal({
      fontFamily: 'var(--mono), "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursorAccent: "#1e1e1e",
        selectionBackground: "rgba(38,79,120,.99)",
      },
      scrollback: 5000,
      cursorBlink: true,
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch (e) {}

    const hostWrap = document.createElement("div");
    hostWrap.className = "term-host";
    const inner = document.createElement("div");
    inner.style.cssText = "width:100%;height:100%";
    hostWrap.append(inner);
    hosts.append(hostWrap);
    term.open(inner);

    const ws = new WebSocket(VS.wsUrl(`/api/term/${id}`));
    ws.binaryType = "arraybuffer";
    ws.onopen = () => sendResize();
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
      else {
        try {
          const ctrl = JSON.parse(ev.data);
          if (ctrl.exited !== undefined) markDead(id);
        } catch (e) {}
      }
    };
    ws.onclose = () => {
      // session lives server-side; retry silently unless it exited
      const t = terms.get(id);
      if (t && !t.dead) setTimeout(() => reconnect(t), 1500);
    };
    term.onData((d) => {
      if (ws.readyState === 1) {
        // protocol: binary frames = stdin (text frames are JSON control)
        ws.send(new TextEncoder().encode(d));
      }
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ resize: { cols, rows } }));
    });

    const t = { id, name: id, ws, term, fit, hostWrap, dead: false, tabEl: null };
    terms.set(id, t);
    renderTabs();
    activate(id);
    refreshList();
  }

  function reconnect(t) {
    if (t.dead) return;
    const ws = new WebSocket(VS.wsUrl(`/api/term/${t.id}`));
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) t.term.write(new Uint8Array(ev.data));
    };
    ws.onopen = () => { t.ws = ws; sendResize(t); };
    ws.onclose = () => {
      const cur = terms.get(t.id);
      if (cur && !cur.dead) setTimeout(() => reconnect(cur), 2500);
    };
  }

  function sendResize(t0) {
    const t = t0 || terms.get(activeId);
    if (!t || t.ws.readyState !== 1) return;
    t.fit.fit();
    t.ws.send(JSON.stringify({ resize: { cols: t.term.cols, rows: t.term.rows } }));
  }

  async function refreshList() {
    try {
      const data = await VS.api("/api/terms");
      for (const s of data.terms) {
        const t = terms.get(s.id);
        if (t) { t.name = s.name; if (s.exited) markDead(s.id); }
        else if (!s.exited) {
          // server has sessions we have not viewed yet — show lazily on click
          ensureTabElement({ id: s.id, name: s.name, exited: false });
        }
      }
      renderTabs();
    } catch (e) {}
  }

  function ensureTabElement(t0) {
    let t = terms.get(t0.id);
    if (!t) {
      t = Object.assign({ hostWrap: null, term: null }, t0);
      terms.set(t0.id, t);
    }
    return t;
  }

  function markDead(id) {
    const t = terms.get(id);
    if (!t || t.dead) return;
    t.dead = true;
    renderTabs();
  }

  function killTerm(id) {
    VS.api(`/api/term/${id}`, { method: "DELETE" }).catch(() => {});
    const t = terms.get(id);
    if (t) {
      t.dead = true;
      if (t.ws && t.ws.readyState === 1) t.ws.close();
      if (t.term) t.term.dispose();
      if (t.hostWrap) t.hostWrap.remove();
      terms.delete(id);
    }
    renderTabs();
    if (activeId === id) {
      activeId = null;
      const next = [...terms.keys()][0];
      if (next) activate(next); else panel.hidden = true;
    }
  }

  function activate(id) {
    activeId = id;
    for (const [tid, t] of terms) {
      if (t.hostWrap) t.hostWrap.classList.toggle("active", tid === id);
    }
    renderTabs();
    refitActive();
  }

  function renderTabs() {
    tablist.innerHTML = "";
    for (const [id, t] of terms) {
      const el = document.createElement("span");
      el.className = "term-tab" + (id === activeId ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "term-dot" + (t.dead ? " dead" : "");
      const label = document.createElement("span");
      label.textContent = t.name || id;
      const close = document.createElement("button");
      close.className = "icon-btn";
      close.textContent = "✕";
      close.addEventListener("click", (e) => { e.stopPropagation(); killTerm(id); });
      el.append(dot, label, close);
      el.addEventListener("click", () => {
        if (t.term) activate(id);
        else attach(id); // lazy-attach to a server-held session
      });
      t.tabEl = el;
      tablist.append(el);
    }
  }

  document.getElementById("btn-term-new").addEventListener("click", () => newTerminal());
  document.getElementById("btn-term-close").addEventListener("click", () => toggle(false));

  window.addEventListener("resize", refitActive);

  return { toggle, newTerminal, refitActive, get activeId() { return activeId; } };
})();
