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
exports.isBaseOrigin = isBaseOrigin;
exports.frameUrlOk = frameUrlOk;
exports.isDesktopSpaUrl = isDesktopSpaUrl;
exports.sanitizeBrowserUrl = sanitizeBrowserUrl;
exports.BASE = "http://127.0.0.1:18080";
exports.BASE_ORIGIN = new URL(exports.BASE).origin;
function isBaseOrigin(url) {
    try {
        return new URL(url).origin === exports.BASE_ORIGIN;
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
// Main-window tripwire allow-list (did-navigate backstop): the desktop SPA
// subtree of the base origin. STRING-PREFIX check (startsWith(BASE +
// "/desktop")) was the exact class IPC audit #1 flagged — compare the PARSED
// origin and the parsed pathname instead. data: (the wait page) and
// about:blank are handled by the caller.
function isDesktopSpaUrl(url) {
    try {
        const u = new URL(url);
        if (u.origin !== exports.BASE_ORIGIN)
            return false;
        // Segment semantics: /desktop and /desktop/* — /desktopx is a different
        // path, not the SPA mount.
        return u.pathname === "/desktop" || u.pathname.startsWith("/desktop/");
    }
    catch {
        return false;
    }
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
