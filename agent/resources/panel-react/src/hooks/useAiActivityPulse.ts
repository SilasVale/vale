// useAiActivityPulse — event-driven "AI is operating" indicator (round-253).
//
// The screenshot BrowserPane derives AI activity by polling pwshots/actions
// every 3s. The embedded REAL-browser pane must not poll — instead it lights
// up when the agent PUSHES activity: the SSE `browser-actions-changed` event
// (emitted by record_mcp_action / record_mcp_screenshot) and
// `playwright-changed`. The pulse self-clears after a short fade — a UI
// timer, not a data poll.
import { useCallback, useEffect, useRef, useState } from "react";

/** Active for this long after the last activity push (UI fade window). */
const PULSE_MS = 8000;

export function useAiActivityPulse(apiBase: string, token: string): boolean {
  const [active, setActive] = useState(false);
  const fadeRef = useRef<number | undefined>(undefined);
  const activeRef = useRef(false);
  activeRef.current = active;

  const pulse = useCallback(() => {
    setActive(true);
    if (fadeRef.current) window.clearTimeout(fadeRef.current);
    fadeRef.current = window.setTimeout(() => {
      // Only clear if no newer pulse arrived (each pulse resets the timer).
      setActive(false);
    }, PULSE_MS);
  }, []);

  useEffect(() => {
    let dead = false;
    let abort: AbortController | null = null;
    let retry = 0;
    const connect = async () => {
      if (dead) return;
      try {
        const ctl = new AbortController();
        abort = ctl;
        const timer = setTimeout(() => ctl.abort(), 30000);
        const res = await fetch(`${apiBase}/api/events`, {
          headers: { authorization: `Bearer ${token}` },
          signal: ctl.signal,
        }).finally(() => clearTimeout(timer));
        if (!res.ok || !res.body) throw new Error(String(res.status));
        retry = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!dead) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const o = JSON.parse(line.slice(6));
              if (o?.ev === "browser-actions-changed" || o?.ev === "playwright-changed") pulse();
            } catch { /* keepalive */ }
          }
        }
      } catch { /* fall through to retry */ }
      if (!dead) {
        retry = Math.min(retry + 1, 5);
        setTimeout(connect, Math.min(2000 * 2 ** retry, 30000));
      }
    };
    void connect();
    return () => {
      dead = true;
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
      try { abort?.abort(); } catch { /* noop */ }
    };
  }, [apiBase, token, pulse]);

  return active;
}
