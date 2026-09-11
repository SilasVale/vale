# vale-agent

Windows device MCP server — terminal (PTY/SSH/serial), memory, system tools
and a web panel, with an Electron desktop shell. Installable as a global npm
package; the `vale` CLI manages setup, updates and the tunnel.

## Install (fresh device)

```powershell
npm i -g https://agent.saisi.online/vale-agent/vale-agent-latest.tgz
vale setup --reg-key <key-from-console>   # --reg-key is optional (local mode works without it)
```

`setup` installs to the registry-configured directory
(`HKLM\SOFTWARE\Vale\Agent\InstallDir`), registers the boot-start
`ValeAgent` scheduled task as SYSTEM (no execution-time limit,
restart-on-failure ×8, 5-min repetition watchdog) and starts it. With a
registration key the device registers itself with a Vale Gate console.

## Update (one click)

```powershell
npm i -g --prefix (Split-Path (Get-Command vale).Source) https://agent.saisi.online/vale-agent/vale-agent-latest.tgz
vale update
```

**The `--prefix` is not optional on a device that is already set up.** Plain
`npm i -g <url>` installs into npm's DEFAULT global prefix, which is not where
`vale` lives when the agent runs as SYSTEM. On a real device the two prefixes
disagreed (`vale` resolved to `D:\Vale\components\npm-global\vale.ps1` while
`npm prefix -g` was `C:\WINDOWS\system32\config\systemprofile\AppData\Roaming\npm`):
npm printed success, `vale update` then ran the OLD CLI from the other prefix and
staged the OLD exe, and the device quietly stayed on its previous release with no
error anywhere. `Split-Path (Get-Command vale).Source` asks the machine where
`vale` actually is, so the install lands where the running CLI will find it.

That applies to UPDATE only. A fresh install has no `vale` to ask, and the
command above this section is correct as written.

Verify by EFFECT, not by exit code: after the update, `/api/status` must report
the new release AND `etc\.vale-release` must equal it. The exe's mtime is what
caught the silent case last time.

`update` stages the new exe, then swaps it via a WMI-launched
script (survives the CLI and the agent dying): stop task → kill agent
tree → copy with retry → restart task. The terminal connection
drops ~10 s; reconnect afterwards. Even a failed copy restarts the task —
the device is never left dark.

## CLI commands

```
vale <setup|status|start|stop|restart|update|uninstall|run|tunnel>
```

## Features

- **OSC 633 shell integration** (VS Code approach): PowerShell prompts and
  command boundaries arrive as invisible sequences — clean display, exit codes.
- **49 MCP tools**: terminal (26: PTY/SSH/serial, history with exit codes, SFTP,
  saved connections, secrets, background jobs), memory (6), system (9),
  mcp-client (4), update (agent_update), design (page_view).
- **Electron desktop shell**: tray with live agent status, native menu,
  CDP :9333 for AI-driven UI.
- **Memory plugin**: device-local knowledge base with multi-word search and
  compaction.

## License

MIT — see the repository LICENSE.
