


// Toolbar: PTY / SSH / Serial quick-actions + Export + Settings. The SSH and
// Serial modals are separate components (ConnModal); this renders the buttons
// and the Settings modal.
// round-133: PTY/SSH/Serial 新建入口移到侧栏 Sessions 标题旁的 "+" 下拉;
// 工具栏只保留全局操作(导出/设置)。
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
