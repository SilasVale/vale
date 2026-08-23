#!/usr/bin/env node
/**
 * vale CLI — DSH-style management for the Vale Agent.
 *
 * The agent is a headless auto-start service; management lives here (CLI)
 * and in the web panel (http://127.0.0.1:18080/panel/, desktop shortcut
 * created by setup). The native tray was retired 2026-08-22.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXE_SRC = path.join(__dirname, "..", "vale-agent.exe");
const DIR =
  process.env.VALE_AGENT_DIR ||
  path.join(process.env.LOCALAPPDATA || "C:\\ProgramData", "vale-agent");
const EXE_DST = path.join(DIR, "vale-agent.exe");
const TASK = "ValeAgent";

function sh(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: "inherit", ...opts });
}
function ps(script) {
  sh(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`);
}
function svc(action) {
  sh(`schtasks /${action} /TN ${TASK}`, { stdio: "inherit" });
}

const commands = {
  setup(args) {
    const i = args.indexOf("--reg-key");
    const regKey = i >= 0 ? args[i + 1] : process.env.VALE_REG_KEY;
    if (!regKey) {
      console.error(
        "usage: vale setup --reg-key <key>   (get a key from the Vale console > Devices)"
      );
      process.exit(1);
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(EXE_SRC, EXE_DST);
    // Register boot-start task (SYSTEM) and kick it once; the agent's own
    // first-run flow registers the device with the console using the key.
    //
    // round-118: this used to be a raw `schtasks /Create /SC ONSTART`, which
    // inherits Task Scheduler defaults — a 72h execution limit that silently
    // kills the agent after 3 days (device goes dark until reboot), plus no
    // restart-on-failure. Register via ScheduledTask cmdlets with the full
    // hardening set instead (mirrors deploy/vale-agent-setup.ps1):
    //   - ExecutionTimeLimit 0        never kill the running task
    //   - RestartOnFailure 8 x 1min   scheduler retries after a crash
    //   - battery-safe + StartWhenAvailable
    //   - 5-min repetition watchdog   IgnoreNew = no-op while running;
    //                                 restarts within <=5 min if dead
    const reg = [
      `$action = New-ScheduledTaskAction -Execute '${EXE_DST}' -Argument "'${EXE_DST}' --register '${regKey}'"`,
      "$boot = New-ScheduledTaskTrigger -AtStartup",
      "$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 5)",
      "$principal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest",
      "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 8 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable",
      "Register-ScheduledTask ValeAgent -Action $action -Trigger @($boot,$watch) -Principal $principal -Settings $settings -Force | Out-Null",
      "Start-ScheduledTask ValeAgent",
    ].join("; ");
    ps(reg);
    console.log("setup: installed to", DIR);
    console.log("setup: device registers on start — check the console Devices list");
  },

  status() {
    const out =
      spawnSync("tasklist", ["/FI", "IMAGENAME eq vale-agent*"], {
        shell: true,
        encoding: "utf8",
      }).stdout || "";
    console.log(out.includes("vale-agent") ? "status: RUNNING" : "status: STOPPED");
    console.log("install dir:", DIR);
    console.log(
      "panel:",
      fs.existsSync(EXE_DST) ? "http://127.0.0.1:18080/panel/" : "(not installed)"
    );
  },

  start() {
    svc("Run");
  },

  stop() {
    svc("End");
    console.log("stopped — 'vale start' to resume");
  },

  restart() {
    svc("End");
    sh("timeout /t 2 >nul");
    svc("Run");
  },

  update() {
    // Swap the exe in-place: stop -> replace (with retry; the running agent
    // locks its own file briefly after death) -> start. Runs detached so
    // killing the agent never kills the updater.
    if (!fs.existsSync(EXE_SRC)) {
      console.error("exe missing from package:", EXE_SRC);
      process.exit(1);
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(EXE_SRC, path.join(DIR, "vale-agent.new.exe"));
    const script = [
      "Start-Sleep -Milliseconds 1200",
      "$ok=$false",
      "foreach($i in 1..12){ try { Copy-Item -Force -ErrorAction Stop D:\\vale-agent\\vale-agent.new.exe D:\\vale-agent\\vale-agent.exe; $ok=$true; break } catch { Start-Sleep -Milliseconds 800 } }",
      "if(-not $ok){ throw 'copy failed' }",
      "Start-ScheduledTask ValeAgent",
    ].join("\r\n");
    fs.writeFileSync(path.join(DIR, "vale-update.ps1"), script);
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        path.join(DIR, "vale-update.ps1"),
      ],
      { detached: true, stdio: "ignore" }
    );
    r.unref();
    console.log("update: swap launched (connection drops, reconnect in ~5s)");
  },

  run(args) {
    console.log("running vale-agent (foreground, Ctrl+C to stop)");
    const r = spawnSync(EXE_DST || EXE_SRC, args.length ? args : [], {
      stdio: "inherit",
    });
    process.exitCode = r.status ?? 0;
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  console.log("vale <setup|status|start|stop|restart|update|run> — Vale Agent control");
  Object.keys(commands).forEach((k) => console.log(" ", k));
  process.exit(cmd ? 1 : 0);
}
commands[cmd](rest);
