// tree.js — lazy-loading file explorer
"use strict";
window.VS = window.VS || {};

VS.tree = (() => {
  const el = document.getElementById("tree");
  const expanded = new Set();   // dir paths currently expanded
  let selected = null;          // selected file path
  let currentRoot = null;

  const FILE_ICONS = {
    ".ts": "🟦", ".tsx": "🟦", ".js": "🟨", ".mjs": "🟨", ".cjs": "🟨",
    ".rs": "🦀", ".c": "🔵", ".h": "🔵", ".cpp": "🔵", ".json": "🗂",
    ".yml": "⚙", ".yaml": "⚙", ".toml": "⚙", ".md": "📝", ".sh": "🖥",
    ".css": "🎨", ".html": "🌐", ".py": "🐍", ".lock": "🔒",
  };
  function iconFor(name, type) {
    if (type === "dir") return "📁";
    return FILE_ICONS[name.slice(name.lastIndexOf(".")).toLowerCase()] || "📄";
  }

  // ── mutations (context-menu actions) ───────────────────────────────────────
  let mutDebounce = null;
  function afterMutation() {
    clearTimeout(mutDebounce);
    mutDebounce = setTimeout(() => { if (VS.git) VS.git.refresh(); }, 500);
  }

  // Re-render one directory's children in place — keeps scroll position and
  // the rest of the tree untouched.
  async function refreshDir(dir) {
    if (!currentRoot || !dir) return;
    if (dir === currentRoot) return refresh();
    const nodes = rowFor(dir);
    if (!nodes || nodes.kids.hidden) return; // collapsed or not rendered
    nodes.kids.dataset.loaded = "1";
    await renderDir(dir, nodes.kids);
  }

  function parentOf(p) {
    return p.slice(0, p.replace(/\/$/, "").lastIndexOf("/")) || "/";
  }

  async function renamePath(p) {
    const oldName = p.replace(/\/$/, "").slice(p.replace(/\/$/, "").lastIndexOf("/") + 1);
    const newName = prompt("重命名为:", oldName);
    if (!newName || newName === oldName) return;
    const base = p.replace(/\/$/, "");
    const np = base.slice(0, base.lastIndexOf("/") + 1) + newName.replace(/^\/+/, "");
    try {
      await VS.api("/api/rename", { method: "POST", body: { from: base, to: np } });
      await refreshDir(parentOf(base));
      afterMutation();
    } catch (e) {
      VS.toast(e.code === "exists" ? "目标已存在" : e.message, "error");
    }
  }

  async function createIn(dir, isDir) {
    const name = prompt(isDir ? "新目录名（可含相对路径）:" : "新文件名（可含相对路径）:");
    if (!name) return;
    const p = dir.replace(/\/$/, "") + "/" + name.replace(/^\/+/, "");
    try {
      if (isDir) await VS.api("/api/mkdir", { method: "POST", body: { p } });
      else await VS.api("/api/file", { method: "PUT", body: { p, content: "", baseSha256: "new" } });
      await refreshDir(dir);
      afterMutation();
      if (!isDir) setTimeout(() => VS.editor.openFile(p), 100);
    } catch (e) {
      VS.toast(e.code === "conflict" ? "文件已存在" : e.message, "error");
    }
  }

  function copyText(t) {
    if (!navigator.clipboard) { VS.toast("剪贴板不可用", "error"); return; }
    navigator.clipboard.writeText(t).then(() => VS.toast("已复制"), () => {});
  }

  // External filesystem events (from the watch WS): structural events refresh
  // the affected directory so DSH-side writes appear without manual refresh.
  function externalEvent(msg) {
    if (!msg || !msg.path || msg.event === "change") return;
    refreshDir(parentOf(msg.path));
  }

  async function loadRoot(root) {
    currentRoot = root;
    expanded.clear();
    el.innerHTML = "";
    await renderDir(root, el);
  }

  async function renderDir(dir, container) {
    container.innerHTML = '<div class="tree-empty">加载中…</div>';
    try {
      const data = await VS.api(`/api/tree?dir=${encodeURIComponent(dir)}`);
      container.innerHTML = "";
      if (!data.entries.length) {
        container.innerHTML = '<div class="tree-empty">(空目录)</div>';
        return;
      }
      for (const entry of data.entries) renderEntry(entry, dir, container);
    } catch (e) {
      container.innerHTML = `<div class="tree-empty">加载失败: ${VS.escapeHtml(e.message)}</div>`;
    }
  }

  function rowFor(dir) {
    const row = findRow(el, dir);
    if (!row) return null;
    const kids = row.nextElementSibling;
    if (!kids || !kids.classList.contains("tree-children")) return null;
    return { row, kids };
  }

  // Explicit expansion primitive — the single source of truth for opening a
  // dir. Synthetic clicks proved racy: pre-marking `expanded` then clicking
  // made the handler immediately COLLAPSE the node.
  async function expandDir(dir) {
    if (expanded.has(dir)) return;
    const nodes = rowFor(dir);
    if (!nodes) return; // not rendered (parent not expanded yet)
    expanded.add(dir);
    nodes.kids.hidden = false;
    nodes.row.querySelector(".twist").textContent = "▾";
    if (!nodes.kids.dataset.loaded) {
      nodes.kids.dataset.loaded = "1";
      await renderDir(dir, nodes.kids);
    }
  }

  function collapseDir(dir) {
    const nodes = rowFor(dir);
    expanded.delete(dir);
    if (!nodes) return;
    nodes.kids.hidden = true;
    nodes.row.querySelector(".twist").textContent = "▸";
  }

  function renderEntry(entry, parentDir, container) {
    const full = parentDir.replace(/\/$/, "") + "/" + entry.name;
    const row = document.createElement("div");
    row.className = "tree-item";
    row.dataset.path = full;
    row.dataset.type = entry.type;

    const twist = document.createElement("span");
    twist.className = "twist";
    twist.textContent = entry.type === "dir" ? (expanded.has(full) ? "▾" : "▸") : "";

    const ic = document.createElement("span");
    ic.className = "ficon";
    ic.textContent = iconFor(entry.name, entry.type);

    const label = document.createElement("span");
    label.className = "name";
    label.textContent = entry.name;
    if (selected === full) row.classList.add("selected");

    row.append(twist, ic, label);
    paintBadge(row, full);

    if (entry.type === "dir") {
      const kids = document.createElement("div");
      kids.className = "tree-children";
      kids.hidden = true;
      row.addEventListener("click", () => {
        if (expanded.has(full)) collapseDir(full);
        else expandDir(full);
      });
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        VS.menu.show(ev.clientX, ev.clientY, [
          { label: "新建文件", act: () => createIn(full, false) },
          { label: "新建目录", act: () => createIn(full, true) },
          { label: "在此目录打开终端", act: () => VS.terminal.newTerminal(full) },
          { label: "重命名", act: () => renamePath(full) },
          { label: "复制路径", act: () => copyText(full) },
          { label: "删除（进回收站）", danger: true, act: () => removePath(full) },
        ]);
      });
      container.append(row, kids);
    } else {
      row.addEventListener("click", () => VS.editor.openFile(full));
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        VS.menu.show(ev.clientX, ev.clientY, [
          { label: "打开文件", act: () => VS.editor.openFile(full) },
          { label: "在此目录打开终端", act: () => VS.terminal.newTerminal(full.replace(/[^/]+$/, "")) },
          { label: "重命名", act: () => renamePath(full) },
          { label: "复制路径", act: () => copyText(full) },
          { label: "复制相对路径", act: () => copyText(currentRoot ? full.replace(currentRoot.replace(/\/$/, "") + "/", "") : full) },
          { label: "删除（进回收站）", danger: true, act: () => removePath(full) },
        ]);
      });
      container.append(row);
    }
  }

  async function removePath(p) {
    if (!confirm("把 " + p + " 移入回收站？")) return;
    try {
      await VS.api(`/api/file?p=${encodeURIComponent(p)}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      VS.toast(e.message, "error");
    }
  }

  function select(path) {
    selected = path;
    el.querySelectorAll(".tree-item").forEach((n) =>
      n.classList.toggle("selected", n.dataset.path === path));
  }

  // ── git badges ─────────────────────────────────────────────────────────────
  function paintBadge(row, full) {
    const code = VS.git ? VS.git.badge(full) : null;
    let span = row.querySelector(".git-badge");
    if (!code) {
      if (span) span.remove();
      return;
    }
    if (!span) {
      span = document.createElement("span");
      span.className = "git-badge";
      row.append(span);
    }
    span.dataset.code = code;
    span.textContent = code === "?" ? "U" : code;
  }

  // Re-stamp badges on already-rendered rows without refetching directories.
  function applyBadges() {
    el.querySelectorAll(".tree-item").forEach((row) => paintBadge(row, row.dataset.path));
  }

  // Re-render the visible tree preserving expansion state. Parents must be
  // re-expanded before their children exist, so walk in depth order.
  async function refresh() {
    if (!currentRoot) return;
    el.innerHTML = "";
    await renderDir(currentRoot, el);
    const dirs = [...expanded].sort(
      (a, b) => a.split("/").length - b.split("/").length,
    );
    for (const dir of dirs) {
      expanded.delete(dir); // expandDir early-returns otherwise
      await expandDir(dir);
    }
  }

  function findRow(container, path) {
    const rows = container.querySelectorAll(".tree-item");
    for (const r of rows) if (r.dataset.path === path) return r;
    return null;
  }

  async function waitForRow(p, tries = 15, delayMs = 60) {
    for (let i = 0; i < tries; i++) {
      const row = findRow(el, p);
      if (row) return row;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
  }

  // Reveal a file in the tree: expand ancestors (awaiting each render) and
  // select it. Bounded polling replaces the old fixed-sleep race.
  async function reveal(filePath) {
    const parts = filePath.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc += "/" + parts[i];
      if (!expanded.has(acc)) {
        await waitForRow(acc, 8, 70);
        await expandDir(acc).catch(() => {});
      }
    }
    select(filePath);
    const target = await waitForRow(filePath, 10, 70);
    if (target) target.scrollIntoView({ block: "nearest" });
  }

  return {
    loadRoot, refresh, reveal, select, applyBadges, externalEvent, createIn,
    get root() { return currentRoot; },
  };
})();

// toast helper lives here too
VS.toast = function (msg, kind) {
  const layer = document.getElementById("toast-layer");
  const t = document.createElement("div");
  t.className = "toast" + (kind === "error" ? " error" : "");
  t.textContent = msg;
  layer.append(t);
  setTimeout(() => t.remove(), 4200);
};
