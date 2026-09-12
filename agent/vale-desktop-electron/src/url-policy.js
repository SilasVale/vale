"use strict";
// Pure URL/origin policy for the desktop shell — extracted from main.ts so
// the security predicates carry unit tests (main.ts imports electron and is
// unimportable under plain node). SHIPPED ALONGSIDE main.js: the npm build
// chain copies it, and `vale update` stages + swaps it with main/preload.
//
// IPC audit #1 (HIGH): startsWith(BASE) was BYPASSABLE — the string
// 'http://127.0.0.1:18080@evil.com/x' passes the prefix test but Chromium
// parses its host as evil.com (userinfo trick). Every origin decision here
// compares the PARSED origin.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_ORIGIN = exports.BASE = void 0;
exports.setAgentPort = setAgentPort;
exports.getAgentPort = getAgentPort;
exports.agentBase = agentBase;
exports.parseAgentPort = parseAgentPort;
exports.isBaseOrigin = isBaseOrigin;
exports.frameUrlOk = frameUrlOk;
exports.controlOriginOk = controlOriginOk;
exports.isDesktopSpaUrl = isDesktopSpaUrl;
exports.isPrivateHost = isPrivateHost;
exports.certBypassAllowed = certBypassAllowed;
exports.sanitizeBrowserUrl = sanitizeBrowserUrl;
exports.BASE = "http://127.0.0.1:18080";
exports.BASE_ORIGIN = new URL(exports.BASE).origin;
// Configurable agent port (custom-port installs): the shell follows the
// agent's config.yaml server.port (main.ts resolves it at boot via
// VALE_AGENT_PORT env, else the registry install/data dirs). Predicates
// below compare against the CONFIGURED origin — a hardcoded 18080 would
// deafen the IPC bridge and strand the desktop on any custom port.
// Default stays 18080 (canonical); tests reset via setAgentPort(18080).
let agentPort = null;
function setAgentPort(port) {
    if (Number.isInteger(port) && port > 0 && port < 65536)
        agentPort = port;
}
function getAgentPort() {
    return agentPort ?? 18080;
}
function agentBase() {
    return `http://127.0.0.1:${getAgentPort()}`;
}
function agentOrigin() {
    return new URL(agentBase()).origin;
}
// server.port out of an agent config.yaml (first `port:` inside the
// top-level `server:` section; null when absent/invalid). Pure so the
// shell's file/registry glue stays untestable-thin and this stays pinned.
function parseAgentPort(yamlText) {
    let inServer = false;
    for (const raw of String(yamlText || "").split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (/^\S/.test(line))
            inServer = /^server\s*:/.test(line);
        if (!inServer)
            continue;
        const m = /^\s*port\s*:\s*"?(\d{1,5})"?\s*(?:#.*)?$/.exec(line);
        if (m) {
            const n = Number(m[1]);
            if (Number.isInteger(n) && n > 0 && n < 65536)
                return n;
            return null;
        }
    }
    return null;
}
function isBaseOrigin(url) {
    try {
        return new URL(url).origin === agentOrigin();
    }
    catch {
        return false;
    }
}
// IPC audit #2: preload runs in EVERY frame; a frame may invoke the bridge
// only when its URL carries the pinned origin (main.ts feeds this the raw
// event.senderFrame.url).
function frameUrlOk(url) {
    return isBaseOrigin(url || "");
}
// THE LOOPBACK CONTROL API'S ORIGIN VETO (port 9444), and the reason it lives
// here: the HTTP twin of IPC audit #1 was never fixed. `main.ts` tested the
// caller's Origin with
//
//   /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|file:\/\/)/i
//
// which has NO `$` ANCHOR — so `http://127.0.0.1.evil.com`, `http://localhost.evil.com`
// and `http://127.0.0.1x` all passed, and the API reflects the caller's Origin,
// so a foreign page could READ /api/browser-session/list (session URLs) and
// /api/shell/icon-status (local paths) and POST /api/browser-session/open and
// /api/shell/start-agent. That is the SAME class as the `startsWith(BASE)` bug
// this module was extracted to kill; `isDesktopSpaUrl`'s own test pins the
// sibling-host lookalike, and the HTTP path kept the old shape because it was
// the one decision that never moved in here.
//
// An ABSENT Origin is allowed deliberately: the API is also driven by `curl`
// and native tooling, which send none, and `main.ts` documents that carve-out.
// This is a nuisance barrier for browser pages, NOT authentication — the IPC
// bridge stays separately gated on the frame's own origin.
function controlOriginOk(origin) {
    if (!origin || origin === "null")
        return true; // native tooling / the data: wait page
    try {
        const u = new URL(origin);
        if (u.protocol === "file:")
            return true;
        if (u.protocol !== "http:" && u.protocol !== "https:")
            return false;
        return u.hostname === "127.0.0.1" || u.hostname === "localhost";
    }
    catch {
        // Unparseable is NOT allowed: a value the policy cannot read must never be
        // treated as one it recognises.
        return false;
    }
}
// Main-window tripwire allow-list (did-navigate backstop): the desktop SPA
// subtree of the base origin. STRING-PREFIX check (startsWith(BASE +
// "/desktop")) was the exact class IPC audit #1 flagged — compare the PARSED
// origin and the parsed pathname instead. data: (the wait page) and
// about:blank are handled by the caller.
function isDesktopSpaUrl(url) {
    try {
        const u = new URL(url);
        if (u.origin !== agentOrigin())
            return false;
        // Segment semantics: /desktop and /desktop/* — /desktopx is a different
        // path, not the SPA mount.
        return u.pathname === "/desktop" || u.pathname.startsWith("/desktop/");
    }
    catch {
        return false;
    }
}
// Lab-device TLS bypass predicate (device-caught: OpenWrt-style
// self-signed defaults, e.g. the GPON ONT web UI, fail every navigation
// with ERR_CERT_AUTHORITY_INVALID). Private-network hosts MAY bypass cert
// errors; the public internet keeps full validation — a bypassed MITM on
// a lab LAN is contained, on the open web it is not. Pure + unit-tested;
// main.ts feeds it the raw certificate-error URL.
function isPrivateHost(hostname) {
    const h = String(hostname || "").trim().toLowerCase();
    if (!h)
        return false;
    if (h === "localhost" || h === "::1" || h === "[::1]")
        return true;
    if (h.endsWith(".local") || h.endsWith(".local."))
        return true;
    const parts = h.split(".");
    if (parts.length !== 4)
        return false;
    const nums = [];
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p))
            return false;
        const n = Number(p);
        if (n > 255)
            return false;
        nums.push(n);
    }
    const [a, b] = nums;
    if (a === 10)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 127)
        return true;
    if (a === 169 && b === 254)
        return true;
    return false;
}
// Certificate-error gate for app.on("certificate-error"): true = bypass
// (preventDefault + callback(true)), false = deny. http(s) URLs on
// private hosts only — anything else (public hosts, weird schemes,
// unparsable input) stays fully validated.
function certBypassAllowed(url) {
    let u;
    try {
        u = new URL(String(url || ""));
    }
    catch {
        return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
        return false;
    return isPrivateHost(u.hostname);
}
// AI-opened browser windows must never reach file://, javascript: or
// arbitrary schemes through the CDP-driven session windows.
function sanitizeBrowserUrl(url) {
    // stage-n preload audit LOW: coerce to string BEFORE trim() — a renderer
    // passing a number/object would throw TypeError in the main process (DoS).
    const t = String(url || "about:blank").trim();
    if (t === "about:blank")
        return t;
    try {
        const u = new URL(t);
        if (u.protocol === "http:" || u.protocol === "https:")
            return u.toString();
    }
    catch { /* fall through */ }
    return "about:blank";
}
