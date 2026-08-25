# vale-agent (npm distribution)

Self-hosted npm package for one-click install/update of the Vale Agent on
Windows devices. Ships `vale-agent.exe`, `bridge.js` (interactive browser
bridge) and the `vale` management CLI.

## Install (fresh device)

```powershell
npm i -g https://agent.saisi.online/vale-agent/vale-agent-<version>.tgz
vale setup --reg-key <key-from-console>
```

`setup` copies the exe to `D:\vale-agent` (override with `VALE_AGENT_DIR`),
registers the boot-start `ValeAgent` scheduled task as SYSTEM
(no execution-time limit, restart-on-failure ×8, 5-min repetition watchdog)
and starts it. The device registers itself with the console using the key.

## Update (one click)

```powershell
npm i -g https://agent.saisi.online/vale-agent/vale-agent-<newer>.tgz
vale update
```

`update` stages the new exe + bridge.js, then swaps them via a WMI-launched
script (survives the CLI and the agent dying): stop task → kill agent +
bridge node tree → copy with retry → restart task. The terminal connection
drops ~10 s; reconnect afterwards. Even a failed copy restarts the task —
the device is never left dark.

## CLI commands

```
vale <setup|status|start|stop|restart|update|run>
```

## Publishing a new version (from the repo)

```bash
# from agent/ — panel changes must be built BEFORE compiling (embedded):
cd resources/panel-react && npm run build && npm test && cd ../..
cargo xwin build --target x86_64-pc-windows-msvc --release --features terminal,keyring --bin vale-agent

cp target/x86_64-pc-windows-msvc/release/vale-agent.exe vale-agent-npm/
cp resources/browser-bridge/bridge.js vale-agent-npm/   # when bridge changed
# bump "version" below, then:
cd vale-agent-npm && npm pack
cp vale-agent-<ver>.tgz ../../index/public/vale-agent/
cd ../../index && CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token) npx wrangler deploy
```

Devices pick it up with the two-command update above. Do NOT hand-roll
kill/copy/restart over an agent-hosted terminal — see `agent/CLAUDE.md`.
