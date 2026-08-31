/**
 * BrowserPane — pure VIEW over the useBrowser hook (the single seam to the
 * remote-browser protocol). All protocol/WS/evidence logic lives in
 * hooks/useBrowser.ts; this component only renders state and forwards input
 * events. Styling is CSS classes (styles/components.css), English UI copy.
 *
 * round-160 (Browserless/Browserbase borrowings): AI-activity indicator
 * (fresh pwout screenshots = the AI is driving), viewport zoom, URL history
 * dropdown, and a fullscreen toggle for the live viewport.
 */
import { useRef } from "react";
import { Icon } from "../ui/Icon";
import { useBrowser, type BrowserSessionData } from "../hooks/useBrowser";

export interface BrowserPaneProps {
  session: BrowserSessionData;
  apiBase: string; // "" (same-origin) or gateway proxy base
  token: string;
  /** Compact AI-runner control rendered in the view-switch row (round-refactor:
   *  the runner controls AI automation + the evidence feed, NOT the live view —
   *  it no longer gets a full status bar of its own). */
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

  const toggleFullscreen = () => {
    const el = viewportRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  };

  // Floating strip over the top edge of the viewport — does not consume
  // layout space (round-refactor: the old banner pushed the page content
  // down every time the AI drove the browser).
  const aiBanner = b.aiActive ? (
    <div className="browser-ai-indicator">
      <span className="browser-ai-dot" />
      AI 正在操作浏览器 — 点击画面可接管
    </div>
  ) : null;

  // Compact runner chip for the view-switch row.
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
      {/* View switch: Live ↔ Evidence + AI-runner chip */}
      <div className="browser-view-switch" role="tablist" aria-label="Browser view">
        <button
          type="button"
          className={`view-switch-btn${b.view === "live" ? " active" : ""}`}
          onClick={() => b.setView("live")}
        >Live</button>
        <button
          type="button"
          className={`view-switch-btn${b.view === "evidence" ? " active" : ""}`}
          onClick={() => b.setView("evidence")}
        >Evidence</button>
        {runnerChip}
      </div>

      {b.view === "live" ? (
        <div className="browser-live">
          {/* Tab strip */}
          <div className="browser-tabstrip">
            {b.tabs.map((tb) => (
              <span key={tb.i} className={`browser-tab${tb.i === b.sel ? " sel" : ""}`} onClick={() => b.selTab(tb.i)} title={tb.url}>
                <span className="browser-tab-label">{tb.url.replace(/^https?:\/\//, "") || "blank"}</span>
                <span className="browser-tab-close" onClick={(e) => { e.stopPropagation(); void b.closeTab(tb.i); }}>×</span>
              </span>
            ))}
            <span className="browser-tab-new" onClick={() => void b.newTab()} title="New tab">+</span>
          </div>

          {/* URL bar + compact viewport tools (zoom + fullscreen; the fps
              counter was pure debug noise — a static page at ~1fps read as
              "broken" to users, round-refactor) */}
          <div className="browser-urlbar">
            <input
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

          {/* Live viewport — placeholder while no frame has arrived (the
              stream is offline or the page is dark); kills the "black void"
              first impression. */}
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
              style={{
                transform: `scale(${b.zoom / 100})`,
                transformOrigin: "top left",
                display: b.hasFrame ? undefined : "none",
              }}
              onMouseMove={(e) => { const { x, y } = b.mapXY(e.currentTarget, e.clientX, e.clientY); b.send({ t: "m", x, y, k: "move" }); }}
              onMouseDown={(e) => { const { x, y } = b.mapXY(e.currentTarget, e.clientX, e.clientY); b.send({ t: "m", x, y, k: "down" }); e.currentTarget.focus(); }}
              onMouseUp={(e) => { const { x, y } = b.mapXY(e.currentTarget, e.clientX, e.clientY); b.send({ t: "m", x, y, k: "up" }); }}
              onWheel={(e) => {
                const { x, y } = b.mapXY(e.currentTarget, e.clientX, e.clientY);
                b.send({ t: "wheel", x, y, dx: e.deltaX, dy: e.deltaY });
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
              // First-frame focus + click-to-focus live in useBrowser's
              // applyFrame / onMouseDown — onLoad must NOT focus (every
              // frame re-fires it and would steal focus from the URL bar).
              onLoad={() => {}}
            />
          </div>

          {b.error && <div className="browser-error">{b.error}</div>}
        </div>
      ) : (
        <div className="browser-live browser-live-evidence">
          <div className="browser-ev-stage">
            {aiBanner}
            {b.selected && b.shotUrls[b.selected] ? (
              <img src={b.shotUrls[b.selected]} className="browser-ev-img" alt="AI browser evidence" />
            ) : (
              <div className="browser-ev-empty">
                No screenshots yet — they appear here automatically when the AI works via browser_run_script
              </div>
            )}
          </div>

          {/* Evidence timeline */}
          <div className="browser-ev-timeline">
            <div className="browser-ev-head">
              AI screenshots ({b.shots.length}) — pwout directory auto-syncs every 3s
            </div>
            {b.shots.length === 0 ? (
              <div className="browser-ev-empty-mini">No screenshots</div>
            ) : (
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
