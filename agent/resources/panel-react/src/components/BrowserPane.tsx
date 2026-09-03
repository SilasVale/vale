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
import { useRef, useState } from "react";
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
  const viewportRegistered = useRef(false);
  // stage-n: the evidence panel is a DRAWER — open/closed state here, the
  // live viewport stays mounted underneath.
  const [evOpen, setEvOpen] = useState(false);
  // stage-n: expanded AI-action scripts — key is `${ts}:${i}` (two actions
  // can share a millisecond; ts alone collided — client-review fix 8).
  const [expandedActions, setExpandedActions] = useState<Set<string>>(new Set());

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
      AI is operating the browser — click the view to take over
    </div>
  ) : null;

  const runnerChip = runner ? (
    <span
      className={`bp-chip${runner.running ? " on" : runner.errored ? " err" : ""}`}
      title={runner.running
        ? "AI runner (playwright-mcp) active — powers automation and screenshot evidence"
        : "AI runner stopped — live view is unaffected"}
    >
      <span className={`bp-dot${runner.running ? " ok" : runner.pending ? "" : runner.errored ? " err" : ""}`} />
      <span className="bp-chip-text">
        {runner.pending
          ? "AI runner…"
          : runner.running
            ? "AI runner active"
            : runner.errored
              ? "AI runner error"
              : "AI runner stopped"}
      </span>
      <button
        className="btn btn-ghost btn-mini"
        onClick={runner.onToggle}
        disabled={runner.pending || runner.busy !== null}
      >
        {runner.busy === "start" ? "Starting…" : runner.running ? "Stop" : runner.errored ? "Retry" : "Start"}
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
              <span className="browser-tab-label">{tb.title || tb.url.replace(/^https?:\/\//, "") || "blank"}</span>
              <span className="browser-tab-close" onClick={(e) => { e.stopPropagation(); void b.closeTab(tb.i); }}>×</span>
            </span>
          ))}
          <span className="browser-tab-new" onClick={() => void b.newTab()} title="New tab">+</span>
        </div>

        {/* Address row */}
        <div className="browser-urlbar">
          <span className="browser-navbtns">
            <button className="btn btn-mini browser-nav" onClick={b.goBack} title="Back" disabled={!b.canBack}>←</button>
            <button className="btn btn-mini browser-nav" onClick={b.goForward} title="Forward" disabled={!b.canFwd}>→</button>
            <button className="btn btn-mini browser-nav" onClick={b.reload} title="Reload" disabled={b.tabs.length === 0}>↻</button>
          </span>
          <span className="browser-url-secure" title={b.url.startsWith("https") ? "Secure" : "Not secure"}>
            {b.url.startsWith("https") ? "🔒" : "🌐"}
          </span>
          <input
            className="browser-url"
            value={b.url}
            onChange={(e) => b.setUrl(e.target.value)}
            onFocus={() => { b.urlEditingRef.current = true; }}
            onBlur={() => { b.urlEditingRef.current = false; }}
            onKeyDown={(e) => e.key === "Enter" && b.navigate()}
            placeholder="Enter a URL and press Enter — the page below is live and clickable"
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
              title="Zoom"
              aria-label="Zoom"
            >
              {[75, 100, 125, 150].map((z) => <option key={z} value={z}>{z}%</option>)}
            </select>
            <button className="btn btn-mini browser-fullscreen" onClick={toggleFullscreen} title="Fullscreen"><Icon name="fullscreen" size={13} /></button>
          </span>
        </div>
      </div>

      {/* ── Live viewport — always rendered, the dominant region. Its size
           is reported to the bridge (reportViewport) so the stream matches
           the panel exactly — sharpest image. ── */}
      <div
        className="browser-viewport"
        ref={(el) => {
          viewportRef.current = el;
          // Register the ResizeObserver ONCE (el identity is stable across
          // renders; reportViewport keeps its own observer ref).
          if (el && !viewportRegistered.current) {
            viewportRegistered.current = true;
            b.reportViewport(el);
          }
        }}
      >
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
            width: `${b.zoom}%`,
            height: `${b.zoom}%`,
            display: b.hasFrame ? undefined : "none",
          }}
          onDragStart={(e) => e.preventDefault()}
          onMouseMove={(e) => { const p = b.mapXY(e.currentTarget, e.clientX, e.clientY); if (p.inside) b.sendMove(p.x, p.y); }}
          onMouseDown={(e) => { e.preventDefault(); const p = b.mapXY(e.currentTarget, e.clientX, e.clientY); if (!p.inside) return; b.send({ t: "m", x: p.x, y: p.y, k: "down" }); e.currentTarget.focus(); }}
          onMouseUp={(e) => { const p = b.mapXY(e.currentTarget, e.clientX, e.clientY); if (!p.inside) return; b.send({ t: "m", x: p.x, y: p.y, k: "up" }); }}
          onWheel={(e) => {
            const p = b.mapXY(e.currentTarget, e.clientX, e.clientY);
            if (!p.inside) return;
            // stage-n: only preventDefault when the remote page actually
            // consumed the scroll (zoom == 100% → native scroll works).
            if (b.zoom > 100) e.preventDefault();
            b.send({ t: "wheel", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
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
            onClick={() => {
              const open = !evOpen;
              setEvOpen(open);
              // stage-n: opening the drawer with shots present selects the
              // newest automatically — the stage used to sit empty until a
              // manual thumbnail click (client-review fix 7).
              if (open && !b.selected && b.shots.length > 0) b.setSelected(b.shots[0].name);
            }}
            title={(() => {
              const last = b.actions[0];
              if (!last) return "AI screenshot evidence (drawer)";
              const head = String(last.script || "").split("\n")[0].slice(0, 70);
              const rc = last.exit_code == null ? "running…" : `exit ${last.exit_code}`;
              return `AI screenshot evidence — last action: ${head} (${rc})`;
            })()}
          >
            🖼 Evidence{b.shots.length > 0 ? ` (${b.shots.length})` : ""}
            {b.aiActive && <span className="browser-ev-live" aria-hidden />}
          </button>
          {b.error && <span className="browser-error-inline">{b.error}</span>}
        </div>
        <div className="browser-status-right">
          {runnerChip}
          <span className="browser-fps" title="Latest frame">
            ● {b.hasFrame ? "live" : "waiting"}
          </span>
        </div>
      </div>

      {/* ── Evidence drawer (right side, over the viewport) ── */}
      {/* stage-n: always render; toggle class for smooth open/close animation
          instead of mount/unmount which pops. */}
      <div className={`browser-ev-drawer${evOpen ? " open" : ""}`}>
        <div className="browser-ev-head">
          AI screenshots ({b.shots.length}) — synced from the pwout dir
          <button className="btn btn-ghost btn-mini browser-ev-close" onClick={() => setEvOpen(false)}>✕</button>
        </div>
          {b.shots.length === 0 ? (
            <div className="browser-ev-empty-mini">No screenshots yet — they appear here automatically when the AI works via browser_run_script</div>
          ) : (
            <>
              <div className="browser-ev-stage">
                {b.selected && b.shotUrls[b.shotKey(b.selected)] ? (
                  <img src={b.shotUrls[b.shotKey(b.selected)]} className="browser-ev-img" alt="AI browser evidence" />
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
                      {b.shotUrls[`${s.name}:${s.mtime_ms}`] ? (
                        <img src={b.shotUrls[`${s.name}:${s.mtime_ms}`]} alt={s.name} loading="lazy" />
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
                <div className="browser-ev-head">AI actions ({b.actions.length}) — run log</div>
                {b.actions.length === 0 ? (
                  <div className="browser-ev-empty-mini">No actions yet — they appear here when the AI drives the browser via browser_run_script</div>
                ) : (
                  <div className="browser-actions-list">
                    {b.actions.map((a, ai) => (
                    // stage-n: stable key from the action content so prepending a
                    // new action doesn't shift indices and reset scroll/expanded state.
                    <div key={`${a.ts}:${a.script?.slice(0,40)}`} className={`browser-action${a.exit_code === 0 ? "" : a.exit_code === null ? " running" : " err"}`}>
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
                        {/* stage-n: click the script preview to expand/collapse
                            long scripts (default clamped to 40px). */}
                        <div
                          className={`browser-action-script${expandedActions.has(`${a.ts}:${a.script?.slice(0,40)}`) ? " expanded" : ""}`}
                          onClick={() => setExpandedActions((prev) => {
                            const key = `${a.ts}:${a.script?.slice(0,40)}`;
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key); else next.add(key);
                            return next;
                          })}
                          title={a.script && a.script.length > 120 ? "Click to expand/collapse" : undefined}
                        >{a.script || "(no script)"}</div>
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
      </div>
    );
  }
