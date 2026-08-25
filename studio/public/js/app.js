// app.js — boot sequence, hash routing (deep links), views, quick open, search UI
"use strict";

(async function main() {
  const $ = (s) => document.querySelector(s);

  // ── boot + token gate ──────────────────────────────────────────────────────
  let boot = null;
  const mark = (m) => {
    (window.__vsDbg = window.__vsDbg || []).push(m);
    document.title = `VS ${m}`.slice(0, 70);
  };
  async function tryBoot() {
    try {
      boot = await VS.api("/api/boot");
      mark("boot-ok");
      return true;
    } catch (e) {
      mark(`boot-fail:${e.status || "?"}:${e.message}`.slice(0, 55));
      return false;
    }
  }

  function showGate() {
    $("#token-gate").hidden = false;
    $("#gate-token").focus();
  }

  $("#gate-go").addEventListener("click", submitToken);
  $("#gate-token").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitToken();
  });
  async function submitToken() {
    mark(`submit:len=${$("#gate-token").value.length}`);
    try {
      VS.token = $("#gate-token").value.trim();
      if (await tryBoot()) {
        localStorage.setItem("vale-studio-token", VS.token);
        $("#token-gate").hidden = true;
        afterBoot();
      } else {
        $("#gate-err").textContent = "令牌无效，请检查服务端 config.json";
      }
    } catch (e) {
      $("#gate-err").textContent = "出错: " + e.message;
    }
  }

  $("#btn-forget-token").addEventListener("click", () => {
    localStorage.removeItem("vale-studio-token");
    VS.toast("已清除本机令牌");
  });

  $("#btn-wordwrap").addEventListener("click", () => VS.editor.toggleWordWrap());

  // ── theme toggle ───────────────────────────────────────────────────────────
  const themeBtn = $("#btn-theme");
  function paintThemeBtn() {
    themeBtn.textContent = document.documentElement.dataset.theme === "dark" ? "☀️" : "🌙";
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("vs-theme", t);
    VS.editor.setTheme(t);
    VS.terminal.setTheme(t);
    paintThemeBtn();
  }
  themeBtn.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  paintThemeBtn();

  // ── deep-link routing ──────────────────────────────────────────────────────
  // #/open?p=<abs>&l=596&c=8&sel=l.c-l.c
  let lastHash = null;

  // ── one-click token bootstrap ──────────────────────────────────────────────
  // /?token=<t> logs the browser in without typing: adopt the token, persist
  // it, then strip it from the address bar (history entry replaced).
  function bootstrapTokenFromUrl() {
    const q = new URLSearchParams(location.search);
    const t = q.get("token");
    if (!t) return false;
    VS.token = t.trim();
    localStorage.setItem("vale-studio-token", VS.token);
    q.delete("token");
    const rest = q.toString();
    const cleaned = location.pathname + (rest ? "?" + rest : "") + location.hash;
    history.replaceState(null, "", cleaned);
    return true;
  }

  function handleHash() {
    if (location.hash === lastHash) return; // native + manual events may double-fire
    lastHash = location.hash;
    const h = location.hash || "";
    const m = h.match(/^#\/open\?(.*)$/);
    if (!m) return;
    const q = new URLSearchParams(m[1]);
    const p = q.get("p");
    if (!p) return;
    VS.editor.openFile(p, {
      line: q.get("l") ? Number(q.get("l")) : undefined,
      col: q.get("c") ? Number(q.get("c")) : undefined,
      sel: q.get("sel") || undefined,
    });
  }
  window.addEventListener("hashchange", handleHash);

  // ── roots selector ─────────────────────────────────────────────────────────
  function fillRoots() {
    const sel = $("#root-select");
    sel.innerHTML = "";
    for (const r of boot.roots) {
      const opt = document.createElement("option");
      opt.value = r.path;
      opt.textContent = r.name + " — " + r.path;
      sel.append(opt);
    }
    updateGitInfo();
  }
  function currentRoot() {
    return $("#root-select").value;
  }
  $("#root-select").addEventListener("change", () => {
    VS.tree.loadRoot(currentRoot());
    updateGitInfo();
    fileCache = null; // bust quick-open cache
    $("#sb-root").textContent = currentRoot();
    VS.git.refresh(); // badges + SCM view follow the selected root
  });

  // Re-pull /api/boot so branch/dirty counts reflect reality; keeps the
  // user's current root selected.
  async function refreshRoots() {
    try {
      const fresh = await VS.api("/api/boot");
      boot = fresh;
      fillRoots();
      $("#sb-root").textContent = currentRoot();
    } catch (e) { /* offline blip — keep stale labels */ }
  }

  async function updateGitInfo() {
    const r = boot.roots.find((x) => x.path === currentRoot());
    $("#root-git").textContent = r && r.git ? `⑂ ${r.branch}${r.dirty ? ` · ${r.dirty} changed` : ""}` : "";
  }

  // ── activity bar / views ───────────────────────────────────────────────────
  document.querySelectorAll(".act-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".act-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.view;
      for (const v of document.querySelectorAll(".side-view")) v.hidden = v.id !== "view-" + view;
      if (view === "search") $("#search-input").focus();
      if (view === "git") VS.git.refresh();
    });
  });
  function switchView(name) {
    document.querySelector(`.act-btn[data-view="${name}"]`).click();
  }

  // ── search view ────────────────────────────────────────────────────────────
  let searchSeq = 0;

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  // Escape-then-wrap: matches are wrapped in <mark> on the RAW text so the
  // output stays injection-safe even for regex queries.
  function highlightLine(text, q, regex, ignoreCase) {
    const flags = "g" + (ignoreCase ? "i" : "");
    let re;
    try {
      re = regex
        ? new RegExp(q, flags)
        : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch {
      return escapeHtml(text);
    }
    let out = "";
    let last = 0;
    for (let m; (m = re.exec(text)); ) {
      if (!m[0].length) { re.lastIndex++; continue; } // zero-width guard
      out += escapeHtml(text.slice(last, m.index)) + "<mark>" + escapeHtml(m[0]) + "</mark>";
      last = m.index + m[0].length;
      if (out.length > 4000) break;
    }
    return out + escapeHtml(text.slice(last));
  }

  async function runSearch() {
    const seq = ++searchSeq;
    const q = $("#search-input").value;
    const box = $("#search-results");
    if (!q) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="tree-empty">搜索中…</div>';
    const regexOn = $("#search-regex").checked;
    const caseOn = $("#search-case").checked;
    try {
      const data = await VS.api(
        `/api/search?q=${encodeURIComponent(q)}&root=${encodeURIComponent(currentRoot())}` +
        `&regex=${regexOn ? 1 : 0}&case=${caseOn ? 1 : 0}`,
      );
      if (seq !== searchSeq) return; // stale
      box.innerHTML = "";
      if (!data.matches.length) {
        box.innerHTML = '<div class="tree-empty">无结果</div>';
        return;
      }
      const byFile = new Map();
      for (const hit of data.matches) {
        if (!byFile.has(hit.path)) byFile.set(hit.path, []);
        byFile.get(hit.path).push(hit);
      }
      const head = document.createElement("div");
      head.className = "sr-summary";
      head.textContent =
        `${data.matches.length} 处 · ${byFile.size} 个文件` +
        (data.truncated ? "（已达上限，结果被截断）" : "");
      box.append(head);
      for (const [file, hits] of byFile) {
        const fh = document.createElement("div");
        fh.className = "sr-file";
        fh.textContent = `${file.replace(currentRoot() + "/", "")} (${hits.length})`;
        box.append(fh);
        for (const hit of hits.slice(0, 12)) {
          const b = document.createElement("button");
          b.className = "sr-hit";
          b.innerHTML = `${hit.line}: ${highlightLine(hit.text, q, regexOn, !caseOn)}`;
          b.addEventListener("click", () =>
            VS.editor.openFile(hit.path, { line: hit.line }));
          box.append(b);
        }
        if (hits.length > 12) {
          const more = document.createElement("div");
          more.className = "tree-empty";
          more.style.paddingLeft = "18px";
          more.textContent = `…还有 ${hits.length - 12} 条`;
          box.append(more);
        }
      }
    } catch (e) {
      if (seq === searchSeq) box.innerHTML = `<div class="tree-empty">搜索失败: ${e.message}</div>`;
    }
  }

  // live search as you type (debounced); Enter still forces an immediate run
  let searchDebounce = null;
  $("#search-input").addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runSearch, 350);
  });
  $("#search-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    clearTimeout(searchDebounce);
    runSearch();
  });

  // ── quick open ─────────────────────────────────────────────────────────────
  // Supports "name", "dir/name", "name:42" (jump to line) and shows recently
  // opened files first when the filter is empty.
  let fileCache = null;
  async function allFiles() {
    if (!fileCache) {
      const data = await VS.api(`/api/files?root=${encodeURIComponent(currentRoot())}`);
      fileCache = data.files.map((f) => ({
        path: f,
        base: f.slice(f.lastIndexOf("/") + 1).toLowerCase(),
        lc: f.toLowerCase(),
      }));
    }
    return fileCache;
  }
  function recents() {
    try {
      const raw = JSON.parse(localStorage.getItem("vs-recents") || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  const qo = $("#quickopen");
  const qoInput = $("#quickopen-input");
  const qoList = $("#quickopen-list");
  let qoItems = [];
  let qoSel = 0;
  let qoLine = null;

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p" && !e.shiftKey) {
      e.preventDefault();
      openQuickOpen();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      switchView("search");
      $("#search-input").focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "`") {
      e.preventDefault();
      VS.terminal.toggle();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault(); // toggle sidebar, VS Code parity
      $("#sidebar").hidden = !$("#sidebar").hidden;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
      e.preventDefault(); // toggle terminal panel
      VS.terminal.toggle();
    } else if (e.key === "Escape") {
      qo.hidden = true;
      hideMenu();
    }
  });

  async function openQuickOpen() {
    qo.hidden = false;
    qoInput.value = "";
    qoList.innerHTML = '<div class="tree-empty">加载文件列表…</div>';
    try {
      await allFiles();
      renderQO(qoInput.value); // honor anything typed while the list was loading
    } catch (e) {
      qoList.innerHTML = `<div class="tree-empty">${e.message}</div>`;
    }
    qoInput.focus();
  }

  function scoreItem(it, f) {
    // 0 = basename exact · 1 = basename prefix · 2 = basename contains
    // 3 = path contains · -1 = no match
    if (!f) {
      const r = recents().indexOf(it.path);
      return r >= 0 ? -(1000 - r) : 50 + Math.min(it.lc.length, 99); // recents first
    }
    if (it.base === f) return 0;
    if (it.base.startsWith(f)) return 1;
    if (it.base.includes(f)) return 2;
    if (it.lc.includes(f)) return 3;
    return -1;
  }

  function renderQO(filter) {
    let f = filter.toLowerCase();
    qoLine = null;
    const m = filter.match(/^(.+?):(\d+)$/);
    if (m) { f = m[1].toLowerCase(); qoLine = Number(m[2]); }
    qoItems = fileCache
      ? fileCache
          .map((x) => ({ x, s: scoreItem(x, f) }))
          .filter(({ s }) => s >= 0)
          .sort((a, b) => a.s - b.s || a.x.lc.length - b.x.lc.length)
          .slice(0, 60)
          .map(({ x }) => x)
      : [];
    qoSel = 0;
    qoList.innerHTML = "";
    for (let i = 0; i < qoItems.length; i++) {
      const it = qoItems[i];
      const b = document.createElement("button");
      b.className = "qo-item" + (i === qoSel ? " selected" : "");
      b.innerHTML =
        `<b>${it.base.replace(/[&<>]/g, "")}</b><span class="dir">${it.path
          .slice(0, -it.base.length)
          .replace(/\/$/, "")
          .replace(/[&<>]/g, "")}</span>`;
      b.addEventListener("click", () => pickQO(i));
      qoList.append(b);
    }
    if (!qoItems.length) qoList.innerHTML = '<div class="tree-empty">(无匹配)</div>';
  }
  function pickQO(i) {
    const it = qoItems[i];
    if (!it) return;
    qo.hidden = true;
    VS.editor.openFile(it.path, qoLine ? { line: qoLine } : {});
  }
  qoInput.addEventListener("input", () => renderQO(qoInput.value));
  qoInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { qoSel = Math.min(qoSel + 1, qoItems.length - 1); paintSel(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { qoSel = Math.max(qoSel - 1, 0); paintSel(); e.preventDefault(); }
    else if (e.key === "Enter") pickQO(qoSel);
  });
  function paintSel() {
    qoList.querySelectorAll(".qo-item").forEach((n, i) => n.classList.toggle("selected", i === qoSel));
  }

  // ── tree toolbar ───────────────────────────────────────────────────────────
  $("#btn-refresh").addEventListener("click", () => { VS.tree.refresh(); fileCache = null; });
  $("#btn-newfile").addEventListener("click", () => VS.tree.createIn(currentRoot(), false));
  $("#btn-newdir").addEventListener("click", () => VS.tree.createIn(currentRoot(), true));

  // ── context menu plumbing ──────────────────────────────────────────────────
  const menuEl = $("#ctxmenu");
  function hideMenu() { menuEl.hidden = true; }
  VS.menu = {
    show(x, y, items) {
      menuEl.innerHTML = "";
      for (const it of items) {
        const b = document.createElement("button");
        b.textContent = it.label;
        if (it.danger) b.style.color = "var(--danger)";
        b.addEventListener("click", () => { hideMenu(); it.act(); });
        menuEl.append(b);
      }
      menuEl.hidden = false;
      menuEl.style.left = Math.min(x, innerWidth - 200) + "px";
      menuEl.style.top = Math.min(y, innerHeight - items.length * 32 - 10) + "px";
    },
  };
  document.addEventListener("click", hideMenu);

  // ── git integration ────────────────────────────────────────────────────────
  // Parses `git status --porcelain -b` once per root, then feeds three UIs:
  // the source-control sidebar, file-tree badges, and the activity-bar dot.
  const gitState = { top: null, branch: "", changes: new Map() }; // abspath -> code
  let gitSeq = 0;

  function unquoteGitPath(p) {
    if (p.startsWith('"') && p.endsWith('"')) {
      try { return JSON.parse(p); } catch { return p.slice(1, -1); }
    }
    return p;
  }

  function parseStatus(text, top) {
    const changes = new Map();
    let branch = "";
    for (const raw of String(text || "").split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line) continue;
      if (line.startsWith("## ")) {
        branch = line.slice(3).split("...")[0].replace(/\s+\[.*$/, "").trim();
        continue;
      }
      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      let rel = line.slice(3);
      const arrow = rel.indexOf(" -> ");
      if (arrow >= 0) rel = rel.slice(arrow + 4); // renames point at the new path
      rel = unquoteGitPath(rel);
      const code = x === "?" ? "?" : x !== " " ? x : y;
      changes.set(top.replace(/\/$/, "") + "/" + rel, code);
    }
    return { branch, changes };
  }

  async function gitRefresh() {
    const seq = ++gitSeq;
    const root = currentRoot();
    let ok = false;
    try {
      const data = await VS.api(`/api/git/status?p=${encodeURIComponent(root)}`);
      if (seq !== gitSeq) return;
      const parsed = parseStatus(data.status, data.top);
      gitState.top = data.top;
      gitState.branch = parsed.branch;
      gitState.changes = parsed.changes;
      ok = true;
    } catch (e) { /* not a repo — fall through to empty state */ }
    if (seq !== gitSeq) return;
    if (!ok) {
      gitState.top = null; gitState.branch = ""; gitState.changes = new Map();
    }
    paintGitView(ok);
    if (VS.tree.applyBadges) VS.tree.applyBadges();
    const badge = $("#act-git-badge");
    const n = gitState.changes.size;
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? "99+" : String(n);
  }

  function paintGitView(hasRepo) {
    const head = $("#git-branch");
    const list = $("#git-changes");
    list.innerHTML = "";
    if (!hasRepo) {
      head.textContent = "";
      list.innerHTML = '<div class="tree-empty">当前根目录不在 git 仓库内</div>';
      return;
    }
    head.textContent = `⑂ ${gitState.branch || "HEAD"} · ${gitState.changes.size} 个变更`;
    if (!gitState.changes.size) {
      list.innerHTML = '<div class="tree-empty">工作区干净 ✓</div>';
      return;
    }
    const rel = (p) => (gitState.top && p.startsWith(gitState.top + "/"))
      ? p.slice(gitState.top.length + 1) : p;
    for (const [p, code] of gitState.changes) {
      const b = document.createElement("button");
      b.className = "git-change";
      const badge = document.createElement("span");
      badge.className = "git-badge";
      badge.dataset.code = code;
      badge.textContent = code === "?" ? "U" : code;
      const path = document.createElement("span");
      path.className = "gc-path";
      path.textContent = rel(p);
      path.title = p;
      b.append(badge, path);
      b.addEventListener("click", () => VS.editor.openFile(p));
      list.append(b);
    }
  }

  $("#btn-git-refresh").addEventListener("click", () => gitRefresh());
  let gitDebounce = null;
  window.addEventListener("vs-saved", () => {
    clearTimeout(gitDebounce);
    gitDebounce = setTimeout(() => { gitRefresh(); }, 600); // settle bursts of saves
  });

  // expose for editor.js gutter + tree badges
  VS.git = {
    refresh: gitRefresh,
    badge: (p) => gitState.changes.get(p) || null,
    get changes() { return gitState.changes; },
    get top() { return gitState.top; },
    get branch() { return gitState.branch; },
  };

  // ── watch WS ───────────────────────────────────────────────────────────────
  // Targeted watching: tell the server which files are open; it watches only
  // those directories and pushes external-change events back.
  let watchWs = null;
  function sendOpenFiles() {
    if (watchWs && watchWs.readyState === 1) {
      watchWs.send(JSON.stringify({ open: VS.editor.openPaths() }));
    }
  }
  window.addEventListener("vs-open-changed", () => setTimeout(sendOpenFiles, 50));
  function connectWatch() {
    watchWs = new WebSocket(VS.wsUrl("/api/watch"));
    watchWs.onopen = sendOpenFiles;
    watchWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.path && msg.event) {
          VS.editor.externalChange(msg.path);
          VS.tree.externalEvent(msg); // structural events refresh the tree in place
          if (msg.event !== "change") {
            clearTimeout(gitDebounce);
            gitDebounce = setTimeout(() => { VS.git.refresh(); }, 600);
          }
        }
      } catch (e) {}
    };
    watchWs.onclose = () => {
      watchWs = null;
      setTimeout(connectWatch, 3000);
    };
  }

  // ── boot flow ──────────────────────────────────────────────────────────────
  function afterBoot() {
    fillRoots();
    $("#sb-root").textContent = currentRoot();
    $("#sb-backend").textContent = "vale-studio";
    if (boot.readOnly) $("#btn-readonly-hint").hidden = false;
    $("#settings-server").textContent = `服务器: ${location.host} · 只读: ${boot.readOnly ? "是" : "否"} · 终端: ${boot.terminalEnabled ? "开" : "关"}`;
    VS.editor.init();
    VS.tree.loadRoot(currentRoot());
    connectWatch();
    gitRefresh();
    handleHash(); // honor deep link on first paint
  }

  // One-click link: /?token=… adopts the token before the first boot attempt.
  bootstrapTokenFromUrl();
  if (!(await tryBoot())) showGate();
  else {
    $("#token-gate").hidden = true; // auto-login via stored/bootstrap token
    afterBoot();
  }

  // refresh git info when switching back to the tab (cheap heuristic)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && boot) { refreshRoots(); VS.git.refresh(); }
  });

  // guard against losing unsaved buffers to an accidental reload/close
  window.addEventListener("beforeunload", (e) => {
    if (!boot || !VS.editor.tabs.some((t) => t.dirty || t.conflict)) return;
    e.preventDefault();
    e.returnValue = "";
  });
})();
