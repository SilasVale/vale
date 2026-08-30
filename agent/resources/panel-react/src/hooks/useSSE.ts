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

// round-103: per-session gap backfill state — a lagged broadcast dropped
// frames; the next frame's start is the true gap lower bound, so we backfill
// [issueOffset, frame.start) precisely (guessing at renderedNow was wrong in
// both directions: it duplicated frame bytes or lost the gap entirely).
const lagBackfill = new Map<string, number>();

function backfillGap(
  sid: string,
  issueOffset: number,
  gapEnd: number | undefined,
  cb: { write: (bytes: Uint8Array) => void; getRendered: () => number },
) {
  // Read [issueOffset, end) from the server buffer; write only the dropped
  // range [issueOffset, gapEnd) — bytes at or above gapEnd are (or will be)
  // frame-delivered.
  // round-121: capture rendered BEFORE the read resolves — the caller writes
  // the post-gap frame synchronously right after issuing this read, so at
  // RESPONSE time rendered already covers [start, start+len). The sync loop
  // may also have delivered part of the gap meanwhile; skip only bytes the
  // sync loop already wrote (those < rendered at capture time), never the
  // whole gap (the round-104 bug).
  const before = cb.getRendered();
  callTool("terminal_read", { session_id: sid, offset: issueOffset, clean: false })
    .then((r: any) => {
      if (!r || (!r.text && !r.raw)) return;
      let bytes: Uint8Array;
      if (r.raw) {
        const bin = atob(r.raw);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        bytes = new TextEncoder().encode(r.text);
      }
      const rel = Math.max(0, issueOffset - Number(r.start));
      const to = gapEnd === undefined ? bytes.length : Math.min(rel + (gapEnd - issueOffset), bytes.length);
      const from = Math.min(rel, bytes.length);
      // Skip bytes the sync loop already delivered before this read resolved
      // (dedup); write the rest of the gap.
      const syncDelivered = Math.max(0, before - issueOffset);
      const effectiveFrom = Math.max(from, rel + syncDelivered);
      if (to > effectiveFrom) {
        cb.write(bytes.subarray(effectiveFrom, to));
      }
    })
    .catch(() => {
      // round-121: a failed backfill read must be retried — the gap is
      // unrecoverable otherwise (rendered advanced past it, the sync loop
      // reads from rendered). Re-register the lag so the next frame retries.
      lagBackfill.set(sid, issueOffset);
    });
}

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

    // round-163: the 5s sync TIMER is gone. The sweep still exists but runs
    // EVENT-driven: once on connect (recover everything missed while the
    // stream was down) and on tab refocus. While the stream is healthy,
    // frames arrive in real time and the 'lagged' broadcast marker + gap
    // backfill cover dropped frames — a periodic re-read was pure waste.
    const syncSweep = () => {
      const live = new Set(getLiveSidsRef.current());
      const sids = new Set<string>(live);
      for (const sid of writeCallbacks.current.keys()) sids.add(sid);
      for (const sid of sids) {
        const cb = writeCallbacks.current.get(sid);
        if (!cb) continue;
        const from = cb.getRendered();
        callTool("terminal_read", { session_id: sid, offset: from, clean: false })
          .then((r: any) => {
            if (!r || (!r.text && !r.raw)) return;
            // round-88: dedup against the CURRENT rendered offset at RESPONSE
            // time — the server always returns start == the requested offset,
            // so comparing to the captured `from` was dead code (skip always
            // 0), and SSE frames arriving DURING the read (which the server
            // pushes before the read response) were re-written by the read.
            // Compare against cb.getRendered() now: bytes the SSE frames
            // already delivered are skipped.
            const rendered = cb.getRendered();
            // round-94: the skip delta is BYTES (the server's start/end are
            // absolute byte offsets; renderedRef advances by Uint8Array byte
            // length), but r.text.slice(skip) cut at UTF-16 code-unit index —
            // on CJK/emoji output the two diverge and the slice dropped live
            // characters while the read cursor skipped past them forever.
            // Skip BYTE-precise: the server now returns the raw base64 payload
            // (clean:false), decode it and subarray the exact byte range.
            const skip = Math.max(0, rendered - Number(r.start));
            if (r.raw) {
              const bin = atob(r.raw);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              if (skip < bytes.length) cb.write(bytes.subarray(skip));
            } else if (skip > 0) {
              // No raw payload (clean path): best-effort re-encode — byte
              // alignment via TextEncoder, still safe for CJK.
              const bytes = new TextEncoder().encode(r.text);
              cb.write(bytes.subarray(skip));
            } else if (r.text) {
              cb.write(new TextEncoder().encode(r.text));
            }
          })
          .catch(() => {
            // round-94: a failed sync read used to be swallowed — the gap
            // between the last rendered offset and the next SSE frame's start
            // was never re-fetched, so bytes vanished permanently on a
            // transient failure. The next 5s tick retries from the same
            // (un-advanced) rendered offset; nothing is lost.
          });
      }
    };
    syncSweep();
    const onVisible = () => { if (document.visibilityState === "visible") syncSweep(); };
    document.addEventListener("visibilitychange", onVisible);

    const backoff = () => {
      const base = Math.min(3000 * Math.pow(2, attempt), 30000);
      attempt += 1;
      return base * (0.5 + Math.random() * 0.5);
    };

    const connect = async () => {
      if (!alive) return;
      try {
        // round-107: match the page protocol (loopback http panel works).
        // round-108: a blackholed tunnel left this fetch pending forever
        // (sseState 'connecting' with no reconnect) — bound it with an
        // abort signal like every other device call.
        const proto = window.location.protocol === "http:" ? "http:" : "https:";
        const ctl = new AbortController();
        const abortTimer = setTimeout(() => ctl.abort(), 30000);
        const res = await fetch(`${proto}//${hostname}/api/events/term`, {
          headers: { authorization: `Bearer ${token}` },
          signal: ctl.signal,
        }).finally(() => clearTimeout(abortTimer));
        if (res.status === 401) { setSseState("down"); setTimeout(connect, backoff()); return; }
        if (!res.ok || !res.body) { setSseState("down"); setTimeout(connect, backoff()); return; }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          // round-138: liveness watchdog — the server sends ': ping\n\n'
          // every 60s; 90s without ANY byte means the connection is
          // blackholed (NAT/tunnel drop, device power loss — no FIN/RST),
          // and reader.read() would hang forever. Race it against a timer
          // and let the outer catch reconnect.
          const readWithTimeout = () => {
            // round-139: clear the timer when the race settles — the R138
            // version left one 90s timer pending per read() (thousands under
            // active output, surviving teardown/reconnects).
            let t: ReturnType<typeof setTimeout>;
            return Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => {
                t = setTimeout(() => reject(new Error("SSE read timeout")), 90_000);
              }),
            ]).finally(() => clearTimeout(t!));
          };
          while (alive) {
            const { done, value } = await readWithTimeout();
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
              if (typeof frame.ev === "string") {
                // round-163: control events (sessions-changed,
                // playwright-changed) — the agent pushes them on the same
                // stream; hooks subscribe via these window events. This is
                // what replaced the 3s/5s status polls.
                window.dispatchEvent(new CustomEvent(`vale-${frame.ev}`, { detail: frame }));
                continue;
              }
              if (Array.isArray(frame.data) && frame.session_id) {
                const cb = writeCallbacks.current.get(frame.session_id);
                if (!cb) continue;
                // round-86: dedup vs the sync/backfill reads — the server
                // attaches the frame's absolute start offset; skip bytes the
                // rendered offset already passed (round-83 wrote every frame
                // unconditionally, duplicating what a sync read delivered).
                if (typeof frame.start === "number" && frame.start < cb.getRendered()) {
                  // round-104: a SKIPPED frame still consumes any pending
                  // lag entry — the sync loop already recovered the gap
                  // (rendered advanced past it), so a later backfill would
                  // re-write the same range (duplication).
                  lagBackfill.delete(frame.session_id);
                  continue;
                }
                // round-103: a pending lag-backfill for this session — the
                // frame's start is the true gap lower bound; backfill only
                // [issueOffset, frame.start) (the dropped range) instead of
                // guessing at renderedNow.
                if (lagBackfill.has(frame.session_id)) {
                  const issue = lagBackfill.get(frame.session_id)!;
                  lagBackfill.delete(frame.session_id);
                  // round-112: cb was MISSING (dead code) — the backfill
                  // threw on cb.getRendered() and the gap was never written.
                  backfillGap(frame.session_id, issue, typeof frame.start === "number" ? frame.start : undefined, cb);
                }
                cb.write(new Uint8Array(frame.data));
                // round-163: activity signal — command cards re-fetch on
                // output instead of a 2s audit-log timer.
                window.dispatchEvent(new CustomEvent("vale-term-output", { detail: { sid: frame.session_id } }));
              } else if (frame.lagged) {
                // round-100: the broadcast dropped frames for this lagging
                // subscriber — bytes in [rendered, next frame's start) were
                // never delivered, and the sync loop's dedup (skip =
                // rendered - start) treats them as if they were, so the gap
                // would be lost forever. The lagged frame carries no
                // session_id (the stream is cross-session); mark EVERY
                // session's rendered offset as needing a gap backfill — the
                // next frame for a session carries its start, the true gap
                // lower bound (round-103: guessing at renderedNow was wrong
                // in both directions).
                for (const [sid, cb] of writeCallbacks.current) {
                  lagBackfill.set(sid, cb.getRendered());
                }
              }
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch { setSseState("down"); }
      if (alive) setTimeout(connect, backoff());
    };
    connect();
    return () => {
      alive = false;
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, writeCallbacks, getLiveSidsRef]);

  return sseState;
}
