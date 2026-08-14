import { useEffect, useState } from "react";

// SSE terminal stream (migrated from vanilla panel.js) — connects to
// /api/events/term, dispatches byte frames to the matching session's xterm
// (via a per-session write callback registered by TerminalPane), with
// heartbeat + exponential backoff + the round-68 syncInFlight dedup.
//
// The xterm instances are NOT React state — they live in a runtimes map
// (useSessions) and TerminalPane registers a write(target, bytes) callback
// here. React only tracks the connection state (for the status bar).

export type SseState = "connected" | "down" | "connecting";

export function useSSE(connected: boolean, writeCallbacks: React.MutableRefObject<Map<string, (bytes: Uint8Array) => void>>) {
  const [sseState, setSseState] = useState<SseState>("connecting");

  useEffect(() => {
    if (!connected) { setSseState("connecting"); return; }
    const hostname = (localStorage.getItem("valeHost") || "").trim();
    const token = localStorage.getItem("valeToken") || "";
    if (!hostname) return;

    let attempt = 0;
    let alive = true;
    const backoff = () => {
      const base = Math.min(3000 * Math.pow(2, attempt), 30000);
      attempt += 1;
      return base * (0.5 + Math.random() * 0.5);
    };

    const connect = async () => {
      if (!alive) return;
      try {
        const res = await fetch(`https://${hostname}/api/events/term`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.status === 401) { setSseState("down"); setTimeout(connect, backoff()); return; }
        if (!res.ok || !res.body) { setSseState("down"); setTimeout(connect, backoff()); return; }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (alive) {
            const { done, value } = await reader.read();
            if (done) break;
            attempt = 0;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const raw = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              setSseState("connected"); // any frame (incl. ping) proves alive
              const dataText = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
              if (!dataText.trim()) continue;
              let frame;
              try { frame = JSON.parse(dataText.trim()); } catch { continue; }
              if (Array.isArray(frame.data) && frame.session_id) {
                const write = writeCallbacks.current.get(frame.session_id);
                if (write) {
                  // Dedup: the server attaches the frame's absolute start
                  // offset; TerminalPane tracks renderedBytes per session.
                  write(new Uint8Array(frame.data));
                }
              }
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch { setSseState("down"); }
      if (alive) setTimeout(connect, backoff());
    };
    connect();
    return () => { alive = false; };
  }, [connected, writeCallbacks]);

  return sseState;
}
