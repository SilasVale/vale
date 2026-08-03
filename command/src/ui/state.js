// Vale Command UI — shared state (single source of truth)

const state = {
  events: [],          // event ring (cap 50)
  evCount: 0,
  lastSeq: 0,          // last server-assigned event seq (poll cursor)
  pinned: false,       // if true, MCP events won't auto-switch view
  activeTab: 'browser',
  lastTabId: 'tab-0',
  terms: {},           // sid -> { label, term, fitAddon, container, observer }
  activeTermId: null,
  xtermLoaded: false,
  tabUrls: {},         // tabId -> url
  closedTerms: new Set(),
  showBrowserTimer: null,
  connType: 'pty',
  connecting: false,   // doConnect in flight — guards double-submit
  savedConns: [],
  termBuf: {},         // sid -> buffered bytes before xterm ready
  version: '',         // set from get_status at boot (transport.refreshVersion)
};

export default state;
