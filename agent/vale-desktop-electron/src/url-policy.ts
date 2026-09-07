// Pure URL/origin policy for the desktop shell — extracted from main.ts so
// the security predicates carry unit tests (main.ts imports electron and is
// unimportable under plain node). SHIPPED ALONGSIDE main.js: the npm build
// chain copies it, and `vale update` stages + swaps it with main/preload.
//
// IPC audit #1 (HIGH): startsWith(BASE) was BYPASSABLE — the string
// 'http://127.0.0.1:18080@evil.com/x' passes the prefix test but Chromium
// parses its host as evil.com (userinfo trick). Every origin decision here
// compares the PARSED origin.

export const BASE = "http://127.0.0.1:18080";
export const BASE_ORIGIN = new URL(BASE).origin;

export function isBaseOrigin(url: string): boolean {
  try { return new URL(url).origin === BASE_ORIGIN; } catch { return false; }
}

// IPC audit #2: preload runs in EVERY frame; a frame may invoke the bridge
// only when its URL carries the pinned origin (main.ts feeds this the raw
// event.senderFrame.url).
export function frameUrlOk(url: string): boolean {
  return isBaseOrigin(url || "");
}

// Main-window tripwire allow-list (did-navigate backstop): the desktop SPA
// subtree of the base origin. STRING-PREFIX check (startsWith(BASE +
// "/desktop")) was the exact class IPC audit #1 flagged — compare the PARSED
// origin and the parsed pathname instead. data: (the wait page) and
// about:blank are handled by the caller.
export function isDesktopSpaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.origin !== BASE_ORIGIN) return false;
    // Segment semantics: /desktop and /desktop/* — /desktopx is a different
    // path, not the SPA mount.
    return u.pathname === "/desktop" || u.pathname.startsWith("/desktop/");
  } catch {
    return false;
  }
}

// Lab-device TLS bypass predicate (device-caught: OpenWrt-style
// self-signed defaults, e.g. the GPON ONT web UI, fail every navigation
// with ERR_CERT_AUTHORITY_INVALID). Private-network hosts MAY bypass cert
// errors; the public internet keeps full validation — a bypassed MITM on
// a lab LAN is contained, on the open web it is not. Pure + unit-tested;
// main.ts feeds it the raw certificate-error URL.
export function isPrivateHost(hostname: string): boolean {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (h.endsWith(".local") || h.endsWith(".local.")) return true;
  const parts = h.split(".");
  if (parts.length !== 4) return false;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
    nums.push(n);
  }
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

// Certificate-error gate for app.on("certificate-error"): true = bypass
// (preventDefault + callback(true)), false = deny. http(s) URLs on
// private hosts only — anything else (public hosts, weird schemes,
// unparsable input) stays fully validated.
export function certBypassAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(String(url || ""));
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return isPrivateHost(u.hostname);
}

// AI-opened browser windows must never reach file://, javascript: or
// arbitrary schemes through the CDP-driven session windows.
export function sanitizeBrowserUrl(url?: string): string {
  // stage-n preload audit LOW: coerce to string BEFORE trim() — a renderer
  // passing a number/object would throw TypeError in the main process (DoS).
  const t = String(url || "about:blank").trim();
  if (t === "about:blank") return t;
  try {
    const u = new URL(t);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch { /* fall through */ }
  return "about:blank";
}
