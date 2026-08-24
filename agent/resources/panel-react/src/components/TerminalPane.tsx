import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { callTool } from "../lib/api";
import type { Session } from "../hooks/useSessions";

// TerminalPane owns one xterm instance per session (imperative — xterm is
// DOM-heavy and must NOT re-render on React state changes). It registers a
// write callback with the SSE hook (useSSE) so streamed bytes reach the
// terminal directly; the frame.start dedup (round-68) is handled here via
// renderedBytes — while a sync read is in flight (syncInFlight) frames are
// skipped so the read's text doesn't double-render.
export function TerminalPane({ session, registerWrite }: {
  session: Session;
  registerWrite: (sid: string, fn: (bytes: Uint8Array) => void, getRendered: () => number) => () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const renderedRef = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;
    // reflowOnResize is a real xterm option not in this @xterm/xterm's
    // types — the whole options object is asserted so the option survives.
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 20000,
      fontSize: 13,
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
    term.loadAddon(fit);
    term.open(containerRef.current);
    // rAF ×2: wait for the browser to paint the container at its final
    // size before fitting — an immediate fit() reads pre-layout dimensions
    // and produces a partial grid (the "not filling the screen" bug).
    requestAnimationFrame(() => requestAnimationFrame(() => { try { fit.fit(); } catch {} }));

    // Keystrokes up: POST terminal_write.
    const sub = term.onData((data) => {
      callTool("terminal_write", { session_id: session.sid, data }).catch(() => {});
    });

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
      term.dispose();
      termRef.current = null;
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

  return (
    <div
      ref={containerRef}
      className={`term-session ${session.active ? "active" : ""}`}
      style={session.active ? undefined : { display: "none" }}
    />
  );
}
