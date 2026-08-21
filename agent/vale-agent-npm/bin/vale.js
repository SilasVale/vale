#!/usr/bin/env node
/**
 * vale CLI — setup / status / update / run for the Vale Agent service.
 * The exe ships inside this package; commands manage the scheduled tasks
 * and the install directory (default %LOCALAPPDATA%\vale-agent).
 */
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXE_SRC = path.join(__dirname, "..", "vale-agent.exe");
const DIR = process.env.VALE_AGENT_DIR || path.join(process.env.LOCALAPPDATA || "C:\\ProgramData", "vale-agent");
const EXE_DST = path.join(DIR, "vale-agent.exe");

function sh(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: "inherit", ...opts });
}
function ps(script) {
  return sh(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`);
}

const commands = {
  status() {
    const running = spawnSync("tasklist", ["/FI", `IMAGENAME eq vale-agent.exe`], { shell: true, encoding: "utf8" }).stdout || "";
    console.log(running.includes("vale-agent.exe") ? "status: RUNNING" : "status: STOPPED");
    console.log("install dir:", DIR);
    console.log("panel:", fs.existsSync(EXE_DST) ? "http://127.0.0.1:18080/panel/" : "(not installed)");
  },

  update() {
    // Swap the exe in-place: stop tasks -> replace -> restart tasks.
    // Runs the swap via a detached helper so killing the agent never kills
    // the updater (the MCP terminal itself rides on the agent).
    if (!fs.existsSync(EXE_SRC)) { console.error("exe missing from package:", EXE_SRC); process.exit(1); }
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = path.join(DIR, "vale-agent.new.exe");
    fs.copyFileSync(EXE_SRC, tmp);
    const script = `
      $ErrorActionPreference = 'Stop'
      schtasks /End ValeAgentTray 2>$null | Out-Null
      Stop-Process -Name vale-tray -Force -ErrorAction SilentlyContinue
      Stop-Process -Name vale-agent -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
      Copy-Item -Force "${tmp}" "${EXE_DST}"
      schtasks /Run ValeAgent 2>$null | Out-Null
      schtasks /Run ValeAgentTray 2>$null | Out-Null
      Write-Output 'update: swapped and restarted'
    `;
    fs.writeFileSync(path.join(DIR, "vale-update.ps1"), script);
    // Detached: survives the agent process dying mid-swap.
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
      "-File", path.join(DIR, "vale-update.ps1")], { detached: true, stdio: "ignore" });
    r.unref();
    console.log("update: swap launched (connection will drop, reconnect in ~5s)");
  },

  setup(args) {
    const regKeyIdx = args.indexOf("--reg-key");
    const regKey = regKeyIdx >= 0 ? args[regKeyIdx + 1] : process.env.VALE_REG_KEY;
    if (!regKey) {
      console.error("usage: vale setup --reg-key <key>   (get a key from the Vale console > Devices)");
      process.exit(1);
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(EXE_SRC, EXE_DST);
    // Register + start via scheduled tasks (SYSTEM, boot+logon triggers),
    // then hand off registration to the agent's own first-run flow:
    // the device registers itself on start with VALE_REG_KEY set.
    ps(`schtasks /Create /F /TN ValeAgent /SC ONSTART /RU SYSTEM /RL HIGHEST /TR "'${EXE_DST}' --register '${regKey}'"`);
    ps(`schtasks /Create /F /TN ValeAgentTray /SC ONLOGON /TR "'${path.join(DIR, "vale-tray.exe")}'"`);
    ps(`schtasks /Run ValeAgent`);
    console.log("setup: installed to", DIR);
    console.log("setup: device registers on start — check the console Devices list");
  },

  run(args) {
    console.log("running vale-agent (foreground, Ctrl+C to stop)");
    const r = spawnSync(EXE_SRC, args.length ? args : [], { stdio: "inherit" });
    process.exitCode = r.status ?? 0;
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  console.log("vale <setup|status|update|run> — Vale Agent control");
  console.log("  setup --reg-key K   register this device with the console");
  console.log("  status              show run state + panel URL");
  console.log("  update              swap in the packaged exe (restarts agent)");
  console.log("  run [args...]       run the agent in the foreground");
  process.exit(cmd ? 1 : 0);
}
commands[cmd](rest);
