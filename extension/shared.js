// shared.js — the single copy of constants and guards shared by the content
// script (content/studio-links.js) and the options page (options/options.js).
// Load order matters: it must run BEFORE both (first entry of the manifest
// content_scripts js array / first <script> in options.html). It must not
// touch chrome.* at load time — content scripts run in an isolated world
// where these top-level bindings are the cross-file channel.

const DEFAULT_STUDIO_ORIGIN = "https://code.saisi.online";

// Normalize to a bare https:// origin (path/query dropped), or null when the
// value is not a well-formed https:// URL. Canonical guard: the Studio token
// rides as a Bearer credential, so it must never attach to a cleartext
// http:// origin (MITM leak) or to something that isn't a URL at all.
function httpsOrigin(v) {
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

// Authorization headers for the Studio API — {} when there is no token or the
// origin fails the https guard (e.g. a stale/synced stored value that predates
// the options-page check).
function studioAuthHeaders(origin, token) {
  if (!token || !httpsOrigin(origin)) return {};
  return { authorization: "Bearer " + token };
}
