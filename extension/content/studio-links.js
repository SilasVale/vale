// studio-links.js — Vale Studio deep-link rewriter for dsh.saisi.online.
//
// Turns real workspace file paths appearing in DSH chat (tool-call headers,
// prose, code blocks) into one-click links that open the file at the right
// line in https://code.saisi.online.
//
// Design notes:
// - Relative paths are resolved against the server's whitelist roots via a
//   cheap /api/stat probe (no file contents transferred); results cached.
// - Studio API outages are never permanent: a failed fetch warns once and
//   leaves text unflagged so a later scan retries; only a scan that ran and
//   genuinely resolved nothing is marked data-vs-processed (the perf flag).
// - The original text node is replaced wholesale with a single <span> wrapper
//   so streaming appends never fight us; React-safe enough for chat surfaces,
//   and the options toggle turns the whole thing off if anything looks off.

(() => {
  const RX_TTL_MS = 5 * 60 * 1000;
  const ROOTS_TTL_MS = 60 * 1000;
  // Distinct from null: "the Studio API could not be asked" (network error or
  // non-OK status), where null means a definitive "no link here". Never cached.
  const UNREACHABLE = Symbol("vs-unreachable");

  let cfg = { origin: DEFAULT_STUDIO_ORIGIN, token: "", enabled: true };
  let roots = null;
  let rootsAt = 0;
  let rootsWarned = false; // warn-once latch for the current /api/roots outage
  /** path candidate -> { abs: string|null, at: number } */
  const resolvedCache = new Map();

  // A trailing :NN line number is part of the match (split off by the
  // caller into bare + lineNo for the deep link).
  const PATH_RX =
    /(?:(?:\/[A-Za-z0-9_.~-]+)+|(?:[A-Za-z0-9_.~-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:tsx?|mjs|cjs|jsx|rs|c|h|cpp|hpp|json|ya?ml|toml|md|sh|py|css|scss|html|sql|ini|conf|lock))(?::\d+)?/g;

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

  // Defensive: never attach the Bearer token to a non-https origin — a
  // stale/synced stored value could predate the options-page https check.
  // The canonical guard lives in shared.js (single copy).
  function authHeaders() {
    return studioAuthHeaders(cfg.origin, cfg.token);
  }

  // A failed /api/roots fetch tells the user once per outage, not per node.
  function warnRootsDown(reason) {
    if (rootsWarned) return;
    rootsWarned = true;
    console.warn(
      `[Vale Studio Links] cannot reach ${cfg.origin}/api/roots (${reason}) — ` +
        "path linking is paused; text is left unmarked and will be re-scanned " +
        "once the Studio API answers again."
    );
  }

  // Returns the whitelisted roots, or null when the server could not be asked
  // (network error / non-OK status), so callers can tell "no roots configured"
  // from "couldn't ask" and never memorize an outage as a definitive answer.
  async function getRoots() {
    if (roots && Date.now() - rootsAt < ROOTS_TTL_MS) return roots;
    try {
      const r = await fetch(cfg.origin + "/api/roots", { headers: authHeaders() });
      if (!r.ok) {
        warnRootsDown(r.status === 401 ? "HTTP 401 — token rejected" : `HTTP ${r.status}`);
        return null;
      }
      const data = await r.json();
      roots = (data.roots || []).map((x) => x.path);
      rootsAt = Date.now();
      rootsWarned = false; // recovered — a later outage warns again
      return roots;
    } catch (e) {
      warnRootsDown(e && e.message ? e.message : "network error");
      return null;
    }
  }

  // Definitive true/false, or null when the server could not be asked —
  // "unknown" must never be read as "missing".
  async function exists(abs) {
    let r;
    try {
      r = await fetch(`${cfg.origin}/api/stat?p=${encodeURIComponent(abs)}`, {
        headers: authHeaders(),
      });
    } catch {
      return null;
    }
    if (!r.ok) return null;
    try {
      return !!(await r.json()).exists;
    } catch {
      return null; // malformed body — unknown, not missing
    }
  }

  /** Resolve a raw path mention to an absolute workspace path.
   * null = definitive "no link"; UNREACHABLE = couldn't ask (not cached, so
   * the next scan retries instead of memorizing the outage). */
  async function resolve(raw) {
    const hit = resolvedCache.get(raw);
    if (hit && Date.now() - hit.at < RX_TTL_MS) return hit.abs;
    const rs = await getRoots();
    if (rs === null) return UNREACHABLE;
    let abs = null;
    if (raw.startsWith("/")) {
      // absolute: must live under one of the roots (or be reachable through them)
      if (rs.some((r) => raw === r || raw.startsWith(r.endsWith("/") ? r : r + "/"))) {
        const there = await exists(raw);
        if (there === null) return UNREACHABLE;
        abs = there ? raw : null;
      }
    } else if (rs.length) {
      // relative: probe root candidates, longest prefix first
      const candidates = [...rs].sort((a, b) => b.length - a.length).map((r) => `${r}/${raw}`);
      for (const cand of candidates.slice(0, 4)) {
        const there = await exists(cand);
        if (there === null) return UNREACHABLE;
        if (there) {
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
      let couldAsk = true; // did every Studio probe for this node get an answer?
      const parts = [];
      for (const job of jobs) {
        const abs = await resolve(job.bare);
        if (abs === UNREACHABLE) {
          couldAsk = false; // couldn't ask — never mark this node as done
          continue;
        }
        if (!abs) continue;
        parts.push({ job, abs });
      }
      if (!parts.length) {
        if (couldAsk) {
          // The scan ran and genuinely resolved nothing — flag the parent so
          // shouldSkip() never re-walks it (the perf mechanism).
          node.parentElement?.setAttribute("data-vs-processed", "1");
        }
        // else: the API was unreachable — leave unflagged so a later scan retries.
        continue;
      }

      const span = document.createElement("span");
      if (couldAsk) span.setAttribute("data-vs-processed", "1");
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
