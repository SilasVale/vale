import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { callTool } from "../lib/api";
import type { Session } from "../hooks/useSessions";

// TerminalPane owns one xterm instance per session (imperative — xterm is
// DOM-heavy and must NOT re-render on React state changes). It registers a
// write callback with the SSE hook (useSSE) so streamed bytes reach the
// terminal directly; the frame.start dedup (round-68) is handled here via
// renderedBytes — while a sync read is in flight (syncInFlight) frames are
// skipped so the read's text doesn't double-render.
//
// ShellHub/Teleport-style terminal UX (round-160): scrollback search
// (Ctrl+F), WebGL rendering with canvas fallback, selection-to-copy +
// right-click paste, and a per-pane font-size control persisted to
// localStorage.

const FONT_LS = "valeFontSize";
const FONT_DEFAULT = 13;
const FONT_MIN = 9;
const FONT_MAX = 22;

function loadFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_LS));
    if (Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX) return n;
  } catch { /* private mode */ }
  return FONT_DEFAULT;
}

export function TerminalPane({ session, registerWrite }: {
  session: Session;
  registerWrite: (sid: string, fn: (bytes: Uint8Array) => void, getRendered: () => number) => (() => void) & { unregister?: (sid: string) => void };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const renderedRef = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [fontSize, setFontSize] = useState(loadFontSize);

  useEffect(() => {
    if (!containerRef.current) return;
    // reflowOnResize is a real xterm option not in this @xterm/xterm's
    // types — the whole options object is asserted so the option survives.
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 20000,
      fontSize,
      // round-83 (R82 review): reflowOnResize re-wraps the buffer on a grid
      // change — without it, a session adopted while display:none (inactive)
      // stayed at the 80x24 grid with blank space (the 'half screen' bug).
      reflowOnResize: true,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace',
      // round-83: full 16-color palette (vanilla TERM_THEME) — xterm draws
      // bold text with index<8 at index+8 and falls back to the dark Tango
      // brights when unset, which are nearly invisible on white (1.2-1.6:1).
      theme: {
        background: "#ffffff",
        foreground: "#1d1d1f",
        cursor: "#d9480f",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(217,72,15,.2)", // --accent #d9480f (vale amber)
        black: "#1d1d1f", red: "#b91c1c", green: "#166534", yellow: "#854d0e",
        blue: "#1d4ed8", magenta: "#7c3aed", cyan: "#0f766e", white: "#44403c",
        brightBlack: "#4b5563", brightRed: "#dc2626", brightGreen: "#15803d",
        brightYellow: "#a16207", brightBlue: "#2563eb", brightMagenta: "#9333ea",
        brightCyan: "#0f766e", brightWhite: "#6e6e73",
      },
    } as any);
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    searchRef.current = search;
    term.open(containerRef.current);
    // WebGL renderer (GPU-composited, keeps heavy output smooth). Falls back
    // silently to the DOM/canvas renderer when unavailable (RDP sessions,
    // disabled accel, context loss).
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => { try { gl.dispose(); } catch { /* already gone */ } });
      term.loadAddon(gl);
    } catch { /* no webgl — default renderer is fine */ }
    // rAF ×2: wait for the browser to paint the container at its final
    // size before fitting — an immediate fit() reads pre-layout dimensions
    // and produces a partial grid (the "not filling the screen" bug).
    requestAnimationFrame(() => requestAnimationFrame(() => { try { fit.fit(); } catch {} }));

    // Keystrokes up: POST terminal_write.
    const sub = term.onData((data) => {
      callTool("terminal_write", { session_id: session.sid, data }).catch(() => {});
    });

    // Ctrl+F opens the scrollback search (Shift+F / browser find untouched).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        setSearchOpen(true);
        e.preventDefault();
        return false;
      }
      return true;
    });

    // Selection-to-copy (the web-terminal norm) + right-click paste.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    });
    const onContext = (e: Event) => {
      e.preventDefault();
      navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
    };
    containerRef.current.addEventListener("contextmenu", onContext);

    // Register the SSE write callback: dedup via the frame's absolute start
    // offset, and skip while a sync read is in flight (round-68).
    // round-99: registerWrite returns an unregister fn — the callback must
    // leave the map when this pane unmounts, or the 5s sync loop polls
    // closed-session entries forever (unbounded no-op polling).
    const unregister = registerWrite(session.sid, (bytes) => {
      // The SSE hook passed the frame; TerminalPane only needs the bytes
      // (the hook already validated session_id). Dedup is done by the hook
      // caller in useSSE — here we just write + advance.
      term.write(bytes);
      renderedRef.current += bytes.length;
    }, () => renderedRef.current);

    // Pull retained history so a resurrected session shows its tail.
    // round-96: the adopt read used offset:0 and rewrote EVERYTHING, while
    // SSE frames streamed in concurrently — the whole history was written
    // twice (syncInFlightRef was set but never read, so nothing suppressed
    // the duplicate). Read INCREMENTALLY from the current rendered offset
    // (the same dedup the 5s sync loop uses): bytes SSE already delivered
    // are skipped, nothing is re-written.
    callTool("terminal_read", { session_id: session.sid, offset: renderedRef.current, clean: false })
      .then((r: any) => {
        if (!r || (!r.text && !r.raw)) return;
        const skip = Math.max(0, renderedRef.current - Number(r.start));
        if (r.raw) {
          const bin = atob(r.raw);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          if (skip < bytes.length) {
            term.write(bytes.subarray(skip));
            renderedRef.current += bytes.length - skip;
          }
        } else if (skip >= 0 && r.text) {
          const bytes = new TextEncoder().encode(r.text);
          if (skip < bytes.length) {
            term.write(bytes.subarray(skip));
            renderedRef.current += bytes.length - skip;
          }
        }
      })
      .catch(() => {});

    return () => {
      sub.dispose();
      searchRef.current = null;
      term.dispose();
      termRef.current = null;
      containerRef.current?.removeEventListener("contextmenu", onContext);
      unregister();
    };
  }, [session.sid, registerWrite]);

  // Refit when the pane becomes active (layout changed) + on window
  // resize/zoom/visibility (round-83 R82 review: browser resize left the
  // canvas at its old grid — white space/clipped content until a tab switch).
  useEffect(() => {
    const refit = () => {
      try {
        // round-128: the admin views (trajectory/plugins) hide the active
        // pane's container without unmounting — a window resize then runs
        // fit() on a 0-size hidden container and pushes a garbage grid to
        // the backend. Skip while not visible (offsetParent is null when
        // the element or an ancestor is display:none).
        const term: any = termRef.current;
        if (term?.element && term.element.offsetParent === null) return;
        term?.fit?.();
        // round-96: the fit() only reflows the LOCAL xterm grid — the
        // backend PTY/SSH/serial session kept its original cols/rows, so a
        // resize left the remote line-wrapping wrong. Push the new grid to
        // the backend (best-effort; failure is harmless).
        if (term && session.sid) {
          callTool("terminal_resize", { session_id: session.sid, cols: term.cols, rows: term.rows }).catch(() => {});
        }
      } catch {}
    };
    if (session.active) {
      const cleanupRef: (() => void)[] = [];
      const t = setTimeout(refit, 50);
      window.addEventListener("resize", refit);
      document.addEventListener("visibilitychange", refit);
      if (containerRef.current && typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => refit());
        ro.observe(containerRef.current);
        cleanupRef.push(() => ro.disconnect());
      }
      // round-94: focus the terminal on activation — keystrokes previously
      // landed nowhere (focus stayed on the toolbar/button that opened the
      // session, and Enter/Space re-triggered it).
      setTimeout(() => { try { termRef.current?.focus?.(); } catch {} }, 60);
      return () => { clearTimeout(t); window.removeEventListener("resize", refit); document.removeEventListener("visibilitychange", refit); cleanupRef.forEach(fn => fn()); };
    }
  }, [session.active]);

  // Font-size control: applies live, pushes the new grid to the backend
  // (refit → terminal_resize), persists for the next session.
  const applyFont = (n: number) => {
    const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, n));
    setFontSize(clamped);
    try { localStorage.setItem(FONT_LS, String(clamped)); } catch { /* private mode */ }
    const term: any = termRef.current;
    if (!term) return;
    term.options.fontSize = clamped;
    setTimeout(() => {
      try {
        term.fit?.();
        callTool("terminal_resize", { session_id: session.sid, cols: term.cols, rows: term.rows }).catch(() => {});
      } catch { /* hidden pane */ }
    }, 30);
  };

  // findNext/findPrevious REQUIRE the search term in this addon version —
  // the input's onChange keeps `searchTerm` authoritative for ↑/↓ repeats.
  const searchNext = () => { if (searchTerm) try { searchRef.current?.findNext(searchTerm); } catch {} };
  const searchPrev = () => { if (searchTerm) try { searchRef.current?.findPrevious(searchTerm); } catch {} };
  const searchClose = () => {
    try { searchRef.current?.clearDecorations(); } catch {}
    setSearchOpen(false);
    try { termRef.current?.focus?.(); } catch {}
  };

  return (
    <div
      ref={containerRef}
      className={`term-session ${session.active ? "active" : ""}`}
      style={session.active ? undefined : { display: "none" }}
    >
      {session.active && searchOpen && (
        <div className="term-searchbar">
          <input
            autoFocus
            placeholder="Search…"
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? searchPrev() : searchNext(); }
              if (e.key === "Escape") { e.preventDefault(); searchClose(); }
            }}
            onChange={(e) => { setSearchTerm(e.target.value); try { searchRef.current?.findNext(e.target.value); } catch {} }}
          />
          <button title="Previous match (Shift+Enter)" onClick={searchPrev}>↑</button>
          <button title="Next match (Enter)" onClick={searchNext}>↓</button>
          <button title="Close (Esc)" onClick={searchClose}>✕</button>
        </div>
      )}
      {session.active && (
        <div className="term-fontbar">
          <button title="Smaller font" onClick={() => applyFont(fontSize - 1)}>A−</button>
          <button title="Reset font size" onClick={() => applyFont(FONT_DEFAULT)}>A</button>
          <button title="Larger font" onClick={() => applyFont(fontSize + 1)}>A+</button>
        </div>
      )}
    </div>
  );
}
