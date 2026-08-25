// editor.js — Monaco lifecycle, tabs, save with optimistic locking, deep links
"use strict";
window.VS = window.VS || {};

VS.editor = (() => {
  let monacoReady = false;
  let curTheme = document.documentElement.dataset.theme === "dark" ? "vs-dark" : "vs";
  const tabs = [];                    // {path, hostEl, ed, model, sha, dirty, viewState}
  let active = null;
  const hosts = document.getElementById("editor-host");
  const tabbar = document.getElementById("tabs");
  const welcome = document.getElementById("welcome");

  const LANG = {
    ts: "typescript", tsx: "typescript", js: "javascript", mjs: "javascript",
    cjs: "javascript", jsx: "javascript", rs: "rust", c: "c", h: "c", cpp: "cpp",
    cc: "cpp", hpp: "cpp", json: "json", jsonc: "json", yml: "yaml", yaml: "yaml",
    md: "markdown", sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell",
    py: "python", css: "css", scss: "scss", html: "html", xml: "xml", sql: "sql",
    toml: "ini", ini: "ini", conf: "ini", go: "go", java: "java", rb: "ruby",
    php: "php", lua: "lua", pl: "perl", swift: "swift", kt: "kotlin",
  };
  function langOf(p) {
    const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
    return LANG[ext] || "plaintext";
  }

  // ── monaco boot ────────────────────────────────────────────────────────────
  function init() {
    require.config({ paths: { vs: "/vendor/monaco/vs" } });
    window.MonacoEnvironment = {
      getWorkerUrl() {
        // blob workers have an opaque base — must use an absolute URL,
        // and baseUrl must be the directory CONTAINING vs/
        const base = `${location.origin}/vendor/monaco/`;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
          self.MonacoEnvironment={baseUrl:"${base}"};
          importScripts("${base}vs/base/worker/workerMain.js");`)}`;
      },
    };
    require(["vs/editor/editor.main"], () => {
      monacoReady = true;
      monaco.editor.setTheme(curTheme);
      flushPending();
    });
  }

  const pendingOpens = [];
  function flushPending() {
    while (pendingOpens.length) openFile(...pendingOpens.shift());
  }

  // ── model cache ────────────────────────────────────────────────────────────
  async function fetchModel(path) {
    const data = await VS.api(`/api/file?p=${encodeURIComponent(path)}`);
    if (data.binary) {
      if (data.dataUrl) return { kind: "image", data, path };
      throw new Error(`二进制文件 (${data.binaryHint}) 不支持编辑`);
    }
    const uri = monaco.Uri.file(path);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(data.content, langOf(path), uri);
    } else {
      model.setValue(data.content);
    }
    return { kind: "text", model, sha: data.sha256, mtimeMs: data.mtimeMs, path };
  }

  // ── tabs ───────────────────────────────────────────────────────────────────
  const opening = new Map(); // path -> Promise<tab>, de-dupes concurrent opens
  function openFile(path, opts = {}) {
    if (!monacoReady) {
      pendingOpens.push([path, opts]);
      return Promise.resolve();
    }
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      activate(existing);
      VS.tree.select(path);
      VS.tree.reveal(path).catch(() => {});
      if (opts.line != null) gotoPosition(existing, opts.line, opts.col || 1, opts.sel);
      return Promise.resolve(existing);
    }
    let p = opening.get(path);
    if (!p) {
      p = doOpen(path, opts).finally(() => opening.delete(path));
      opening.set(path, p);
    }
    return p;
  }

  async function doOpen(path, opts) {
    let loaded;
    try {
      loaded = await fetchModel(path);
    } catch (e) {
      VS.toast(e.message, "error");
      return;
    }
    if (loaded.kind === "image") {
      VS.toast("图片文件在新窗口预览：" + path);
      window.open(loaded.data.dataUrl, "_blank");
      return;
    }
    const hostWrap = document.createElement("div");
    hostWrap.className = "monaco-host-tab";
    const hostInner = document.createElement("div");
    hostInner.style.cssText = "position:absolute;inset:0";
    hostWrap.append(hostInner);
    hosts.append(hostWrap);
    hostWrap.classList.add("active"); // measure BEFORE creating the editor
    const ed = monaco.editor.create(hostInner, {
      model: loaded.model,
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 13,
      fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
      renderWhitespace: "selection",
      scrollBeyondLastLine: false,
      tabSize: 2,
      stickyScroll: { enabled: false },
    });
    requestAnimationFrame(() => ed.layout());
    const tab = {
      path,
      hostWrap,
      ed,
      model: loaded.model,
      sha: loaded.sha,
      dirty: false,
      conflict: null,
      viewState: null,
      _disposables: [],
    };
    tab._disposables.push(
      loaded.model.onDidChangeContent(() => setDirty(tab, true)),
      ed.onDidChangeCursorPosition((e) => updatePos(e.position)),
    );
    tabs.push(tab);
    notifyOpenChanged();
    welcome.style.display = "none";
    activate(tab);
    VS.tree.select(path);
    VS.tree.reveal(path).catch(() => {});
    if (opts.line != null) gotoPosition(tab, opts.line, opts.col || 1, opts.sel);
    return tab;
  }

  function activate(tab) {
    if (active && active !== tab) {
      active.viewState = active.ed.saveViewState();
      active.hostWrap.classList.remove("active");
    }
    active = tab;
    tab.hostWrap.classList.add("active");
    welcome.style.display = "none";
    // re-measure in case the window resized while this tab was hidden
    requestAnimationFrame(() => tab.ed.layout());
    tab.ed.focus();
    renderTabs();
  }

  function closeTab(tab) {
    if (tab.dirty && !confirm(`${basename(tab.path)} 有未保存修改，确定关闭？`)) return;
    tab._disposables.forEach((d) => d.dispose());
    tab.ed.dispose();
    tab.model.dispose();
    tab.hostWrap.remove();
    tabs.splice(tabs.indexOf(tab), 1);
    if (active === tab) {
      active = tabs[tabs.length - 1] || null;
      if (active) {
        active.hostWrap.classList.add("active");
        active.ed.restoreViewState(active.viewState || {});
      } else {
        welcome.style.display = "";
      }
    }
    renderTabs();
  }

  function renderTabs() {
    tabbar.innerHTML = "";
    for (const t of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (t === active ? " active" : "") + (t.dirty ? " dirty" : "");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = basename(t.path);
      name.title = t.path;
      const close = document.createElement("button");
      close.className = "close";
      close.textContent = "✕";
      close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t); });
      el.append(name, close);
      el.addEventListener("click", () => activate(t));
      tabbar.append(el);
    }
  }

  function setDirty(tab, dirty) {
    if (tab.dirty === dirty) return;
    tab.dirty = dirty;
    renderTabs();
  }

  // ── save ───────────────────────────────────────────────────────────────────
  async function saveTab(tab) {
    if (!tab.dirty && !tab.conflict) return;
    try {
      const result = await VS.api("/api/file", {
        method: "PUT",
        body: { p: tab.path, content: tab.model.getValue(), baseSha256: tab.sha },
      });
      tab.sha = result.sha256;
      setDirty(tab, false);
      hideConflict();
      VS.toast("已保存 " + basename(tab.path));
    } catch (e) {
      if (e.code === "conflict") {
        tab.conflict = e.currentSha256;
        showConflict(tab, e.currentSha256 ? "磁盘上的文件已被外部（可能是 DSH）修改。" : "文件已在磁盘上被创建。");
      } else {
        VS.toast("保存失败: " + e.message, "error");
      }
    }
  }

  async function reloadFromDisk(tab) {
    try {
      const data = await VS.api(`/api/file?p=${encodeURIComponent(tab.path)}`);
      tab.model.setValue(data.content);
      tab.sha = data.sha256;
      tab.conflict = null;
      setDirty(tab, false);
      hideConflict();
      VS.toast("已从磁盘重新加载");
    } catch (e) {
      VS.toast("重载失败: " + e.message, "error");
    }
  }

  async function forceSave(tab) {
    try {
      const result = await VS.api("/api/file", {
        method: "PUT",
        body: { p: tab.path, content: tab.model.getValue() }, // no base → skip check
      });
      tab.sha = result.sha256;
      tab.conflict = null;
      setDirty(tab, false);
      hideConflict();
      VS.toast("已强制覆盖保存");
    } catch (e) {
      VS.toast("覆盖失败: " + e.message, "error");
    }
  }

  const banner = document.getElementById("conflict-banner");
  let conflictTab = null;
  function showConflict(tab, text) {
    conflictTab = tab;
    document.getElementById("conflict-text").textContent = text;
    banner.hidden = false;
  }
  function hideConflict() {
    banner.hidden = true;
    conflictTab = null;
  }
  document.getElementById("conflict-reload").addEventListener("click", () => {
    if (conflictTab) reloadFromDisk(conflictTab);
  });
  document.getElementById("conflict-overwrite").addEventListener("click", () => {
    if (conflictTab) forceSave(conflictTab);
  });
  document.getElementById("conflict-dismiss").addEventListener("click", hideConflict);

  // ── navigation / deep links ────────────────────────────────────────────────
  function gotoPosition(tab, line, col, sel) {
    tab.ed.revealLineInCenter(line);
    const pos = { lineNumber: Math.min(line, tab.model.getLineCount()), column: Math.max(1, col || 1) };
    tab.ed.setPosition(pos);
    tab.ed.focus();
    // flash highlight
    const range = sel
      ? parseSel(sel)
      : { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: 1, endColumn: Math.max(1, tab.model.getLineMaxColumn(pos.lineNumber)) };
    const dec = tab.ed.deltaDecorations([], [{
      range,
      options: { className: "vs-flash", isWholeLine: !sel, stickiness: 1 },
    }]);
    setTimeout(() => tab.ed.deltaDecorations(dec, []), 1600);
    updatePos(pos);
  }

  function parseSel(sel) {
    // "l.c-l.c"
    const [a, b] = sel.split("-");
    const [sl, sc] = a.split(".").map(Number);
    const [el2, ec] = (b || a).split(".").map(Number);
    return { startLineNumber: sl, startColumn: sc, endLineNumber: el2, endColumn: ec };
  }

  function updatePos(pos) {
    document.getElementById("sb-pos").textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
  }

  // ── external change handling (from watch WS) ───────────────────────────────
  function externalChange(path) {
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    if (!tab.dirty) {
      reloadFromDisk(tab); // silently refresh clean editors
    } else if (tab.conflict == null) {
      showConflict(tab, "你正在编辑的文件在磁盘上被外部修改了。");
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function basename(p) {
    return p.slice(p.lastIndexOf("/") + 1);
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (active) saveTab(active);
    }
  });
  document.getElementById("btn-save").addEventListener("click", () => {
    if (active) saveTab(active);
  });

  function openPaths() {
    return tabs.map((t) => t.path);
  }
  function notifyOpenChanged() {
    window.dispatchEvent(new Event("vs-open-changed"));
  }

  function setTheme(t) {
    curTheme = t === "dark" ? "vs-dark" : "vs";
    if (monacoReady) monaco.editor.setTheme(curTheme);
  }

  return {
    init, openFile, saveTab, reloadFromDisk, externalChange, gotoPosition,
    openPaths, notifyOpenChanged, setTheme,
    get active() { return active; }, get tabs() { return tabs; },
  };
})();
