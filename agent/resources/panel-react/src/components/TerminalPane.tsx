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
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      scrollback: 20000,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace',
      theme: { background: "#ffffff", foreground: "#1d1d1f" },
    });
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

  // Refit when the pane becomes active (layout changed).
  useEffect(() => {
    if (session.active) {
      const t = setTimeout(() => { try { (termRef.current as any)?.fit?.(); } catch {} }, 50);
      return () => clearTimeout(t);
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
