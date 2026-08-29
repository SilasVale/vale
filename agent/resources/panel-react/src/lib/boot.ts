// lib/boot.ts — the ONE place the frontend decides "local vs cloud" and
// resolves the connection bootstrap. Logic is VERBATIM from the pre-refactor
// App.tsx computeBoot (round-139 fix + round-86/122/124 semantics); moving it
// here only gives it an owner, it does not change behavior.
//
// See docs/superpowers/specs/2026-08-28-vale-desktop-core-design.md §5.
import { initTransport } from "./api";

const LS_HOST = "valeHost";
const LS_TOKEN = "valeToken";

/** Resolved bootstrap values shared by every App state initializer. */
export interface Boot {
  host: string;
  tok: string;
  connected: boolean;
}

function isProxyPath(pathname: string): boolean {
  return /\/proxy\/panel/.test(pathname);
}

function isSameOrigin(pathname: string): boolean {
  return (
    location.pathname.startsWith("/panel") ||
    location.pathname.startsWith("/desktop") ||
    isProxyPath(pathname)
  );
}

// round-139 FIX: ONE bootstrap pass feeds host/token/connected alike. The old
// code resolved token precedence (injected > URL ?token= > stored) inside the
// `connected` initializer and gave it ONLY to initTransport — React's `token`
// state stayed "" whenever localStorage was empty at first paint. Terminal/
// SSE kept working (transport had the real token) but BrowserPane builds its
// own Bearer from the `token` PROP, so a first visit via ?token= (fresh
// browser, or console-proxy visits which delete valeToken per round-122/124)
// 401'd every /api/browser/* call: blank viewport, 0fps, no tabs, red
// auth failed — fixed by one manual reload. Now the same resolved value seeds
// both the transport and React state.
export function computeBoot(onAuthFail: () => void): Boot {
  if (isSameOrigin(location.pathname)) {
    const isProxy = isProxyPath(location.pathname);
    const urlToken = new URLSearchParams(location.search).get("token") || "";
    const injected = (isProxy ? "" : (window as any).__PANEL_TOKEN__) || "";
    const stored = localStorage.getItem(LS_TOKEN) || "";
    const host = location.host;
    const tok = isProxy ? (urlToken || "") : (injected || urlToken || stored);
    localStorage.setItem(LS_HOST, host);
    // round-122/124: in PROXY mode do NOT persist the token to
    // localStorage — the vale_pt cookie is the real credential there, and
    // persisting the plugin token made a plaintext 30-day device-control
    // credential readable by any script on the console origin. Also
    // DELETE any stale pre-R122 value: the proxy's Bearer would win over
    // the valid cookie and a rotated leftover token would 401 the SSE
    // stream into a permanent reconnect loop. Same-origin (LAN) mode
    // keeps the stored-token flow.
    if (isProxy) {
      localStorage.removeItem(LS_TOKEN);
    } else if (tok) {
      localStorage.setItem(LS_TOKEN, tok);
    }
    // round-86: a same-origin visit with NO token (LAN IP / non-allowlisted
    // host, empty storage) must show the conn form — the old code booted
    // connected=true with a placeholder token, silently dead (every call
    // 401'd into a noop, form unreachable). Proxy-mode cookie boot (no
    // token) stays connected — the cookie is the credential there.
    if (!tok && !isProxy) return { host, tok: stored, connected: false };
    initTransport(host, tok || " ", onAuthFail);
    if (urlToken) {
      try { history.replaceState(null, "", location.pathname); } catch { /* noop */ }
    }
    return { host, tok, connected: true };
  }
  const h = localStorage.getItem(LS_HOST);
  const t = localStorage.getItem(LS_TOKEN);
  if (h && t) initTransport(h, t, onAuthFail);
  return { host: h || "", tok: t || "", connected: !!(h && t) };
}
