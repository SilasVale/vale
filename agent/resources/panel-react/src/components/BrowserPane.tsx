/**
 * BrowserPane — pure VIEW over the useBrowser hook (the single seam to the
 * remote-browser protocol). All protocol/WS/evidence logic lives in
 * hooks/useBrowser.ts; this component only renders state and forwards input
 * events. Styling is CSS classes (styles/components.css), English UI copy.
 *
 * stage-n redesign: REAL-BROWSER layout (Chrome-style) —
 *   - one integrated toolbar row: tabs + address bar + viewport tools
 *   - the live viewport is the dominant region, always rendered
 *   - Evidence is a right-side DRAWER over the viewport (not a full view
 *     switch), so the page stays visible while AI screenshots are reviewed
 *   - the AI-runner chip lives in the bottom status bar, not the toolbar
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useBrowser, type BrowserSessionData } from "../hooks/useBrowser";

export interface BrowserPaneProps {
  session: BrowserSessionData;
  apiBase: string; // "" (same-origin) or gateway proxy base
  token: string;
  /** Compact AI-runner control rendered in the status bar. */
  runner?: {
    running: boolean;
    pending: boolean;
    errored: boolean;
    busy: "start" | "stop" | null;
    onToggle: () => void;
  };
}

export default function BrowserPane({ apiBase, token, runner }: BrowserPaneProps) {
  const b = useBrowser({ apiBase, token });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  // stage-n: the evidence panel is a DRAWER — open/closed state here, the
  // live viewport stays mounted underneath.
  const [evOpen, setEvOpen] = useState(false);

  // stage-n: real-browser keyboard shortcuts while the browser page is
  // focused: Ctrl+L focus address bar, Ctrl+T new tab, Ctrl+R reload,
  // Ctrl+W close tab, Ctrl+Shift+Tab / Ctrl+Tab cycle tabs. The handler
  // reads the LATEST browser state via a ref (b is a fresh object every
  // render — depending on it would re-attach the listener each render).
  const bRef = useRef(b);
  bRef.current = b;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const b = bRef.current;
      const k = e.key.toLowerCase();
      if (k === "l") {
        e.preventDefault();
        urlInputRef.current?.focus();
        urlInputRef.current?.select();
      } else if (k === "t") {
        e.preventDefault();
        void b.newTab();
      } else if (k === "r") {
        e.preventDefault();
        b.reload();
      } else if (k === "w") {
        e.preventDefault();
        void b.closeTab(b.sel);
      }
      // NOTE: Ctrl+Tab / Ctrl+Shift+Tab are NOT bound here — the Electron
      // menu reserves them for session switching (next/prev session).
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleFullscreen = () => {
    const el = viewportRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  };

  // Floating strip over the top edge of the viewport — does not consume
  // layout space.
  const aiBanner = b.aiActive ? (
    <div className="browser-ai-indicator">
      <span className="browser-ai-dot" />
      AI 正在操作浏览器 — 点击画面可接管
    </div>
  ) : null;

  const runnerChip = runner ? (
    <span
      className={`bp-chip${runner.running ? " on" : runner.errored ? " err" : ""}`}
      title={runner.running
        ? "AI 助手（playwright-mcp）运行中 — 供 AI 自动化与截图证据使用"
        : "AI 助手未运行 — 供 AI 自动化与截图证据使用（实时画面不受影响）"}
    >
      <span className={`bp-dot${runner.running ? " ok" : runner.pending ? "" : runner.errored ? " err" : ""}`} />
      <span className="bp-chip-text">
        {runner.pending
          ? "AI 助手…"
          : runner.running
            ? "AI 助手运行中"
            : runner.errored
              ? "AI 助手异常"
              : "AI 助手未运行"}
      </span>
      <button
        className="btn btn-ghost btn-mini"
        onClick={runner.onToggle}
        disabled={runner.pending || runner.busy !== null}
      >
        {runner.busy === "start" ? "启动中…" : runner.running ? "停止" : runner.errored ? "重试" : "启动"}
      </button>
    </span>
  ) : null;

  return (
    <div className="browser-pane">
      {/* ── Chrome-style toolbar: tab row + address row (two lines, like a
           real browser: tabs on top, address bar below) ── */}
      <div className="browser-toolbar">
        {/* Tab row */}
        <div className="browser-tabstrip">
          {b.tabs.map((tb) => (
            <span key={tb.i} className={`browser-tab${tb.i === b.sel ? " sel" : ""}`} onClick={() => b.selTab(tb.i)} title={tb.url}>
              <span className="browser-tab-label">{tb.url.replace(/^https?:\/\//, "") || "blank"}</span>
              <span className="browser-tab-close" onClick={(e) => { e.stopPropagation(); void b.closeTab(tb.i); }}>×</span>
            </span>
          ))}
          <span className="browser-tab-new" onClick={() => void b.newTab()} title="New tab">+</span>
        </div>

        {/* Address row */}
        <div className="browser-urlbar">
          <span className="browser-navbtns">
            <button className="btn btn-mini browser-nav" onClick={b.goBack} title="后退" disabled={!b.canBack}>←</button>
            <button className="btn btn-mini browser-nav" onClick={b.goForward} title="前进" disabled={!b.canFwd}>→</button>
            <button className="btn btn-mini browser-nav" onClick={b.reload} title="刷新" disabled={b.tabs.length === 0}>↻</button>
          </span>
          <span className="browser-url-secure" title={b.url.startsWith("https") ? "Secure" : "Not secure"}>
            {b.url.startsWith("https") ? "🔒" : "🌐"}
          </span>
          <input
            ref={urlInputRef}
            className="browser-url"
            value={b.url}
            onChange={(e) => b.setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && b.navigate()}
            placeholder="输入网址后回车 — 下方页面可实时点击操作"
            list="vale-url-history"
          />
          <datalist id="vale-url-history">
            {b.urlHistory.map((u) => <option key={u} value={u} />)}
          </datalist>
          <button className="btn btn-mini browser-go" onClick={b.navigate}>Go</button>
          <span className="browser-tools">
            <select
              className="browser-zoom"
              value={b.zoom}
              onChange={(e) => b.setZoom(Number(e.target.value))}
              title="画面缩放"
              aria-label="画面缩放"
            >
              {[75, 100, 125, 150].map((z) => <option key={z} value={z}>{z}%</option>)}
            </select>
            <button className="btn btn-mini browser-fullscreen" onClick={toggleFullscreen} title="全屏"><Icon name="fullscreen" size={13} /></button>
          </span>
        </div>
      </div>

      {/* ── Live viewport — always rendered, the dominant region ── */}
      <div className="browser-viewport" ref={viewportRef}>
        {aiBanner}
        {!b.hasFrame && (
          <div className="browser-placeholder">
            <Icon name="browser" size={30} />
            <p>No browser stream yet — enter a URL and press Go.</p>
            <p className="browser-placeholder-sub">AI screenshots land in Evidence automatically.</p>
          </div>
        )}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <img
          ref={b.imgRef}
          className="browser-frame"
          alt="Remote browser"
          tabIndex={0}
          draggable={false}
          style={{
            transform: `scale(${b.zoom / 100})`,
            transformOrigin: "top left",
            display: b.hasFrame ? undefined : "none",
          }}
          onDragStart={(e) => e.preventDefault()}
          onMouseMove={(e) => { const p = b.mapXY(e.currentTarget, e.clientX, e.clientY); if (p.inside) b.sendMove(p.x, p.y); }}
          onMouseDown={(e) => { e.preventDefault(); const p = b.mapXY(e.currentTarget, e.clientX, e.clientY); if (!p.inside) return; b.send({ t: "m", x: p.x, y: p.y, k: "down" }); e.currentTarget.focus(); }}
          onMouseUp={(e) => { const p = b.mapXY(e.currentTarget, e.clientX, e.clientY); if (!p.inside) return; b.send({ t: "m", x: p.x, y: p.y, k: "up" }); }}
          onWheel={(e) => {
            const p = b.mapXY(e.currentTarget, e.clientX, e.clientY);
            if (!p.inside) return;
            b.send({ t: "wheel", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
            e.preventDefault();
          }}
          onKeyDown={(e) => {
            e.preventDefault();
            const printable = e.key.length === 1;
            b.send({ t: "k", down: true, key: e.key, code: e.code, vk: e.keyCode, text: printable ? e.key : undefined });
          }}
          onKeyUp={(e) => {
            e.preventDefault();
            b.send({ t: "k", down: false, key: e.key, code: e.code, vk: e.keyCode });
          }}
          onLoad={() => {}}
        />
      </div>

      {/* ── Bottom status bar: view toggle + AI chip + errors ── */}
      <div className="browser-statusbar">
        <div className="browser-status-left">
          <button
            type="button"
            className={`browser-ev-toggle${evOpen ? " active" : ""}`}
            onClick={() => setEvOpen((v) => !v)}
            title="AI 截图证据（抽屉）"
          >
            🖼 Evidence{b.shots.length > 0 ? ` (${b.shots.length})` : ""}
          </button>
          {b.error && <span className="browser-error-inline">{b.error}</span>}
        </div>
        <div className="browser-status-right">
          {runnerChip}
          <span className="browser-fps" title="最近画面帧">
            ● {b.hasFrame ? "live" : "waiting"}
          </span>
        </div>
      </div>

      {/* ── Evidence drawer (right side, over the viewport) ── */}
      {evOpen && (
        <div className="browser-ev-drawer">
          <div className="browser-ev-head">
            AI screenshots ({b.shots.length}) — pwout 目录自动同步
            <button className="btn btn-ghost btn-mini browser-ev-close" onClick={() => setEvOpen(false)}>✕</button>
          </div>
          {b.shots.length === 0 ? (
            <div className="browser-ev-empty-mini">No screenshots yet — they appear here automatically when the AI works via browser_run_script</div>
          ) : (
            <>
              <div className="browser-ev-stage">
                {b.selected && b.shotUrls[b.selected] ? (
                  <img src={b.shotUrls[b.selected]} className="browser-ev-img" alt="AI browser evidence" />
                ) : (
                  <div className="browser-ev-empty">Select a screenshot</div>
                )}
              </div>
              <div className="browser-ev-timeline">
                <div className="browser-ev-strip">
                  {b.shots.map((s) => (
                    <div
                      key={s.name}
                      className={`browser-ev-thumb${b.selected === s.name ? " sel" : ""}`}
                      title={`${s.name} · ${new Date(s.mtime_ms).toLocaleTimeString()}`}
                      onClick={() => b.setSelected(s.name)}
                    >
                      {b.shotUrls[s.name] ? (
                        <img src={b.shotUrls[s.name]} alt={s.name} loading="lazy" />
                      ) : (
                        <div className="browser-ev-thumb-empty">Loading…</div>
                      )}
                      <span className="browser-ev-time">{new Date(s.mtime_ms).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              </div>
              {/* AI-action log */}
              <div className="browser-actions">
                <div className="browser-ev-head">AI actions ({b.actions.length}) — 操作日志</div>
                {b.actions.length === 0 ? (
                  <div className="browser-ev-empty-mini">No actions yet — they appear here when the AI drives the browser via browser_run_script</div>
                ) : (
                  <div className="browser-actions-list">
                    {b.actions.map((a) => (
                      <div key={a.ts} className={`browser-action${a.exit_code === 0 ? "" : a.exit_code === null ? " running" : " err"}`}>
                        <div className="browser-action-row">
                          <span className="browser-action-time">{new Date(a.ts).toLocaleTimeString()}</span>
                          <span className={`browser-action-badge${a.exit_code === 0 ? " ok" : a.exit_code === null ? " run" : " err"}`}>
                            {a.timed_out ? "timeout" : a.exit_code === 0 ? "ok" : a.exit_code === null ? "running" : `exit ${a.exit_code}`}
                          </span>
                          {typeof a.duration_ms === "number" && (
                            <span className="browser-action-dur">{a.duration_ms}ms</span>
                          )}
                          {a.screenshots && a.screenshots.length > 0 && (
                            <span className="browser-action-shots">{a.screenshots.length} shot{a.screenshots.length > 1 ? "s" : ""}</span>
                          )}
                        </div>
                        <div className="browser-action-script">{a.script || "(no script)"}</div>
                        {a.stderr_tail && a.exit_code !== 0 && (
                          <div className="browser-action-err">{a.stderr_tail}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
