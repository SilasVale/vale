import { useEffect, useState } from "react";
import { callTool } from "../lib/api";

// SSE terminal stream (migrated from vanilla panel.js) — connects to
// /api/events/term, dispatches byte frames to the matching session's xterm
// (via a per-session write callback registered by TerminalPane), with
// heartbeat + exponential backoff + the round-68 syncInFlight dedup.
//
// round-83 (from the R82 adversarial review):
// - the 5s sync loop is back: on SSE drop/reconnect, every live session is
//   terminal_read from its renderedBytes to recover missed bytes
// - the 30s terminal_select heartbeat is back: the backend's idle sweeper
//   force-closes watched-but-silent sessions after 15 min of no output; the
//   vanilla panel pinged select every 30s to keep them alive.

export type SseState = "connected" | "down" | "connecting";

export function useSSE(
  connected: boolean,
  writeCallbacks: React.MutableRefObject<Map<string, (bytes: Uint8Array) => void>>,
  getLiveSids: () => string[],
) {
  const [sseState, setSseState] = useState<SseState>("connecting");

  useEffect(() => {
    if (!connected) { setSseState("connecting"); return; }
    const hostname = (localStorage.getItem("valeHost") || "").trim();
    const token = localStorage.getItem("valeToken") || "";
    if (!hostname) return;

    let attempt = 0;
    let alive = true;

    // 30s heartbeat (round-83): keep watched-but-silent sessions alive —
    // the backend reaps sessions with no output after 15 min (round-55
    // semantics: output activity is not presence; select is).
    const heartbeat = window.setInterval(() => {
      for (const sid of getLiveSids()) {
        callTool("terminal_select", { session_id: sid }).catch(() => {});
      }
    }, 30_000);

    // 5s sync loop (round-83): recover bytes missed during an SSE outage —
    // the vanilla panel ran syncAll on the same cadence; without it, output
    // emitted during a drop is permanently lost.
    const syncLoop = window.setInterval(() => {
      for (const sid of getLiveSids()) {
        const write = writeCallbacks.current.get(sid);
        if (!write) continue;
        callTool("terminal_read", { session_id: sid, offset: 0, clean: false })
          .then((r: any) => { if (r && r.text) write(new TextEncoder().encode(r.text)); })
          .catch(() => {});
      }
    }, 5_000);

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
                if (write) write(new Uint8Array(frame.data));
              }
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch { setSseState("down"); }
      if (alive) setTimeout(connect, backoff());
    };
    connect();
    return () => { alive = false; clearInterval(heartbeat); clearInterval(syncLoop); };
  }, [connected, writeCallbacks, getLiveSids]);

  return sseState;
}
