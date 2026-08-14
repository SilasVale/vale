import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { callTool } from "../lib/api";
import type { Session } from "../hooks/useSessions";

// TerminalPane owns one xterm instance per session (imperative — xterm is
// DOM-heavy and must NOT re-render on React state changes). The container
// div is the mount point; the terminal fills it and fits on layout.
export function TerminalPane({ session }: { session: Session }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

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

    // Pull retained history so a resurrected session shows its tail.
    callTool("terminal_read", { session_id: session.sid, offset: 0, clean: false })
      .then((r: any) => { if (r && r.text) term.write(r.text); })
      .catch(() => {});

    return () => {
      sub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [session.sid]);

  // Refit when the pane becomes active (layout changed).
  useEffect(() => {
    if (session.active) {
      const t = setTimeout(() => { try { termRef.current && (termRef.current as any)._core?.addonManager?.addons?.get("fit")?.fit?.() || termRef.current?.fit?.(); } catch {} }, 50);
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
