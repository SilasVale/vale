# vale-agent

Windows device MCP server — terminal (PTY/SSH/serial), memory, system tools
and a web panel, with an Electron desktop shell. Installable as a global npm
package; the `vale` CLI manages setup, updates and the tunnel.

## Install (fresh device)

```powershell
npm i -g vale-agent
vale setup --reg-key <key-from-console>   # --reg-key is optional (local mode works without it)
```

`setup` installs to the registry-configured directory
(`HKLM\SOFTWARE\Vale\Agent\InstallDir`), registers the boot-start
`ValeAgent` scheduled task as SYSTEM (no execution-time limit,
restart-on-failure ×8, 5-min repetition watchdog) and starts it. With a
registration key the device registers itself with a Vale Gate console.

## Update (one click)

```powershell
npm i -g vale-agent
vale update
```

`update` stages the new exe + bridge.js, then swaps them via a WMI-launched
script (survives the CLI and the agent dying): stop task → kill agent +
bridge node tree → copy with retry → restart task. The terminal connection
drops ~10 s; reconnect afterwards. Even a failed copy restarts the task —
the device is never left dark.

## CLI commands

```
vale <setup|status|start|stop|restart|update|uninstall|run|tunnel>
```

## Features

- **OSC 633 shell integration** (VS Code approach): PowerShell prompts and
  command boundaries arrive as invisible sequences — clean display, exit codes.
- **37 MCP tools**: terminal (PTY/SSH/serial, history with exit codes, SFTP,
  saved connections, secrets, background jobs), memory (6), system (6),
  mcp-client (4), update, design.
- **Electron desktop shell**: tray with live agent status, native menu,
  CDP :9333 for AI-driven UI.
- **Memory plugin**: device-local knowledge base with multi-word search and
  compaction.

## License

MIT — see the repository LICENSE.
