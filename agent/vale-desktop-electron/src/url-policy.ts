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

// Configurable agent port (custom-port installs): the shell follows the
// agent's config.yaml server.port (main.ts resolves it at boot via
// VALE_AGENT_PORT env, else the registry install/data dirs). Predicates
// below compare against the CONFIGURED origin — a hardcoded 18080 would
// deafen the IPC bridge and strand the desktop on any custom port.
// Default stays 18080 (canonical); tests reset via setAgentPort(18080).
let agentPort: number | null = null;
export function setAgentPort(port: number): void {
  if (Number.isInteger(port) && port > 0 && port < 65536) agentPort = port;
}
export function getAgentPort(): number {
  return agentPort ?? 18080;
}
export function agentBase(): string {
  return `http://127.0.0.1:${getAgentPort()}`;
}
function agentOrigin(): string {
  return new URL(agentBase()).origin;
}

// server.port out of an agent config.yaml (first `port:` inside the
// top-level `server:` section; null when absent/invalid). Pure so the
// shell's file/registry glue stays untestable-thin and this stays pinned.
export function parseAgentPort(yamlText: string): number | null {
  let inServer = false;
  for (const raw of String(yamlText || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\S/.test(line)) inServer = /^server\s*:/.test(line);
    if (!inServer) continue;
    const m = /^\s*port\s*:\s*"?(\d{1,5})"?\s*(?:#.*)?$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
      return null;
    }
  }
  return null;
}

export function isBaseOrigin(url: string): boolean {
  try { return new URL(url).origin === agentOrigin(); } catch { return false; }
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
    if (u.origin !== agentOrigin()) return false;
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
