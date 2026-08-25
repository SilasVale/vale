// terminal.js — xterm.js panel backed by server-held PTY sessions
"use strict";
window.VS = window.VS || {};

VS.terminal = (() => {
  const THEMES = {
    light: { background: "#ffffff", foreground: "#1d1d1f", cursorAccent: "#ffffff",
             selectionBackground: "rgba(13,148,136,.30)", black: "#1d1d1f", white: "#6e6e73" },
    dark: { background: "#1e1e1e", foreground: "#d4d4d4", cursorAccent: "#1e1e1e",
            selectionBackground: "rgba(38,79,120,.99)" },
  };
  let curTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
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
      fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12.5,
      theme: THEMES[curTheme],
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

    const t = { id, name: id, ws: null, term, fit, hostWrap, dead: false, tabEl: null };
    terms.set(id, t);
    connect(t);
    term.onData((d) => {
      if (t.ws && t.ws.readyState === 1) {
        // protocol: binary frames = stdin (text frames are JSON control)
        t.ws.send(new TextEncoder().encode(d));
      }
    });
    term.onResize(({ cols, rows }) => {
      if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ resize: { cols, rows } }));
    });

    renderTabs();
    activate(id);
    refreshList();
  }

  function connect(t) {
    const ws = new WebSocket(VS.wsUrl(`/api/term/${t.id}`));
    ws.binaryType = "arraybuffer";
    t.ws = ws;
    ws.onopen = () => sendResize(t);
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) t.term.write(new Uint8Array(ev.data));
      else {
        try {
          const ctrl = JSON.parse(ev.data);
          if (ctrl.exited !== undefined) markDead(t.id);
        } catch (e) {}
      }
    };
    ws.onclose = () => maybeReconnect(t);
  }

  // The PTY lives server-side, so a dropped browser socket is retried
  // transparently. But a session that is gone for good (process exited and was
  // GC'd, or lost across a no-tmux server restart) closes the socket instantly
  // — probe /api/terms first so we never spin in an infinite reconnect loop.
  async function maybeReconnect(t) {
    if (t.dead || terms.get(t.id) !== t) return;
    try {
      const data = await VS.api("/api/terms");
      if (!data.terms.some((s) => s.id === t.id)) {
        markDead(t.id);
        return;
      }
    } catch (e) { /* server unreachable — fall through to timed retry */ }
    setTimeout(() => {
      if (!t.dead && terms.get(t.id) === t && t.ws && t.ws.readyState === 3) connect(t);
    }, 2000);
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

  function setTheme(name) {
    curTheme = name;
    for (const [, t0] of terms) if (t0.term) t0.term.options.theme = THEMES[name];
  }

  return { toggle, newTerminal, refitActive, setTheme, get activeId() { return activeId; } };
})();
