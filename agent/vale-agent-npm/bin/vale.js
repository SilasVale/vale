#!/usr/bin/env node
/**
 * vale CLI — DSH-style management for the Vale Agent.
 *
 * The agent is a headless auto-start service; management lives here (CLI)
 * and in the web panel (http://127.0.0.1:18080/panel/, desktop shortcut
 * created by setup). The native tray was retired 2026-08-22.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXE_SRC = path.join(__dirname, "..", "vale-agent.exe");
// Canonical install dir — same one deploy/vale-agent-setup.ps1 uses, so the
// npm path and the legacy setup script land on the identical exe/task.
const DIR =
  process.env.VALE_AGENT_DIR || "D:\\vale-agent";
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
    // round-desktop: ship the vale-desktop shell (Tauri 2) alongside the
    // agent — a portable exe, no installer needed (WebView2 ships with
    // Win10/11). setup copies it and creates a desktop shortcut so the user
    // gets an app-like entry (tray + independent window over /desktop/).
    const DESKTOP_SRC = path.join(__dirname, "..", "vale-desktop.exe");
    if (fs.existsSync(DESKTOP_SRC)) {
      fs.copyFileSync(DESKTOP_SRC, path.join(DIR, "vale-desktop.exe"));
      const q = DIR.replace(/'/g, "''");
      ps(
        [
          "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\Vale.lnk')",
          `$s.TargetPath='${q}\\vale-desktop.exe'`,
          `$s.WorkingDirectory='${q}'`,
          "$s.Save()",
        ].join("; ")
      );
      console.log("setup: vale-desktop installed + desktop shortcut created");
    } else {
      console.log("setup: vale-desktop not in package (skipped)");
    }
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
    // locks its own file) -> start.
    if (!fs.existsSync(EXE_SRC)) {
      console.error("exe missing from package:", EXE_SRC);
      process.exit(1);
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(EXE_SRC, path.join(DIR, "vale-agent.new.exe"));
    // round-desktop: keep the desktop shell in sync on update too (portable
    // exe; harmless when absent).
    const DESKTOP_SRC = path.join(__dirname, "..", "vale-desktop.exe");
    if (fs.existsSync(DESKTOP_SRC)) {
      fs.copyFileSync(DESKTOP_SRC, path.join(DIR, "vale-desktop.new.exe"));
    }
    // round-137 Plan C: ship bridge.js alongside the exe — otherwise the
    // device keeps running the old bridge and the new protocol (idle frames /
    // command receipts) never reaches the device (exe updated but bridge not;
    // hit on d1).
    const BRIDGE_SRC = path.join(__dirname, "..", "bridge.js");
    if (fs.existsSync(BRIDGE_SRC)) {
      fs.copyFileSync(BRIDGE_SRC, path.join(DIR, "bridge.new.js"));
    }
    const q = DIR.replace(/'/g, "''");
    const log = `Out-File '${q}\\vale-update.log' -Append`;
    // round-143: write the run-hidden.vbs wrapper next to node.exe, so the
    // ValePlaywright scheduled task can launch node.exe without flashing a
    // visible cmd window. Idempotent — overwrites any existing copy.
    const pwDir = path.join(DIR, "playwright");
    const vbsPath = path.join(pwDir, "run-hidden.vbs");
    if (fs.existsSync(pwDir)) {
      // round-143: ASCII-only VBS (no em-dash, no Unicode). VBScript on
      // Windows uses the system locale; non-ASCII in comments corrupts the
      // file and causes "unterminated string constant" (800A0409). Use chr(34)
      // to produce literal double-quotes without string-escaping issues.
      fs.writeFileSync(
        vbsPath,
        [
          "Dim sh,cmd,i",
          "Set sh=CreateObject(\"WScript.Shell\")",
          "cmd=chr(34) & WScript.Arguments(0) & chr(34) & \" \" & chr(34) & WScript.Arguments(1) & chr(34)",
          "For i=2 To WScript.Arguments.Count-1",
          "  cmd=cmd & \" \" & WScript.Arguments(i)",
          "Next",
          "sh.Run cmd,0,False",
        ].join("\r\n"),
      );
    }
    const script = [
      `"[$(Get-Date -Format o)] update start" | ${log}`,
      // A running exe cannot be overwritten on Windows — stop the service
      // first (task end + process kill), THEN swap with retry.
      "try { Stop-ScheduledTask ValeAgent -ErrorAction Stop } catch {}",
      "Get-Process vale-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
      // The bridge is a child of the agent (node bridge.js on 9224); killing
      // the tree frees 9224 so the restarted agent re-spawns the NEW bridge.
      "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*vale-agent*' } | Stop-Process -Force -ErrorAction SilentlyContinue",
      "Start-Sleep -Milliseconds 1500",
      "$ok=$false",
      `foreach($i in 1..12){ try { Copy-Item -Force -ErrorAction Stop '${q}\\vale-agent.new.exe' '${q}\\vale-agent.exe'; $ok=$true; break } catch { Start-Sleep -Milliseconds 800 } }`,
      `"[$(Get-Date -Format o)] copy ok=$ok" | ${log}`,
      `Remove-Item -Force -ErrorAction SilentlyContinue '${q}\\vale-agent.new.exe'`,
      `if (Test-Path '${q}\\bridge.new.js') { Copy-Item -Force '${q}\\bridge.new.js' '${q}\\bridge.js'; Remove-Item -Force '${q}\\bridge.new.js' }`,
      // NEVER leave the device dark: even a failed swap must bring the task
      // back up (it will run the old exe until the next update).
      `try { Start-ScheduledTask ValeAgent -ErrorAction Stop } catch { schtasks /Run /TN ValeAgent }`,
      `"[$(Get-Date -Format o)] task restarted" | ${log}`,
      // round-143: re-register ValePlaywright via the wscript/VBS wrapper so
      // node.exe no longer allocates a visible console. Idempotent — task may
      // not exist (older install paths), so wrap in try/catch.
      `$pwVbs = '${q}\\playwright\\run-hidden.vbs'`,
      `if (Test-Path $pwVbs) {`,
      `  $pwNode = '${q}\\playwright\\node.exe'`,
      `  $pwCli  = '${q}\\playwright\\node_modules\\@playwright\\mcp\\cli.js'`,
      `  if (Test-Path $pwNode -and Test-Path $pwCli) {`,
      // Read the CURRENT task's UserId BEFORE unregistering — we need to know
      // who the task runs as (Administrator), but $env:USERNAME returns
      // "SYSTEM" when spawned via WMI, and Win32_ComputerSystem.UserName is
      // empty from session 0. The existing task's Principal is the most
      // reliable source. Fall back to the local user if the task doesn't exist.
      `    $oldTask = Get-ScheduledTask -TaskName 'ValePlaywright' -ErrorAction SilentlyContinue`,
      `    $pwUser = if ($oldTask) { $oldTask.Principal.UserId } else { (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName -replace '^.*\\\\', '' }`,
      `    try { Unregister-ScheduledTask -TaskName 'ValePlaywright' -Confirm:$false -ErrorAction SilentlyContinue } catch {}`,
      `    $pwArgs = '"' + $pwVbs + '" "' + $pwNode + '" "' + $pwCli + '" --port 9229 --browser chromium --host 127.0.0.1 --headless --ignore-https-errors --allowed-hosts "127.0.0.1:9229,localhost:9229"'`,
      `    $pwAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\wscript.exe') -Argument $pwArgs`,
      `    $pwBoot = New-ScheduledTaskTrigger -AtLogOn`,
      `    $pwWatch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)`,
      `    $pwSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable`,
      `    Register-ScheduledTask -TaskName 'ValePlaywright' -Action $pwAction -Trigger @($pwBoot, $pwWatch) -Principal (New-ScheduledTaskPrincipal -UserId $pwUser -LogonType Interactive -RunLevel Limited) -Settings $pwSettings -Force | Out-Null`,
      `    Start-ScheduledTask -TaskName 'ValePlaywright' | Out-Null`,
      `    "[$(Get-Date -Format o)] ValePlaywright re-registered (hidden via vbs, user=$pwUser)" | ${log}`,
      `  }`,
      `}`,
    ].join("\r\n");
    fs.writeFileSync(path.join(DIR, "vale-update.ps1"), script);
    // Launch the swap via WMI Win32_Process.Create: the child is parented by
    // WmiPrvSE, outside any caller job, so it survives this CLI (and the
    // agent it kills) dying — node's detached spawn does NOT (observed d1).
    //
    // Flags matter on this path: children created via WMI with
    // `-ExecutionPolicy Bypass` or `-EncodedCommand` in their command line
    // die silently before running anything (d1, no Defender ASR events —
    // cause unconfirmed). Plain `powershell -NoProfile -File` works. That
    // requires script execution to be allowed, so lift Restricted here once;
    // RemoteSigned is Microsoft's recommended default for automation hosts.
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "if((Get-ExecutionPolicy) -eq 'Restricted'){ Set-ExecutionPolicy RemoteSigned -Scope LocalMachine -Force }",
      ],
      { stdio: "ignore", timeout: 30000 },
    );
    const ps1 = path.join(DIR, "vale-update.ps1");
    const inner = `powershell -NoProfile -File "${ps1}"`;
    const wmi = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${inner.replace(/'/g, "''")}'} | Select-Object ProcessId,ReturnValue`;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", wmi], {
      stdio: "inherit",
      timeout: 20000,
    });
    if (r.status !== 0) {
      console.error("update: WMI handoff failed");
      process.exit(1);
    }
    console.log("update: swap launched (connection drops, reconnect in ~10s)");
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
