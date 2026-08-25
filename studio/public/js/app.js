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
  });
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
    });
  });
  function switchView(name) {
    document.querySelector(`.act-btn[data-view="${name}"]`).click();
  }

  // ── search view ────────────────────────────────────────────────────────────
  let searchSeq = 0;
  $("#search-input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    runSearch();
  });
  async function runSearch() {
    const seq = ++searchSeq;
    const q = $("#search-input").value;
    const box = $("#search-results");
    if (!q) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="tree-empty">搜索中…</div>';
    try {
      const data = await VS.api(
        `/api/search?q=${encodeURIComponent(q)}&root=${encodeURIComponent(currentRoot())}` +
        `&regex=${$("#search-regex").checked ? 1 : 0}&case=${$("#search-case").checked ? 1 : 0}`,
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
      for (const [file, hits] of byFile) {
        const head = document.createElement("div");
        head.className = "sr-file";
        head.textContent = `${file.replace(currentRoot() + "/", "")} (${hits.length})`;
        box.append(head);
        for (const hit of hits.slice(0, 12)) {
          const b = document.createElement("button");
          b.className = "sr-hit";
          const esc = hit.text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
          b.innerHTML = `${hit.line}: ${esc}`;
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

  // ── quick open ─────────────────────────────────────────────────────────────
  let fileCache = null;
  async function allFiles() {
    if (!fileCache) {
      const data = await VS.api(`/api/files?root=${encodeURIComponent(currentRoot())}`);
      fileCache = data.files.map((f) => ({
        path: f,
        base: f.slice(f.lastIndexOf("/") + 1).toLowerCase(),
      }));
    }
    return fileCache;
  }
  const qo = $("#quickopen");
  const qoInput = $("#quickopen-input");
  const qoList = $("#quickopen-list");
  let qoItems = [];
  let qoSel = 0;

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

  function renderQO(filter) {
    const f = filter.toLowerCase();
    qoItems = fileCache
      ? fileCache.filter((x) => !f || x.base.includes(f) || x.path.toLowerCase().includes(f)).slice(0, 60)
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
    VS.editor.openFile(it.path);
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
  $("#btn-newfile").addEventListener("click", () => createNode(false));
  $("#btn-newdir").addEventListener("click", () => createNode(true));
  async function createNode(isDir) {
    const name = prompt(isDir ? "新目录名（可含相对路径）:" : "新文件名（可含相对路径）:");
    if (!name) return;
    const p = currentRoot().replace(/\/$/, "") + "/" + name.replace(/^\/+/, "");
    try {
      if (isDir) await VS.api("/api/mkdir", { method: "POST", body: { p } });
      else await VS.api("/api/file", { method: "PUT", body: { p, content: "", baseSha256: "new" } });
      VS.tree.refresh();
      if (!isDir) setTimeout(() => VS.editor.openFile(p), 150);
    } catch (e) {
      VS.toast(e.code === "conflict" ? "文件已存在" : e.message, "error");
    }
  }

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
        if (msg.path && msg.event) VS.editor.externalChange(msg.path);
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
    if (!document.hidden && boot) updateGitInfo();
  });
})();
