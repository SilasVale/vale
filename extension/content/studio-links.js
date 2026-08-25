// studio-links.js — Vale Studio deep-link rewriter for dsh.saisi.online.
//
// Turns real workspace file paths appearing in DSH chat (tool-call headers,
// prose, code blocks) into one-click links that open the file at the right
// line in https://code.saisi.online.
//
// Design notes:
// - Relative paths are resolved against the server's whitelist roots via a
//   cheap /api/stat probe (no file contents transferred); results cached.
// - The original text node is replaced wholesale with a single <span> wrapper
//   so streaming appends never fight us; React-safe enough for chat surfaces,
//   and the options toggle turns the whole thing off if anything looks off.

(() => {
  const DEFAULT_ORIGIN = "https://code.saisi.online";
  const RX_TTL_MS = 5 * 60 * 1000;
  const ROOTS_TTL_MS = 60 * 1000;

  let cfg = { origin: DEFAULT_ORIGIN, token: "", enabled: true };
  let roots = null;
  let rootsAt = 0;
  /** path candidate -> { abs: string|null, at: number } */
  const resolvedCache = new Map();

  const PATH_RX =
    /(?:\/[A-Za-z0-9_.~-]+)+|(?:[A-Za-z0-9_.~-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:tsx?|mjs|cjs|jsx|rs|c|h|cpp|hpp|json|ya?ml|toml|md|sh|py|css|scss|html|sql|ini|conf|lock)/g;

  async function loadCfg() {
    try {
      const st = await chrome.storage.local.get(["studioOrigin", "studioToken", "studioLinksEnabled"]);
      cfg.origin = (st.studioOrigin || DEFAULT_ORIGIN).replace(/\/+$/, "");
      cfg.token = st.studioToken || "";
      cfg.enabled = st.studioLinksEnabled !== false;
    } catch {
      /* extension context gone */
    }
    return cfg.enabled;
  }

  function authHeaders() {
    return cfg.token ? { authorization: "Bearer " + cfg.token } : {};
  }

  async function getRoots() {
    if (roots && Date.now() - rootsAt < ROOTS_TTL_MS) return roots;
    try {
      const r = await fetch(cfg.origin + "/api/roots", { headers: authHeaders() });
      if (!r.ok) return (roots = []);
      const data = await r.json();
      rootsAt = Date.now();
      roots = (data.roots || []).map((x) => x.path);
    } catch {
      roots = [];
    }
    return roots;
  }

  async function exists(abs) {
    try {
      const r = await fetch(`${cfg.origin}/api/stat?p=${encodeURIComponent(abs)}`, {
        headers: authHeaders(),
      });
      if (!r.ok) return false;
      return !!(await r.json()).exists;
    } catch {
      return false;
    }
  }

  /** Resolve a raw path mention to an absolute workspace path, or null. */
  async function resolve(raw) {
    const hit = resolvedCache.get(raw);
    if (hit && Date.now() - hit.at < RX_TTL_MS) return hit.abs;
    let abs = null;
    const rs = await getRoots();
    if (raw.startsWith("/")) {
      // absolute: must live under one of the roots (or be reachable through them)
      if (rs.some((r) => raw === r || raw.startsWith(r.endsWith("/") ? r : r + "/"))) {
        abs = (await exists(raw)) ? raw : null;
      }
    } else if (rs.length) {
      // relative: probe root candidates, longest prefix first
      const candidates = [...rs].sort((a, b) => b.length - a.length).map((r) => `${r}/${raw}`);
      for (const cand of candidates.slice(0, 4)) {
        if (await exists(cand)) {
          abs = cand;
          break;
        }
      }
    }
    resolvedCache.set(raw, { abs, at: Date.now() });
    if (resolvedCache.size > 500) {
      const cutoff = Date.now() - RX_TTL_MS;
      for (const [k, v] of resolvedCache) if (v.at < cutoff) resolvedCache.delete(k);
    }
    return abs;
  }

  function deepUrl(abs, line) {
    let h = `#/open?p=${encodeURIComponent(abs)}`;
    if (line) h += `&l=${line}`;
    return `${cfg.origin}/${h}`;
  }

  function makeLink(text, abs, line) {
    const a = document.createElement("a");
    a.href = deepUrl(abs, line);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "vs-studio-link";
    a.textContent = text;
    a.title = "在 Vale Studio 中打开" + (line ? ` · 第 ${line} 行` : "");
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

  async function processRoot(rootEl) {
    if (!(await loadCfg())) return;
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
      if (!jobs.length) continue;

      // resolve all candidates first (cached), then assemble once
      const parts = [];
      for (const job of jobs) {
        const abs = await resolve(job.bare);
        if (!abs) continue;
        parts.push({ job, abs });
      }
      if (!parts.length) {
        node.nodeValue = text; // mark nothing; skip re-scan via parent flag
        node.parentElement?.setAttribute("data-vs-processed", "1");
        continue;
      }

      const span = document.createElement("span");
      span.setAttribute("data-vs-processed", "1");
      let cursor = 0;
      for (const { job, abs } of parts) {
        if (job.index > cursor) span.append(document.createTextNode(text.slice(cursor, job.index)));
        span.append(makeLink(job.raw, abs, job.lineNo));
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
    timer = setTimeout(async () => {
      timer = null;
      const batch = [...queue];
      queue.clear();
      for (const el of batch) {
        if (el && el.isConnected) await processRoot(el);
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
      if (area === "local" && (changes.studioOrigin || changes.studioToken || changes.studioLinksEnabled)) {
        roots = null;
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
