/**
 * BrowserPane — AI 截图证据流 (round-154, pure evidence view).
 *
 * 无 URL 栏、无 Go、无刷新按钮：AI 通过 browser_run_script / playwright
 * 脚本工作时,把截图存进 D:\vale-agent\pwout,本面板每 3 秒自动同步,
 * 最新截图大图展示 + 缩略图时间线(点击切换)。这就是"看 AI 在浏览器里
 * 做了什么"的全部——与 Claude/Codex 的步骤截图展示一致。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface BrowserSessionData {
  sid: string;
  url: string;
  active: boolean;
}

interface Props {
  session: BrowserSessionData;
  apiBase: string; // "" (same-origin) or gateway proxy base
  token: string;
}

const POLL_MS = 3000;

interface Shot {
  name: string;
  mtime_ms: number;
}

export default function BrowserPane({ apiBase, token }: Props) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  const seenLoaded = useRef<Set<string>>(new Set());

  const auth = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        // Evidence list: new screenshots dropped by browser_run_script etc.
        const r = await fetch(`${apiBase}/api/browser/pwshots`, { headers: auth() });
        if (!r.ok) return;
        const data = await r.json();
        if (!alive || !Array.isArray(data.shots)) return;
        const list: Shot[] = data.shots;
        setShots(list);
        setSelected((cur) => cur && list.some((s) => s.name === cur) ? cur : (list[0]?.name ?? null));
        // Fetch blobs with the Bearer header (<img> can't send it); revoke
        // urls for shots that were cleaned from the dir.
        const missing = list.filter((s) => !seenLoaded.current.has(s.name));
        for (const shot of missing) {
          fetch(`${apiBase}/api/browser/pwshot?name=${encodeURIComponent(shot.name)}`, { headers: auth() })
            .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
            .then((blob) => {
              if (!alive) return;
              seenLoaded.current.add(shot.name);
              setShotUrls((prev) => ({ ...prev, [shot.name]: URL.createObjectURL(blob) }));
            })
            .catch(() => {});
        }
        setShotUrls((prev) => {
          const next = { ...prev };
          const keep = new Set(list.map((s) => s.name));
          for (const k of Object.keys(next)) {
            if (!keep.has(k)) { URL.revokeObjectURL(next[k]); delete next[k]; }
          }
          return next;
        });
      } catch { /* transient */ }
    };
    void tick();
    const t = window.setInterval(tick, POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, [apiBase, auth]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, background: "#1a1b1e", position: "relative", overflow: "hidden" }}>
        {selected && shotUrls[selected] ? (
          <img
            src={shotUrls[selected]}
            alt="AI browser evidence"
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        ) : (
          <div style={{ display: "grid", placeItems: "center", height: "100%", color: "#98a2b3", fontSize: 12, padding: 20, textAlign: "center" }}>
            还没有截图 — AI 通过 browser_run_script 工作时自动出现在这里
          </div>
        )}
      </div>

      {/* Evidence timeline */}
      <div style={{ flex: "0 0 auto", borderTop: "1px solid #dee2e6", background: "#fff", padding: "6px 8px" }}>
        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>
          AI 截图证据（{shots.length}）— pwout 目录自动同步，每 3s 刷新
        </div>
        {shots.length === 0 ? (
          <div style={{ fontSize: 11, color: "#98a2b3", padding: "4px 0" }}>暂无截图</div>
        ) : (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
            {shots.map((s) => (
              <div
                key={s.name}
                title={`${s.name} · ${new Date(s.mtime_ms).toLocaleTimeString()}`}
                onClick={() => setSelected(s.name)}
                style={{
                  flex: "0 0 auto", cursor: "pointer", borderRadius: 6, overflow: "hidden",
                  border: selected === s.name ? "2px solid var(--accent, #d9480f)" : "2px solid #e9ebee",
                  position: "relative",
                }}
              >
                {shotUrls[s.name] ? (
                  <img
                    src={shotUrls[s.name]}
                    alt={s.name}
                    style={{ width: 96, height: 60, objectFit: "cover", display: "block" }}
                    loading="lazy"
                  />
                ) : (
                  <div style={{ width: 96, height: 60, background: "#eef0f3", display: "grid", placeItems: "center", fontSize: 10, color: "#98a2b3" }}>加载中…</div>
                )}
                <span style={{ position: "absolute", left: 3, bottom: 2, fontSize: 9, color: "#fff", background: "rgba(0,0,0,.5)", borderRadius: 3, padding: "0 3px" }}>
                  {new Date(s.mtime_ms).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}