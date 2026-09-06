// studio-links.js — DSH chat path rewriter for code-server (vscode.saisi.online).
//
// Turns real workspace file paths appearing in DSH chat (tool-call headers,
// prose, code blocks) into one-click links that open the file's folder in
// code-server. Since the studio retirement (ADR 0006) there is NO studio API:
// resolution is purely LOCAL — absolute paths link as-is, relative paths are
// resolved against the configurable workspace base (default /home/zhengsaisi,
// the code-server workspace). code-server URLs open FOLDERS (not file+line —
// VS Code web has no line-level URL), so the line number rides in the tooltip.
//
// Failure posture: nothing here touches the network any more — a link that
// points at a non-existent path simply opens the folder. The processed flag
// is set unconditionally after a scan (no API outage can stall it).
// The options toggle turns the whole thing off if anything looks off.

(() => {
  // Distinct from null: reserved semantics no longer needed (no API), kept
  // only for the resolvedCache shape.
  let cfg = { origin: DEFAULT_STUDIO_ORIGIN, enabled: true };
  /** path candidate -> { dir: string, at: number } */
  const resolvedCache = new Map();
  const RX_TTL_MS = 5 * 60 * 1000;

  // A trailing :NN line number is part of the match (split off by the
  // caller into bare + lineNo for the tooltip).
  const PATH_RX =
    /(?:(?:\/[A-Za-z0-9_.~-]+)+|(?:[A-Za-z0-9_.~-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:tsx?|mjs|cjs|jsx|rs|c|h|cpp|hpp|json|ya?ml|toml|md|sh|py|css|scss|html|sql|ini|conf|lock))(?::\d+)?/g;

  async function loadCfg() {
    try {
      const st = await chrome.storage.local.get(["studioOrigin", "studioLinksEnabled"]);
      cfg.origin = httpsOrigin(st.studioOrigin || DEFAULT_STUDIO_ORIGIN) || DEFAULT_STUDIO_ORIGIN;
      cfg.enabled = st.studioLinksEnabled !== false;
    } catch {
      /* extension context gone */
    }
    return cfg.enabled;
  }

  /** Resolve a raw path mention to a folder URL under the workspace base.
   *  Absolute paths map directly; relative paths are joined onto the base.
   *  Best-effort by design: code-server opens the folder even when a file
   *  in the mention does not exist. */
  function resolve(raw) {
    const hit = resolvedCache.get(raw);
    if (hit && Date.now() - hit.at < RX_TTL_MS) return hit.dir;
    let dir;
    if (raw.startsWith("/")) {
      dir = raw.includes(".") && !raw.endsWith("/") ? raw.slice(0, raw.lastIndexOf("/")) : raw;
    } else {
      const base = "/home/zhengsaisi";
      dir = `${base}/${raw.replace(/\/+$/, "")}`;
      if (/\.[A-Za-z0-9]+$/.test(dir)) dir = dir.slice(0, dir.lastIndexOf("/"));
    }
    dir = dir.replace(/\/+$/, "") || "/";
    resolvedCache.set(raw, { dir, at: Date.now() });
    if (resolvedCache.size > 500) {
      const cutoff = Date.now() - RX_TTL_MS;
      for (const [k, v] of resolvedCache) if (v.at < cutoff) resolvedCache.delete(k);
    }
    return dir;
  }

  function deepUrl(dir, line) {
    // code-server opens folders: /?folder=<abs>. The line number cannot be
    // addressed via URL (VS Code web limitation) — it rides in the tooltip.
    return `${cfg.origin}/?folder=${encodeURIComponent(dir)}`;
  }

  function makeLink(text, dir, line) {
    const a = document.createElement("a");
    a.href = deepUrl(dir, line);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "vs-studio-link";
    a.textContent = text;
    a.title = "在 code-server 中打开该目录" + (line ? ` · 提到第 ${line} 行` : "");
    return a;
  }

  function shouldSkip(node) {
    const el = node.parentElement;
    if (!el) return true;
    if (el.closest("a, script, style, noscript, textarea")) return true;
    if (el.closest('[data-vs-processed="1"]')) return true;
    if (el.closest('[contenteditable="true"]')) return true; // never touch the composer
    return false;
  }

  function processRoot(rootEl) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeValue && n.nodeValue.trim().length > 3 && !shouldSkip(n)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const targets = [];
    let tn;
    while ((tn = walker.nextNode()) && targets.length < 400) targets.push(tn);

    for (const node of targets) {
      const text = node.nodeValue;
      PATH_RX.lastIndex = 0;
      const jobs = [];
      let m;
      while ((m = PATH_RX.exec(text))) {
        const raw = m[0];
        if (raw.length < 4) continue;
        if (!raw.includes("/") && !raw.slice(1).includes(".")) continue;
        const cm = raw.match(/:(\d+)$/);
        const bare = cm ? raw.slice(0, raw.length - cm[0].length) : raw;
        jobs.push({ raw, bare, lineNo: cm ? Number(cm[1]) : 0, index: m.index });
      }
      if (!jobs.length) {
        node.parentElement?.setAttribute("data-vs-processed", "1");
        continue;
      }

      const span = document.createElement("span");
      span.setAttribute("data-vs-processed", "1");
      let cursor = 0;
      for (const job of jobs) {
        if (job.index > cursor) span.append(document.createTextNode(text.slice(cursor, job.index)));
        span.append(makeLink(job.raw, resolve(job.bare), job.lineNo));
        cursor = job.index + job.raw.length;
      }
      if (cursor < text.length) span.append(document.createTextNode(text.slice(cursor)));

      try {
        node.replaceWith(span);
      } catch {
        /* node vanished mid-stream */
      }
    }
  }

  let timer = null;
  const queue = new Set();
  function scheduleScan(el) {
    if (el) queue.add(el);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const batch = [...queue];
      queue.clear();
      for (const el of batch) {
        if (el && el.isConnected) processRoot(el);
      }
    }, 400);
  }

  async function start() {
    if (!(await loadCfg())) return;
    scheduleScan(document.body);
    const mo = new MutationObserver((muts) => {
      for (const mu of muts) {
        if (mu.type !== "childList") continue;
        for (const n of mu.addedNodes) {
          if (n.nodeType === 1 && !n.closest?.('[data-vs-processed="1"]')) scheduleScan(n);
          else if (n.nodeType === 3) scheduleScan(n.parentElement);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // config changes apply without reload
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.studioOrigin || changes.studioLinksEnabled)) {
        resolvedCache.clear();
        loadCfg().then((on) => on && scheduleScan(document.body));
      }
    });
  }

  // inject a tiny stylesheet once
  const css = document.createElement("style");
  css.textContent =
    ".vs-studio-link{color:#0d9488;text-decoration:underline dotted;text-underline-offset:3px}" +
    ".vs-studio-link:hover{text-decoration-style:solid}";
  document.documentElement.append(css);

  start();
})();
