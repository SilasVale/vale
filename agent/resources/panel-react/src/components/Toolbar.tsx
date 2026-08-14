


// Toolbar: PTY / SSH / Serial quick-actions + Export + Settings. The SSH and
// Serial modals are separate components (ConnModal); this renders the buttons
// and the Settings modal.
export function Toolbar({ onOpenPty, onShowConn, onExportAll, onShowSettings }: {
  onOpenPty: () => void;
  onShowConn: (kind: "ssh" | "serial") => void;
  onExportAll: () => void;
  onShowSettings: () => void;
}) {
  return (
    <div id="toolbar">
      <div id="tabs-placeholder" style={{ display: "none" }} />
      <div id="toolbar-actions">
        <button id="new-session" title="New local shell" onClick={onOpenPty}>PTY</button>
        <button id="new-ssh" title="New SSH connection" onClick={() => onShowConn("ssh")}>SSH</button>
        <button id="new-serial" title="New serial connection" onClick={() => onShowConn("serial")}>Serial</button>
        <button id="export-all" title="Export all session logs" onClick={onExportAll}>Export</button>
        <button id="open-settings" title="Settings" onClick={onShowSettings}>Settings</button>
      </div>
    </div>
  );
}
