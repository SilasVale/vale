import { useEffect, useMemo, useRef, useState } from "react";
import type { usePlugins } from "../hooks/usePlugins";

// dsh PluginInventory-style plugin page (round-admin-ui Task 6): a
// searchable catalog — four-state dots (success/warn/error/ongoing per the
// design spec) + enabled pills — plus the playwright control card (run
// state, capsule start/stop buttons, and a log of every attempt with the
// verbatim agent error message on failures). ALL text here is rendered as
// React text nodes — never innerHTML.

function fmtUptime(startedAtMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function PluginsPage({ plugins }: { plugins: ReturnType<typeof usePlugins> }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!query) return plugins.rows;
    return plugins.rows.filter((r) =>
      r.name.toLowerCase().includes(query) ||
      r.displayName.toLowerCase().includes(query) ||
      (r.description || "").toLowerCase().includes(query)
    );
  }, [plugins.rows, query]);

  const logRef = useRef<HTMLDivElement>(null);
  const prevLogLen = useRef(plugins.log.length);
  // Keep the newest log line visible (the tail is what the operator needs).
  useEffect(() => {
    if (plugins.log.length > prevLogLen.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
    prevLogLen.current = plugins.log.length;
  }, [plugins.log]);

  const pw = plugins.playwrightRow;

  return (
    <div id="plugins-view">
      <header className="plug-header">
        <h2 className="plug-title">Plugins</h2>
        <p className="plug-sub">Device tooling and browser automation. Enabled plugins are available to every client.</p>
      </header>
      <div className="plug-search-wrap">
        <input
          className="plug-search"
          type="search"
          placeholder="Search plugins…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search plugins"
          autoComplete="off"
        />
        {/* round-161: the pill counts the FILTERED rows (it ignored the search
            before, showing the full count while the list shrank). */}
        <span className="plug-count">{rows.length}</span>
      </div>
      <div className="plug-inventory">
        {!plugins.specLoaded ? (
          <p className="plug-empty">Loading inventory…</p>
        ) : rows.length === 0 ? (
          <p className="plug-empty">No plugins match “{q}”</p>
        ) : rows.map((r) => (
          <div className="plug-row" key={r.name}>
            <span className="plug-dot" data-state={r.state} />
            <span className="plug-name" title={r.name}>{r.displayName}</span>
            <span className="plug-desc" title={r.description}>{r.description}</span>
            {typeof r.toolCount === "number" && (
              /* stage-n: MCP surface of the plugin — the number clients care about */
              <span className="plug-tools" title={`${r.toolCount} MCP tools`}>{r.toolCount} tools</span>
            )}
            <span className="plug-tag" data-state={r.state}>{r.stateLabel}</span>
            {r.enabled && <span className="plug-pill">Enabled</span>}
          </div>
        ))}
      </div>
      {plugins.loadError && <p className="plug-error">{plugins.loadError}</p>}

      <section className="plug-card">
        <header className="plug-card-head">
          {/* muted while the first status poll is pending (≤ one poll) */}
          <span className="plug-dot" data-state={pw ? pw.state : "muted"} />
          <span className="plug-card-title">Playwright</span>
          {pw && <span className="plug-tag" data-state={pw.state}>{pw.stateLabel}</span>}
          {pw?.playwright?.running ? (
            <span className="plug-meta">
              port {pw.playwright.port} · up {fmtUptime(pw.playwright.started_at ?? Date.now())}
            </span>
          ) : (
            <span className="plug-meta">bundled playwright-mcp · Chromium (task-hosted)</span>
          )}
          <span className="plug-actions">
            <button
              className="plug-btn"
              disabled={!pw || pw.state === "ongoing" || plugins.busy !== null}
              onClick={plugins.start}
            >
              {plugins.busy === "start" ? "Starting…" : "Start"}
            </button>
            <button
              className="plug-btn danger"
              disabled={!pw || pw.state !== "ongoing" || plugins.busy !== null}
              onClick={plugins.stop}
            >
              {plugins.busy === "stop" ? "Stopping…" : "Stop"}
            </button>
          </span>
        </header>
        <p className="plug-card-desc">
          {pw?.description || "playwright-mcp browser automation"} — loopback-only listener (port {pw?.playwright?.port ?? 9229}) with a per-launch token.
        </p>
        <div className="plug-log" ref={logRef} aria-label="Playwright start/stop log">
          {plugins.log.length === 0 ? (
            <p className="plug-log-empty">No start/stop actions yet.</p>
          ) : plugins.log.map((l, i) => (
            <p key={i} className={`plug-log-line${l.error ? " error" : ""}`}>
              <span className="plug-log-ts">[{l.ts}]</span> {l.text}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}
