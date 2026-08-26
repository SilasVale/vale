// round-147: dsh-style icon rail — brand mark on top, section nav, settings
// at the bottom, connection dot pinned to the foot. Light theme, SF-ish
// glyphs drawn as inline SVG so no icon font is needed.
export function IconRail({ view, onViewChange, onShowSettings, connected }: {
  view: "sessions" | "plugins";
  onViewChange: (v: "sessions" | "plugins") => void;
  onShowSettings: () => void;
  connected: boolean;
}) {
  const btn = (active: boolean) =>
    `rail-btn${active ? " active" : ""}`;
  return (
    <>
      <div className="rail-brand" title="Vale Agent">V</div>
      <button
        className={btn(view === "sessions")}
        title="Sessions"
        onClick={() => onViewChange("sessions")}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 14.5v-9Zm2.5-1a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-9a1.5 1.5 0 0 0-1.5-1.5h-9Z" fill="currentColor"/>
          <rect x="6" y="6" width="8" height="8" rx="1.5" fill="currentColor"/>
        </svg>
      </button>
      <button
        className={btn(view === "plugins")}
        title="Plugins"
        onClick={() => onViewChange("plugins")}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 3h2v2h6V3h2v2h1.5A2.5 2.5 0 0 1 19 7.5v8A2.5 2.5 0 0 1 16.5 18h-13A2.5 2.5 0 0 1 1 15.5v-8A2.5 2.5 0 0 1 3.5 5H5V3Zm0 4h10.5a.5.5 0 0 0 .5-.5V8H4v-1.5a.5.5 0 0 0-.5-.5h1.5Z" fill="currentColor"/>
        </svg>
      </button>
      <div className="rail-spacer" />
      <button className="rail-btn" title="Settings" onClick={onShowSettings}>
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M9.5 1.5a8 8 0 0 1 1.7.18l.5 1.7a1 1 0 0 0 .58.65l1.6.62a1 1 0 0 0 1-.14l1.3-1.1a8 8 0 0 1 2.69 2.68l-1.1 1.3a1 1 0 0 0-.14 1l.62 1.6a1 1 0 0 0 .65.58l1.7.5a8 8 0 0 1 0 3.4l-1.7.5a1 1 0 0 0-.65.58l-.62 1.6a1 1 0 0 0 .14 1l1.1 1.3a8 8 0 0 1-2.68 2.69l-1.3-1.1a1 1 0 0 0-1-.14l-1.6.62a1 1 0 0 0-.58.65l-.5 1.7a8 8 0 0 1-3.4 0l-.5-1.7a1 1 0 0 0-.58-.65l-1.6-.62a1 1 0 0 0-1 .14l-1.3 1.1a8 8 0 0 1-2.68-2.68l1.1-1.3a1 1 0 0 0 .14-1l-.62-1.6a1 1 0 0 0-.65-.58l-1.7-.5a8 8 0 0 1 0-3.4l1.7-.5a1 1 0 0 0 .65-.58l.62-1.6a1 1 0 0 0-.14-1l-1.1-1.3a8 8 0 0 1 2.68-2.68l1.3 1.1a1 1 0 0 0 1 .14l1.6-.62a1 1 0 0 0 .58-.65l.5-1.7a8 8 0 0 1 1.7-.18ZM9.5 6a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" fill="currentColor"/>
        </svg>
      </button>
      <div className={`rail-dot${connected ? " on" : ""}`} title={connected ? "connected" : "disconnected"} />
    </>
  );
}