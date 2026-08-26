


// Toolbar: PTY / SSH / Serial quick-actions + Export + Settings. The SSH and
// Serial modals are separate components (ConnModal); this renders the buttons
// and the Settings modal.
// round-133: the PTY/SSH/Serial new-session entries moved to the "+" dropdown
// beside the sidebar's Sessions title; the toolbar keeps only global actions
// (export/settings).
export function Toolbar({ onExportAll, onShowSettings }: {
  onExportAll: () => void;
  onShowSettings: () => void;
}) {
  return (
    <div id="toolbar">
      <div id="tabs-placeholder" style={{ display: "none" }} />
      <div id="toolbar-actions">
        <button id="export-all" title="Export all session logs" onClick={onExportAll}>Export</button>
        <button id="open-settings" title="Settings" onClick={onShowSettings}>Settings</button>
      </div>
    </div>
  );
}
