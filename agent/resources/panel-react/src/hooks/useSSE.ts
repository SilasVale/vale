import { useEffect, useState } from "react";
import { callTool } from "../lib/api";

// SSE terminal stream — connects to /api/events/term, dispatches byte frames
// to the matching session's xterm (via per-session write callbacks registered
// by TerminalPane), with heartbeat + exponential backoff.
//
// round-86 (from the R82/R86 adversarial reviews):
// - the 5s sync loop reads INCREMENTALLY from each session's renderedBytes
//   (round-83 wrote offset:0 — the FULL history re-appended every tick,
//   duplicating output 2x/3x/4x…); SSE frames are deduped against the
//   rendered offset via frame.start
// - getLiveSids is called via a stable ref (round-83 passed an inline arrow,
//   which recreated the SSE effect every 3s poll — tearing down and
//   re-establishing the stream, dropping frames in the gap)

export type SseState = "connected" | "down" | "connecting";

export function useSSE(
  connected: boolean,
  writeCallbacks: React.MutableRefObject<Map<string, { write: (bytes: Uint8Array) => void; getRendered: () => number }>>,
  getLiveSidsRef: React.MutableRefObject<() => string[]>,
) {
  const [sseState, setSseState] = useState<SseState>("connecting");

  useEffect(() => {
    if (!connected) { setSseState("connecting"); return; }
    const hostname = (localStorage.getItem("valeHost") || "").trim();
    const token = localStorage.getItem("valeToken") || "";
    if (!hostname) return;

    let attempt = 0;
    let alive = true;

    // 30s heartbeat: keep watched-but-silent sessions alive (the backend
    // reaps sessions with no output after 15 min).
    const heartbeat = window.setInterval(() => {
      for (const sid of getLiveSidsRef.current()) {
        callTool("terminal_select", { session_id: sid }).catch(() => {});
      }
    }, 30_000);

    // 5s sync loop (round-86): recover bytes missed during an SSE outage —
    // read INCREMENTALLY from each session's renderedBytes (the round-83
    // offset:0 read re-appended the full history every tick).
    const syncLoop = window.setInterval(() => {
      for (const sid of getLiveSidsRef.current()) {
        const cb = writeCallbacks.current.get(sid);
        if (!cb) continue;
        const from = cb.getRendered();
        callTool("terminal_read", { session_id: sid, offset: from, clean: false })
          .then((r: any) => {
            if (!r || !r.text) return;
            // round-88: dedup against the CURRENT rendered offset at RESPONSE
            // time — the server always returns start == the requested offset,
            // so comparing to the captured `from` was dead code (skip always
            // 0), and SSE frames arriving DURING the read (which the server
            // pushes before the read response) were re-written by the read.
            // Compare against cb.getRendered() now: bytes the SSE frames
            // already delivered are skipped.
            const rendered = cb.getRendered();
            const skip = Math.max(0, rendered - Number(r.start));
            const txt = skip ? r.text.slice(skip) : r.text;
            if (txt) cb.write(new TextEncoder().encode(txt));
          })
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
              setSseState("connected");
              const dataText = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
              if (!dataText.trim()) continue;
              let frame;
              try { frame = JSON.parse(dataText.trim()); } catch { continue; }
              if (Array.isArray(frame.data) && frame.session_id) {
                const cb = writeCallbacks.current.get(frame.session_id);
                if (!cb) continue;
                // round-86: dedup vs the sync/backfill reads — the server
                // attaches the frame's absolute start offset; skip bytes the
                // rendered offset already passed (round-83 wrote every frame
                // unconditionally, duplicating what a sync read delivered).
                if (typeof frame.start === "number" && frame.start < cb.getRendered()) continue;
                cb.write(new Uint8Array(frame.data));
              }
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch { setSseState("down"); }
      if (alive) setTimeout(connect, backoff());
    };
    connect();
    return () => { alive = false; clearInterval(heartbeat); clearInterval(syncLoop); };
  }, [connected, writeCallbacks, getLiveSidsRef]);

  return sseState;
}
