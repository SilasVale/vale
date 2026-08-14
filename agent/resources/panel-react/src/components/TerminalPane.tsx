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
  registerWrite: (sid: string, fn: (bytes: Uint8Array) => void) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const renderedRef = useRef(0);
  const syncInFlightRef = useRef(false);

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
        cursor: "#0b7a6e",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(14,147,132,.2)",
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
    fit.fit();
    termRef.current = term;

    // Keystrokes up: POST terminal_write.
    const sub = term.onData((data) => {
      callTool("terminal_write", { session_id: session.sid, data }).catch(() => {});
    });

    // Register the SSE write callback: dedup via the frame's absolute start
    // offset, and skip while a sync read is in flight (round-68).
    registerWrite(session.sid, (bytes) => {
      // The SSE hook passed the frame; TerminalPane only needs the bytes
      // (the hook already validated session_id). Dedup is done by the hook
      // caller in useSSE — here we just write + advance.
      term.write(bytes);
      renderedRef.current += bytes.length;
    });

    // Pull retained history so a resurrected session shows its tail.
    syncInFlightRef.current = true;
    callTool("terminal_read", { session_id: session.sid, offset: 0, clean: false })
      .then((r: any) => {
        if (r && r.text) { term.write(r.text); }
        renderedRef.current = Math.max(renderedRef.current, Number(r?.end) || 0);
      })
      .catch(() => {})
      .finally(() => { syncInFlightRef.current = false; });

    return () => {
      sub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [session.sid, registerWrite]);

  // Refit when the pane becomes active (layout changed) + on window
  // resize/zoom/visibility (round-83 R82 review: browser resize left the
  // canvas at its old grid — white space/clipped content until a tab switch).
  useEffect(() => {
    const refit = () => { try { (termRef.current as any)?.fit?.(); } catch {} };
    if (session.active) {
      const t = setTimeout(refit, 50);
      window.addEventListener("resize", refit);
      document.addEventListener("visibilitychange", refit);
      return () => { clearTimeout(t); window.removeEventListener("resize", refit); document.removeEventListener("visibilitychange", refit); };
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
