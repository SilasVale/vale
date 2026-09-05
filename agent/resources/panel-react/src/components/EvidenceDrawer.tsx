// EvidenceDrawer — AI screenshot + action-log drawer for the EMBEDDED
// real-browser pane (round-255). The screenshot BrowserPane polls evidence
// every 3s because its poll also drives the screencast; the embedded pane
// must not poll, so this drawer:
//   1. fetches pwshots + actions ON DEMAND when opened,
//   2. refreshes on the agent's `vale-browser-actions-changed` /
//      `vale-playwright-changed` window events (re-dispatched by useSSE from
//      its single /api/events/term stream — P1-3 removed this drawer's own
//      duplicate /api/events fetch) while open, and
//   3. fetches each new screenshot blob when its row appears.
// Visual parity comes from reusing the existing .browser-ev-* classes.
import { useCallback, useEffect, useRef, useState } from "react";

export interface Shot { name: string; mtime_ms: number }
export interface BrowserAction {
  ts: number; duration_ms?: number; exit_code?: number | null; timed_out?: boolean;
  script?: string; screenshots?: string[]; stdout_tail?: string; stderr_tail?: string;
}

export function EvidenceDrawer({ apiBase, token, open, onClose }: {
  apiBase: string; token: string; open: boolean; onClose: () => void;
}) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [actions, setActions] = useState<BrowserAction[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const aliveRef = useRef(true);

  const auth = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const base = apiBase || "";

  const refresh = useCallback(async () => {
    try {
      const [sr, ar] = await Promise.all([
        fetch(`${base}/api/browser/pwshots`, { headers: auth() }),
        fetch(`${base}/api/browser/actions`, { headers: auth() }),
      ]);
      if (!aliveRef.current) return;
      if (sr.ok) {
        const d = await sr.json();
        if (Array.isArray(d.shots)) {
          setShots(d.shots);
          setSelected((cur) => (cur && d.shots.some((s: Shot) => s.name === cur) ? cur : (d.shots[0]?.name ?? null)));
        }
      }
      if (ar.ok) {
        const d = await ar.json();
        if (Array.isArray(d.actions)) setActions(d.actions);
      }
    } catch { /* transient */ }
  }, [base, auth]);

  // Fetch shot image blobs for shots we haven't loaded (cache key name:mtime).
  useEffect(() => {
    if (!open) return;
    const keyOf = (x: Shot) => `${x.name}:${x.mtime_ms}`;
    for (const shot of shots) {
      const key = keyOf(shot);
      if (shotUrls[key] || !selected) continue;
      fetch(`${base}/api/browser/pwshot?name=${encodeURIComponent(shot.name)}`, { headers: auth() })
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
        .then((blob) => {
          if (!aliveRef.current) return;
          setShotUrls((prev) => ({ ...prev, [key]: URL.createObjectURL(blob) }));
        })
        .catch(() => {});
    }
    return () => {
      // revoke blobs created by this drawer when it closes/unmounts
      if (!open) {
        setShotUrls((prev) => {
          for (const k of Object.keys(prev)) URL.revokeObjectURL(prev[k]);
          return {};
        });
      }
    };
  }, [open, shots, shotUrls, selected, base, auth]);

  // Load on open; refresh on the agent's activity pushes while open.
  // (P1-3: useSSE re-dispatches its single stream's control frames as
  // `vale-*` window events — subscribe to those instead of opening a second
  // /api/events fetch.)
  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    void refresh();
    const onActivity = () => { if (aliveRef.current) void refresh(); };
    window.addEventListener("vale-browser-actions-changed", onActivity);
    window.addEventListener("vale-playwright-changed", onActivity);
    return () => {
      aliveRef.current = false;
      window.removeEventListener("vale-browser-actions-changed", onActivity);
      window.removeEventListener("vale-playwright-changed", onActivity);
    };
  }, [open, refresh]);

  const toggleExpanded = useCallback((k: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  const selectedKey = selected ? `${selected}:${shots.find((s) => s.name === selected)?.mtime_ms ?? ""}` : null;

  return (
    <div className={`browser-ev-drawer${open ? " open" : ""}`}>
      <div className="browser-ev-head">
        AI screenshots ({shots.length}) — synced from the pwout dir
        <button className="btn btn-ghost btn-mini browser-ev-close" onClick={onClose} aria-label="Close evidence">✕</button>
      </div>
      {shots.length === 0 ? (
        <div className="browser-ev-empty-mini">No screenshots yet — they appear here automatically when the AI works via browser_run_script</div>
      ) : (
        <>
          <div className="browser-ev-stage">
            {selectedKey && shotUrls[selectedKey] ? (
              <img src={shotUrls[selectedKey]} className="browser-ev-img" alt="AI browser evidence" />
            ) : (
              <div className="browser-ev-empty">Select a screenshot</div>
            )}
          </div>
          <div className="browser-ev-timeline">
            <div className="browser-ev-strip">
              {shots.map((s) => (
                <div
                  key={s.name}
                  className={`browser-ev-thumb${selected === s.name ? " sel" : ""}`}
                  title={`${s.name} · ${new Date(s.mtime_ms).toLocaleTimeString()}`}
                  onClick={() => setSelected(s.name)}
                >
                  {shotUrls[`${s.name}:${s.mtime_ms}`] ? (
                    <img src={shotUrls[`${s.name}:${s.mtime_ms}`]} alt={s.name} loading="lazy" />
                  ) : (
                    <div className="browser-ev-thumb-empty">Loading…</div>
                  )}
                  <span className="browser-ev-time">{new Date(s.mtime_ms).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="browser-actions">
        <div className="browser-ev-head">AI actions ({actions.length}) — run log</div>
        {actions.length === 0 ? (
          <div className="browser-ev-empty-mini">No actions yet — they appear here when the AI drives the browser</div>
        ) : (
          <div className="browser-actions-list">
            {actions.map((a) => {
              const k = `${a.ts}:${String(a.script || "").slice(0, 40)}`;
              const isExpanded = expanded.has(k);
              return (
                <div key={k} className={`browser-action${a.exit_code === 0 ? "" : a.exit_code === null ? " running" : " err"}`}>
                  <div className="browser-action-row">
                    <span className="browser-action-time">{new Date(a.ts).toLocaleTimeString()}</span>
                    <span className={`browser-action-badge${a.exit_code === 0 ? " ok" : a.exit_code === null ? " run" : " err"}`}>
                      {a.timed_out ? "timeout" : a.exit_code === 0 ? "ok" : a.exit_code === null ? "running" : `exit ${a.exit_code}`}
                    </span>
                    {typeof a.duration_ms === "number" && <span className="browser-action-dur">{a.duration_ms}ms</span>}
                    {a.screenshots && a.screenshots.length > 0 && (
                      <span className="browser-action-shots">{a.screenshots.length} shot{a.screenshots.length > 1 ? "s" : ""}</span>
                    )}
                  </div>
                  <div className={`browser-action-script${isExpanded ? " expanded" : ""}`} onClick={() => toggleExpanded(k)}>
                    {String(a.script || "").split("\n").map((ln, i) => <div key={i}>{ln || "\u00A0"}</div>)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
