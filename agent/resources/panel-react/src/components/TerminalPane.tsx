import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { callTool } from "../lib/api";
import { getTheme, onThemeChange } from "../lib/theme";
import { Icon } from "../ui/Icon";
import type { Session } from "../hooks/useSessions";
import { adoptNeedsAnotherPage } from "../lib/terminalAdopt";

// TerminalPane owns one xterm instance per session (imperative — xterm is
// DOM-heavy and must NOT re-render on React state changes). It registers a
// write callback with the SSE hook (useSSE) so streamed bytes reach the
// terminal directly; the frame.start dedup (round-68) is handled here via
// renderedBytes — while a sync read is in flight (syncInFlight) frames are
// skipped so the read's text doesn't double-render.
//
// ShellHub/Teleport-style terminal UX (round-160): scrollback search
// (Ctrl+F), selection-to-copy + right-click paste, and a per-pane font-size
// control persisted to localStorage.
//
// round-161 REGRESSION FIX (the "one click and the pane goes blank" report):
// 1. The search/font overlays were React children of the SAME div that
//    term.open() owns — React reconciliation and xterm's own DOM mutations
//    fought over that subtree and the pane blanked on interaction. The
//    overlays now live OUTSIDE the xterm host (.term-host).
// 2. The WebGL renderer is gone: on some GPUs/WebView2 the context creates
//    fine but paints nothing (a silent blank terminal, not catchable). The
//    default renderer never blanks; nothing here needed WebGL.

const FONT_LS = "valeFontSize";
const FONT_DEFAULT = 13;
const FONT_MIN = 9;
const FONT_MAX = 22;

// Terminal palettes per app theme (round-163: the terminal FOLLOWS the
// theme — light default restores the white canvas the user prefers; dark
// keeps the midnight cockpit). Applied live via term.options.theme on flip.
function termTheme(theme: "light" | "dark") {
  if (theme === "dark") {
    return {
      background: "#131418",
      foreground: "#d8dae0",
      cursor: "#ffa94d",
      cursorAccent: "#131418",
      selectionBackground: "rgba(255, 169, 77, 0.28)",
      black: "#2a2c33", red: "#ff6b6b", green: "#69db7c", yellow: "#ffd43b",
      blue: "#74c0fc", magenta: "#da77f2", cyan: "#66d9e8", white: "#e8e9ec",
      brightBlack: "#7c7e8a", brightRed: "#ff8787", brightGreen: "#8ce99a",
      brightYellow: "#ffe066", brightBlue: "#91caff", brightMagenta: "#eebefa",
      brightCyan: "#99e9f2", brightWhite: "#ffffff",
    };
  }
  return {
    background: "#ffffff",
    foreground: "#1d1d1f",
    cursor: "#d9480f",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(217, 72, 15, 0.2)",
    black: "#1d1d1f", red: "#b91c1c", green: "#166534", yellow: "#854d0e",
    blue: "#1d4ed8", magenta: "#7c3aed", cyan: "#0f766e", white: "#44403c",
    brightBlack: "#4b5563", brightRed: "#dc2626", brightGreen: "#15803d",
    brightYellow: "#a16207", brightBlue: "#2563eb", brightMagenta: "#9333ea",
    brightCyan: "#0f766e", brightWhite: "#6e6e73",
  };
}

function loadFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_LS));
    if (Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX) return n;
  } catch { /* private mode */ }
  return FONT_DEFAULT;
}

export function TerminalPane({ session, registerWrite }: {
  session: Session;
  registerWrite: (sid: string, fn: (bytes: Uint8Array, start?: number) => void, getRendered: () => number, setRendered?: (n: number) => void) => (() => void) & { unregister?: (sid: string) => void };
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
      theme: termTheme(getTheme()),
    } as any);
// review #3 (HIGH): termRef was NEVER assigned (only nulled on cleanup) —
    // refit, the terminal_resize push (remote wrapping stuck at 120x30 —
    // the round-96 bug returning), focus-on-activate and the FONT buttons
    // were ALL silently dead.
    termRef.current = term;
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    searchRef.current = search;
    term.open(containerRef.current);
    // round-161: WebGL renderer REMOVED — on some GPUs/WebView2 the context
    // creates successfully but paints nothing (silent blank terminal). The
    // default DOM/canvas renderer never blanks and is fast enough here.
    // rAF ×2: wait for the browser to paint the container at its final
    // size before fitting — an immediate fit() reads pre-layout dimensions
    // and produces a partial grid (the "not filling the screen" bug).
    requestAnimationFrame(() => requestAnimationFrame(() => { try { fit.fit(); } catch {} }));

    // Keystrokes up: POST terminal_write. review #5: serialized through a
    // promise chain — concurrent write POSTs race over the multiplexed
    // tunnel and can arrive SWAPPED (fast typing/paste reordering).
    let writeChain: Promise<unknown> = Promise.resolve();
    const sub = term.onData((data) => {
      writeChain = writeChain
        .then(() => callTool("terminal_write", { session_id: session.sid, data }))
        .catch(() => {
          window.dispatchEvent(new CustomEvent("vale-write-failed", { detail: { sid: session.sid } }));
        });
    });

    // Follow app theme flips live (light ↔ dark) without recreating the term.
    const offTheme = onThemeChange(() => {
      (term as any).options.theme = termTheme(getTheme());
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
    // stage-m: NO wrapper filter — the execute wrapper is gone (VS Code
    // shell integration: OSC 633 sequences are invisible on the terminal,
    // consumed server-side by the agent). Raw bytes go straight to xterm.
    const decoder = new TextDecoder();
    const unregister = registerWrite(session.sid, (bytes, start) => {
      // The SSE hook passed the frame; TerminalPane only needs the bytes
      // (the hook already validated session_id). Dedup is done by the hook
      // caller in useSSE — here we just write + advance.
      term.write(new TextEncoder().encode(decoder.decode(bytes, { stream: true })));
      // review #1: when the caller knows the ABSOLUTE offset of these
      // bytes (every SSE frame + every clamped read does), position there —
      // the += form permanently desyncs across server-side clamps.
      if (typeof start === "number") {
        renderedRef.current = start + bytes.length;
      } else {
        renderedRef.current += bytes.length;
      }
    }, () => renderedRef.current, (v) => { renderedRef.current = v; });

    // Pull retained history so a resurrected session shows its tail.
    // round-96: the adopt read used offset:0 and rewrote EVERYTHING, while
    // SSE frames streamed in concurrently — the whole history was written
    // twice (syncInFlightRef was set but never read, so nothing suppressed
    // the duplicate). Read INCREMENTALLY from the current rendered offset
    // (the same dedup the 5s sync loop uses): bytes SSE already delivered
    // are skipped, nothing is re-written.
    // round-246 (terminal-display audit HIGH-3): ONE read is capped at 1 MiB
    // server-side (read_spill), so a chatty AI session (>1 MiB before a human
    // opens its tab) had its HEAD silently dropped — renderedRef jumped to
    // the tail and the skipped bytes were never re-read. Adopt now PAGES:
    // each response carries the absolute `end` cursor; while it is ahead of
    // what we have rendered, chain the next read. Event-driven (a read only
    // fires when the previous one returned more data) — no timers, no polls.
    // The dedup below (skip = rendered - start) keeps SSE frames that arrive
    // DURING the chain from being duplicated, exactly as the single-read
    // version did.
    const MAX_ADOPT_PAGES = 64; // hard bound — a wedged server cannot loop us
    const adoptPage = (attempt: number): void => {
      if (attempt > MAX_ADOPT_PAGES) return;
      callTool("terminal_read", { session_id: session.sid, offset: renderedRef.current, clean: false })
        .then((r: any) => {
          if (r?.evicted) { renderedRef.current = 0; return; }
          if (!r || (!r.text && !r.raw)) return; // end of buffer
          const skip = Math.max(0, renderedRef.current - Number(r.start));
          let advanced = false;
          if (r.raw) {
            const bin = atob(r.raw);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            if (skip < bytes.length) {
              term.write(new TextEncoder().encode(decoder.decode(bytes.subarray(skip), { stream: true })));
              renderedRef.current = Math.max(renderedRef.current, Number(r.start) + bytes.length);
              advanced = true;
            }
          } else if (skip >= 0 && r.text) {
            const bytes = new TextEncoder().encode(r.text);
            if (skip < bytes.length) {
              term.write(new TextEncoder().encode(decoder.decode(bytes.subarray(skip), { stream: true })));
              renderedRef.current = Math.max(renderedRef.current, Number(r.start) + bytes.length);
              advanced = true;
            }
          }
          // round-246: page while the server says more exists. `end` is the
          // absolute cursor just past the returned bytes; a response that
          // advanced rendered but whose end is STILL ahead means the 1 MiB
          // cap truncated us — read on. If nothing advanced (SSE already
          // delivered everything, or end <= rendered), we are caught up.
          // Pure decision lives in lib/terminalAdopt (unit-tested).
          if (adoptNeedsAnotherPage(r, renderedRef.current, advanced)) {
            adoptPage(attempt + 1);
          }
        })
        .catch(() => {});
    };
    adoptPage(0);

    return () => {
      offTheme();
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
        const term: any = termRef.current;
        if (term?.element && term.element.offsetParent === null) return;
        term?.fit?.();
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
        // stage-n: throttle refits to one per frame — ResizeObserver can fire
        // rapidly during drawer animation and flood the backend with resizes.
        let rafId = 0;
        const ro = new ResizeObserver(() => {
          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => { rafId = 0; refit(); });
        });
        ro.observe(containerRef.current);
        cleanupRef.push(() => ro.disconnect());
      }
      // stage-n: focus synchronously (double-rAF for paint-then-focus) instead
      // of a 60ms setTimeout that let fast typers lose chars on tab switch.
      const focusTimer = requestAnimationFrame(() => {
        requestAnimationFrame(() => { try { termRef.current?.focus?.(); } catch {} });
      });
      return () => { clearTimeout(t); cancelAnimationFrame(focusTimer); window.removeEventListener("resize", refit); document.removeEventListener("visibilitychange", refit); cleanupRef.forEach(fn => fn()); };
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
    // stage-n: refit in same rAF cycle as fontSize set — the old 30ms
    // setTimeout created a visible grid misalignment flash.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          term.fit?.();
          callTool("terminal_resize", { session_id: session.sid, cols: term.cols, rows: term.rows }).catch(() => {});
        } catch { /* hidden pane */ }
      });
    });
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
      className={`term-session ${session.active ? "active" : ""}`}
      style={session.active ? undefined : { display: "none" }}
    >
      {/* .term-host is xterm's EXCLUSIVE subtree — React never renders into
          it, so the overlays (React) and xterm's own DOM can no longer
          fight over the same nodes (round-161 blank-pane fix). */}
      <div ref={containerRef} className="term-host" />
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
          <button title="Search scrollback (Ctrl+F)" onClick={() => setSearchOpen(true)}>
            <Icon name="search" size={12} />
          </button>
          <button title="Smaller font" onClick={() => applyFont(fontSize - 1)}>A−</button>
          <button title="Reset font size" onClick={() => applyFont(FONT_DEFAULT)}>A</button>
          <button title="Larger font" onClick={() => applyFont(fontSize + 1)}>A+</button>
        </div>
      )}
    </div>
  );
}
