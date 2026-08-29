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

// C1 (2026-08-28): the registry is the single source of truth for the install
// dir. Resolution: $env:VALE_AGENT_DIR → HKLM\SOFTWARE\Vale\Agent\InstallDir
// → default. No legacy directory probing — the installer/setup always write
// the registry, and all commands use this one DIR.
function resolveDir() {
  if (process.env.VALE_AGENT_DIR) return process.env.VALE_AGENT_DIR;
  try {
    const out = spawnSync("reg", ["query", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "InstallDir"], { encoding: "utf8" });
    if (out.status === 0 && out.stdout) {
      const m = /REG_SZ\s+(.+)/.exec(out.stdout.split(/\r?\n/).find((l) => l.includes("InstallDir")) || "");
      if (m && m[1].trim()) return m[1].trim();
    }
  } catch { /* fall through */ }
  return "C:\\Program Files\\Vale";
}

const DIR = resolveDir();
const EXE_DST = path.join(DIR, "vale-agent.exe");
const TASK = "ValeAgent";
// Gateway API base — where the console endpoints live (tunnel-token /
// register). Overridable for staging.
const API_BASE = process.env.VALE_API_BASE || "https://api.saisi.online";

// POST JSON to the gateway, return parsed JSON or throw with the error text.
function apiPost(pathname, body) {
  const res = spawnSync("curl", ["-sS", "-m", "30", "-X", "POST",
    "-H", "content-type: application/json",
    "-d", JSON.stringify(body),
    API_BASE + pathname], { encoding: "utf8" });
  if (res.status !== 0) throw new Error("gateway unreachable: " + (res.stderr || "").trim());
  const out = (res.stdout || "").trim();
  try { return JSON.parse(out); } catch { throw new Error("gateway bad response: " + out.slice(0, 120)); }
}

function sh(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: "inherit", ...opts });
}
function ps(script) {
  sh(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`);
}
function svc(action) {
  sh(`schtasks /${action} /TN ${TASK}`, { stdio: "inherit" });
}

// Shared tunnel bootstrap: login (token or interactive) → create tunnel →
// DNS route → write tunnel.yml. Used by `vale setup --tunnel` and
// `vale tunnel install`.
function initTunnel(hostname, regKey) {
  const cf = path.join(DIR, "tools", "cloudflared.exe");
  const cfg = path.join(DIR, "tunnel.yml");
  if (!fs.existsSync(cf)) {
    console.error("tunnel: cloudflared.exe not staged at", cf);
    console.error("  reinstall the package (npm i -g vale-agent) to stage it.");
    process.exit(1);
  }
  const host = hostname || "d1.agent.saisi.online";
  // Login: (1) reg-key → gateway tunnel-token exchange (FULLY automatic —
  // the console's stored Cloudflare credential, no env var, no browser), or
  // (2) CLOUDFLARE_API_TOKEN env, or (3) interactive cloudflared browser
  // login as last resort.
  let token = process.env.CLOUDFLARE_API_TOKEN || "";
  if (!token && regKey) {
    console.log("tunnel: exchanging registration key for the Cloudflare API token...");
    try {
      const r = apiPost("/api/install/tunnel-token", { key: regKey });
      if (r && r.apiToken) { token = r.apiToken; console.log("tunnel: key exchanged (consumed once)"); }
      else console.log("tunnel: tunnel-token exchange failed (" + (r && r.error ? r.error : "no token") + ") — falling back");
    } catch (e) {
      console.log("tunnel: exchange unavailable (" + e.message + ") — falling back");
    }
  }
  const r1 = spawnSync(cf, token ? ["tunnel", "login", "--token", token] : ["tunnel", "login"], { stdio: "inherit" });
  if (r1.status !== 0) { console.error("tunnel: cloudflare login failed"); process.exit(1); }
  const name = "vale-agent-" + host.split(".")[0];
  spawnSync(cf, ["tunnel", "create", name], { stdio: "inherit" });
  const list = spawnSync(cf, ["tunnel", "list", "--name", name], { encoding: "utf8" }).stdout || "";
  const m = /([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})/.exec(list);
  const tunnelId = m ? m[1] : null;
  if (!tunnelId) { console.error("tunnel: could not determine tunnel id"); process.exit(1); }
  const r3 = spawnSync(cf, ["tunnel", "route", "dns", name, host], { stdio: "inherit" });
  if (r3.status !== 0) { console.error("tunnel: dns route failed"); process.exit(1); }
  const cred = path.join(process.env.USERPROFILE || "", ".cloudflared", tunnelId + ".json");
  fs.writeFileSync(cfg, [
    "tunnel: " + tunnelId,
    "credentials-file: " + cred,
    "ingress:",
    "  - hostname: " + host,
    "    service: http://127.0.0.2:18080",
    "  - service: http_status:404",
    "",
  ].join("\n"));
  console.log("tunnel: installed — tunnel.yml written, agent spawns it on boot");
  console.log("  hostname:", host);
}

const commands = {
  // `vale setup` = PURE LOCAL install (no key, no tunnel, no cloud). The
  // gateway/tunnel are OPTIONAL extras configured LATER via the Settings
  // page or the optional flags below:
  //   --reg-key <key>   register the device with the gateway console now
  //   --tunnel <host>   also provision the (free) cloudflared tunnel
  setup(args) {
    let i = args.indexOf("--reg-key");
    let regKey = i >= 0 ? args[i + 1] : process.env.VALE_REG_KEY;
    let ti = args.indexOf("--tunnel");
    let tunnelHost = ti >= 0 ? args[ti + 1] : "";
    let wantTunnel = args.includes("--tunnel") || !!process.env.CLOUDFLARE_API_TOKEN;
    // Device hostname for self-register: explicit --hostname, else default
    // d1.agent.saisi.online. Written to vale-agent.hostname (the agent's
    // self-register reads it at boot).
    const hi = args.indexOf("--hostname");
    const deviceHost = hi >= 0 ? args[hi + 1] : (process.env.VALE_HOSTNAME || "d1.agent.saisi.online");
    fs.writeFileSync(path.join(DIR, "vale-agent.hostname"), deviceHost);
    // No key required for a local install — key/tunnel are optional extras.
    if (regKey) {
      console.log("setup: registering device with the gateway (--reg-key)");
    } else {
      console.log("setup: LOCAL install (no cloud). Configure the gateway later in the Settings page.");
    }
    fs.mkdirSync(DIR, { recursive: true });
    // ---- idempotent reinstall: clean every legacy residue BEFORE writing
    // anything (a re-run of `vale setup` must leave a pristine install).
    // 1. Stop any running vale processes (a live agent locks its exe and the
    //    copy below would fail).
    console.log("setup: stopping existing vale processes...");
    sh("cmd /c schtasks /End /TN ValeAgent 2>NUL");
    sh("taskkill /F /IM vale-agent.exe 2>NUL");
    sh("taskkill /F /IM vale-desktop.exe 2>NUL");
    sh("taskkill /F /IM vale-tray.exe 2>NUL");
    // 2. Remove legacy scheduled tasks (ValePlaywright from old installs,
    //    ValeAgentTray) — ValeAgent is re-registered below with -Force.
    sh("cmd /c schtasks /Delete /TN ValeAgentTray /F 2>NUL");
    sh("cmd /c schtasks /Delete /TN ValePlaywright /F 2>NUL");
    // 3. Remove the legacy Cloudflared Windows service + EventLog source
    //    (installed by the retired setup.ps1; the agent-supervised model
    //    installs no service).
    sh("sc stop Cloudflared 2>NUL");
    sh("sc delete Cloudflared 2>NUL");
    sh("reg delete HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Cloudflared /f 2>NUL");
    // 4. Stale update-busy marker (a crashed update would lock updates).
    const BUSY = path.join(process.env.ProgramData || "C:\\ProgramData", "ValeAgent", "update-busy");
    sh(`powershell -NoProfile -Command "Remove-Item -Force -ErrorAction SilentlyContinue '${BUSY}'"`);
    // 5. Refresh the BOXED playwright bundle: delete the old tree first so a
    //    removed package/version never leaves stale files behind.
    sh(`powershell -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${DIR}\\playwright'"`);
    // 6. Legacy install dirs from retired installers (C:\vale-agent /
    //    D:\vale-agent). If the registry now points at a DIFFERENT dir and a
    //    legacy dir exists, it is a residue of the old channel — remove it
    //    (the data that matters lives in %ProgramData%\Vale; the old dirs
    //    held programs + config only).
    for (const legacy of ["C:\\vale-agent", "D:\\vale-agent"]) {
      if (legacy !== DIR && fs.existsSync(legacy)) {
        console.log("setup: removing legacy install dir", legacy);
        sh(`powershell -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${legacy}'"`);
      }
    }
    // C1: write the registry single source of truth (InstallDir; DataDir
    // defaults to %ProgramData%\Vale). Everything else reads it back.
    try {
      spawnSync("reg", ["add", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "InstallDir", "/t", "REG_SZ", "/d", DIR, "/f"], { stdio: "ignore" });
      spawnSync("reg", ["add", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "DataDir", "/t", "REG_SZ", "/d", path.join(process.env.ProgramData || "C:\\ProgramData", "Vale"), "/f"], { stdio: "ignore" });
    } catch { /* non-fatal — runtime falls back to exe dir */ }
    // Pre-create the data dir tree (sessions/memory/logs — C1 separation).
    const DATA = path.join(process.env.ProgramData || "C:\\ProgramData", "Vale");
    for (const sub of ["sessions", "memory", "logs"]) {
      fs.mkdirSync(path.join(DATA, sub), { recursive: true });
    }
    if (!fs.existsSync(EXE_SRC)) {
      console.error("setup: vale-agent.exe missing from package:", EXE_SRC);
      process.exit(1);
    }
    fs.copyFileSync(EXE_SRC, EXE_DST);
    // B2: stage the boxed playwright bundle (node_modules ONLY — node.exe is
    // NOT bundled; the system node detected below runs it). Single small
    // artifact in the npm package, Vale version-locked.
    const PW_ZIP = path.join(__dirname, "..", "vale-playwright.zip");
    if (fs.existsSync(PW_ZIP)) {
      const pwDir = path.join(DIR, "playwright");
      fs.mkdirSync(pwDir, { recursive: true });
      sh(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${PW_ZIP}' -DestinationPath '${DIR}'"`);
      console.log("setup: playwright bundle staged (node_modules only)");
    } else {
      console.log("setup: vale-playwright.zip not in package (browser tools disabled)");
    }
    // Node runtime: the device has node (npm works), but the agent runs as
    // SYSTEM which may not see the user PATH — resolve the ABSOLUTE node path
    // now and record it in the registry so the agent can spawn it.
    const nodeWhich = spawnSync("where", ["node"], { encoding: "utf8" });
    const nodePath = (nodeWhich.status === 0 && nodeWhich.stdout) ? nodeWhich.stdout.split(/\r?\n/)[0].trim() : "";
    if (nodePath) {
      try {
        spawnSync("reg", ["add", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "NodePath", "/t", "REG_SZ", "/d", nodePath, "/f"], { stdio: "ignore" });
        console.log("setup: system node detected:", nodePath);
      } catch { /* non-fatal */ }
    } else {
      console.log("setup: WARNING — node not found in PATH (browser tools need node)");
    }
    // C2: stage the boxed cloudflared binary into tools/ (optional — local
    // mode works without it; only used when the user opts into public access).
    const CF_SRC = path.join(__dirname, "..", "cloudflared.exe");
    if (fs.existsSync(CF_SRC)) {
      fs.mkdirSync(path.join(DIR, "tools"), { recursive: true });
      fs.copyFileSync(CF_SRC, path.join(DIR, "tools", "cloudflared.exe"));
      console.log("setup: cloudflared staged (tunnel optional — `vale tunnel install` to enable)");
    }
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
    const regArg = regKey ? ` --register '${regKey}'` : "";
    const reg = [
      `$action = New-ScheduledTaskAction -Execute '${EXE_DST}' -Argument "'${EXE_DST}'${regArg}"`,
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
    // Optional: provision the tunnel in the same command (no second step).
    if (wantTunnel) {
      console.log("setup: provisioning cloudflare tunnel...");
      initTunnel(tunnelHost, regKey);
    } else {
      console.log("setup: no tunnel configured (local mode). Enable later with `vale tunnel install <hostname>`.");
    }
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

  // The ONLY uninstall path (NSIS installer is retired — npm CLI is the
  // single install/update channel). Stops the agent, removes the scheduled
  // tasks, deletes the program dir + registry keys. The DATA dir
  // (%ProgramData%\Vale) is KEPT by default (sessions/memory survive);
  // pass --purge-data to delete it too.
  uninstall(args) {
    const purge = args.includes("--purge-data");
    const DATA = path.join(process.env.ProgramData || "C:\\ProgramData", "Vale");
    console.log("uninstall: stopping ValeAgent...");
    sh("cmd /c schtasks /End /TN ValeAgent 2>NUL");
    sh("taskkill /F /IM vale-agent.exe 2>NUL");
    sh("taskkill /F /IM vale-desktop.exe 2>NUL");
    // kill bundled playwright node + boxed cloudflared (best effort)
    // Match ANY node.exe whose command line mentions a vale playwright
    // bundle (covers the current install dir AND legacy dirs like
    // D:\vale-agent\playwright that a fresh uninstall must clear too).
    sh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*vale-agent*playwright*' -or $_.CommandLine -like '*vale-command*playwright*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`);
    sh("taskkill /F /IM cloudflared.exe 2>NUL");
    sh("cmd /c schtasks /Delete /TN ValeAgent /F 2>NUL");
    sh("cmd /c schtasks /Delete /TN ValePlaywright /F 2>NUL");
    // legacy service cleanup (best effort)
    sh("sc stop Cloudflared 2>NUL");
    sh("sc delete Cloudflared 2>NUL");
    sh("reg delete HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Cloudflared /f 2>NUL");
    // program dir + registry
    sh(`rmdir /s /q "${DIR}"`);
    // Legacy install dirs from retired installers (C:\vale-agent /
    // D:\vale-agent) — uninstall must leave NO residue anywhere.
    for (const legacy of ["C:\\vale-agent", "D:\\vale-agent"]) {
      if (legacy !== DIR && fs.existsSync(legacy)) {
        console.log("uninstall: removing legacy install dir", legacy);
        // PowerShell Remove-Item -Recurse -Force handles locked/read-only
        // files better than rmdir; retry once after a short wait.
        sh(`powershell -NoProfile -Command "Remove-Item -LiteralPath '${legacy}' -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath '${legacy}' -Recurse -Force -ErrorAction SilentlyContinue"`);
        if (fs.existsSync(legacy)) {
          console.log("uninstall: WARNING — legacy dir still present:", legacy);
        }
      }
    }
    sh("reg delete HKLM\\SOFTWARE\\Vale\\Agent /f 2>NUL");
    console.log("uninstall: program dir + registry removed");
    if (purge) {
      sh(`rmdir /s /q "${DATA}"`);
      console.log("uninstall: data dir purged");
    } else {
      console.log("uninstall: data kept at", DATA, "(pass --purge-data to delete)");
    }
  },

  run(args) {
    console.log("running vale-agent (foreground, Ctrl+C to stop)");
    const r = spawnSync(EXE_DST || EXE_SRC, args.length ? args : [], {
      stdio: "inherit",
    });
    process.exitCode = r.status ?? 0;
  },

  // C2: cloudflared is a boxed, Vale-supervised component — operators never
  // touch the binary directly. This CLI is the only handle.
  tunnel(args) {
    const sub = args[0] || "status";
    const cf = path.join(DIR, "tools", "cloudflared.exe");
    const cfg = path.join(DIR, "tunnel.yml");
    const has = fs.existsSync(cf) && fs.existsSync(cfg);
    switch (sub) {
      case "status": {
        if (!has) {
          console.log("tunnel: not installed (cloudflared is OPTIONAL — local mode needs no tunnel)");
          console.log("  to enable public access: `vale tunnel install`");
          return;
        }
        const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe"], { shell: true, encoding: "utf8" }).stdout || "";
        console.log(out.toLowerCase().includes("cloudflared") ? "tunnel: RUNNING" : "tunnel: STOPPED");
        console.log("  binary:", cf);
        console.log("  config:", cfg);
        return;
      }
      case "install": {
        // THE tunnel enablement path — shared bootstrap with setup --tunnel.
        // A --reg-key <key> arg enables the automatic token exchange too.
        const ki = args.indexOf("--reg-key");
        const k = ki >= 0 ? args[ki + 1] : "";
        initTunnel(args[1] && !args[1].startsWith("--") ? args[1] : "", k);
        return;
      }
      case "start": {
        if (!has) { console.error("tunnel: not installed — run setup with public-access enabled"); process.exit(1); }
        const r = spawnSync(cf, ["tunnel", "--config", cfg, "run"], { stdio: "inherit", detached: true });
        r.unref && r.unref();
        console.log("tunnel: started (agent also auto-spawns it on boot)");
        return;
      }
      case "stop": {
        const r = spawnSync("taskkill", ["/F", "/IM", "cloudflared.exe"], { stdio: "inherit" });
        if (r.status !== 0) console.log("tunnel: nothing to stop");
        return;
      }
      case "update": {
        console.log("tunnel: version is locked by the Vale release flow — update via the installer/npm package.");
        return;
      }
      default:
        console.log("usage: vale tunnel <status|install|start|stop|update>");
        process.exit(1);
    }
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  console.log("vale <setup|status|start|stop|restart|update|uninstall|run|tunnel> — Vale Agent control");
  Object.keys(commands).forEach((k) => console.log(" ", k));
  process.exit(cmd ? 1 : 0);
}
commands[cmd](rest);
