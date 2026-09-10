// shared.js — the single copy of constants and guards shared by the content
// script (content/studio-links.js) and the options page (options/options.js).
// Load order matters: it must run BEFORE both (first entry of the manifest
// content_scripts js array / first <script> in options.html). It must not
// touch chrome.* at load time — content scripts run in an isolated world
// where these top-level bindings are the cross-file channel.

const DEFAULT_STUDIO_ORIGIN = "https://vscode.saisi.online";

// Normalize to a bare https:// origin (path/query dropped), or null when the
// value is not a well-formed https:// URL. Canonical guard: the code-server
// session rides on browser cookies (Access + code-server password), so the
// origin must never be a cleartext http:// URL (MITM leak) or something that
// isn't a URL at all.
function httpsOrigin(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

// Path-mention → folder resolution (SOLID Round-96: verbatim core of the
// content script's resolve(), minus its TTL cache — cache lifetime belongs
// to the page, this mapping is pure). Absolute paths map directly (a file
// mention yields its folder); relative paths join onto the workspace base.
// Best-effort by design: code-server opens the folder even when the file
// does not exist.
function resolveDir(raw, base) {
  const root = base || "/home/zhengsaisi";
  let dir;
  if (raw.startsWith("/")) {
    dir = raw.includes(".") && !raw.endsWith("/") ? raw.slice(0, raw.lastIndexOf("/")) : raw;
  } else {
    dir = `${root}/${raw.replace(/\/+$/, "")}`;
    if (/\.[A-Za-z0-9]+$/.test(dir)) dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return dir.replace(/\/+$/, "") || "/";
}

// code-server opens folders: /?folder=<abs>. The line number cannot ride in
// the URL (VS Code web limitation) — callers put it in the tooltip.
function studioFolderUrl(origin, dir) {
  return `${origin}/?folder=${encodeURIComponent(dir)}`;
}

// Path-mention matcher (SOLID Round-96: verbatim core of the content
// script's per-node scan). A trailing :NN line number is part of the match;
// short (<4 chars) and extensionless-relative mentions are noise, skipped.
const PATH_RX =
  /(?:(?:\/[A-Za-z0-9_.~-]+)+|(?:[A-Za-z0-9_.~-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:tsx?|mjs|cjs|jsx|rs|c|h|cpp|hpp|json|ya?ml|toml|md|sh|py|css|scss|html|sql|ini|conf|lock))(?::\d+)?/g;

function extractPathJobs(text) {
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
  return jobs;
}

// Test seam (SOLID Round-24): expose the pure guards to node --test without
// changing browser semantics — classic <script> pages have no `module`, so
// this block is inert there; the extension CI job runs extension/test/.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEFAULT_STUDIO_ORIGIN, httpsOrigin, resolveDir, studioFolderUrl, extractPathJobs };
}

