#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOOT_TASKS = exports.psq = void 0;
exports.psArgv = psArgv;
exports.deskShortcutRepairPs = deskShortcutRepairPs;
exports.startDesktopPs = startDesktopPs;
exports.parseAgentPort = parseAgentPort;
exports.agentPort = agentPort;
exports.firewallPs = firewallPs;
exports.bootTaskPs = bootTaskPs;
exports.migrateLayoutPs = migrateLayoutPs;
exports.uninstallRegBodyPs = uninstallRegBodyPs;
exports.uninstallVersionPs = uninstallVersionPs;
exports.autostartArgv = autostartArgv;
exports.playwrightProbePs = playwrightProbePs;
exports.busyIsFresh = busyIsFresh;
exports.latestCdnVersion = latestCdnVersion;
exports.statusReport = statusReport;
exports.behindBy = behindBy;
exports.updateReceiptPs = updateReceiptPs;
exports.updateBusyPath = updateBusyPath;
exports.awaitReleaseMarker = awaitReleaseMarker;
exports.releaseMarkerVerdict = releaseMarkerVerdict;
exports.boxedVersions = boxedVersions;
exports.writeBoxedVersions = writeBoxedVersions;
exports.writeReleaseMarker = writeReleaseMarker;
exports.rollbackVersionOk = rollbackVersionOk;
/**
 * vale CLI — DSH-style management for the Vale Agent.
 *
 * The agent is a headless auto-start service; management lives here (CLI)
 * and in the web panel (http://127.0.0.1:18080/panel/, desktop shortcut
 * created by setup). The native tray was retired 2026-08-22.
 */
const child_process_1 = require("child_process");
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const EXE_SRC = path.join(__dirname, "..", "vale-agent.exe");
// C1 (2026-08-28): the registry is the single source of truth for the install
// dir. Resolution: $env:VALE_AGENT_DIR → HKLM\SOFTWARE\Vale\Agent\InstallDir
// → default. No legacy directory probing — the installer/setup always write
// the registry, and all commands use this one DIR.
function resolveDir() {
    if (process.env.VALE_AGENT_DIR)
        return process.env.VALE_AGENT_DIR;
    try {
        const out = (0, child_process_1.spawnSync)("reg", ["query", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "InstallDir"], { encoding: "utf8" });
        if (out.status === 0 && out.stdout) {
            const m = /REG_SZ\s+(.+)/.exec(out.stdout.split(/\r?\n/).find((l) => l.includes("InstallDir")) || "");
            if (m && m[1].trim())
                return m[1].trim();
        }
    }
    catch {
        /* fall through */
    }
    return "C:\\Program Files\\Vale";
}
const DIR = resolveDir();
const EXE_DST = path.join(DIR, "vale-agent.exe");
// Layout v2 (ADR 0008): the install ROOT keeps only the service exe (+ its
// transient .new/.old) and the NSIS uninstaller. Everything else lives in
// one of these — leaf names unchanged (Electron packaging + task arguments
// are rename-sensitive; only the parent moves).
const ETC_DIR = path.join(DIR, "etc");
const COMPONENTS_DIR = path.join(DIR, "components");
const SCRIPTS_DIR = path.join(DIR, "scripts");
// DataDir mirrors resolveDir (registry DataDir, else %ProgramData%\Vale) —
// runtime logs + evidence live there, never in program files.
function resolveDataDir() {
    try {
        const out = (0, child_process_1.spawnSync)("reg", ["query", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "DataDir"], { encoding: "utf8" });
        if (out.status === 0 && out.stdout) {
            const m = /REG_SZ\s+(.+)/.exec(out.stdout.split(/\r?\n/).find((l) => l.includes("DataDir")) || "");
            if (m && m[1].trim())
                return m[1].trim();
        }
    }
    catch {
        /* fall through */
    }
    return path.join(process.env.ProgramData || "C:\\ProgramData", "Vale");
}
/**
 * Write one HKLM value and VERIFY IT. The registry is the single source of truth for
 * path resolution — `paths.rs` on the Rust side and `resolveDataDir()` here both read it
 * — so a silent failure means the agent and this CLI can disagree about where the install
 * IS, and `vale status` then prints the default dir and "panel: (not installed)" for an
 * install that succeeded somewhere else.
 *
 * It used to be `spawnSync("reg", [...], { stdio: "ignore" })` inside a `try` that could
 * never fire: spawnSync does NOT throw on a failing program, and stdio ignored suppressed
 * the only evidence.
 */
function regWrite(name, value) {
    const r = (0, child_process_1.spawnSync)("reg", [
        "add",
        "HKLM\\SOFTWARE\\Vale\\Agent",
        "/v",
        name,
        "/t",
        "REG_SZ",
        "/d",
        value,
        "/f",
    ], { encoding: "utf8" });
    if (r.status !== 0) {
        console.error(`setup: WARNING -- could not record ${name} in HKLM\\SOFTWARE\\Vale\\Agent` +
            (r.stderr ? ` (${String(r.stderr).trim()})` : "") +
            " -- path resolution will fall back to the default");
        return false;
    }
    return true;
}
const DATA_DIR = resolveDataDir();
const LOGS_DIR = path.join(DATA_DIR, "logs");
const CFG_FILE = path.join(ETC_DIR, "config.yaml");
const HOSTNAME_FILE = path.join(ETC_DIR, "vale-agent.hostname");
const DESK_DIR = path.join(COMPONENTS_DIR, "vale-desktop-electron");
const PW_DIR = path.join(COMPONENTS_DIR, "playwright");
const TASK = "ValeAgent";
// Gateway API base — where the console endpoints live (tunnel-token /
// register). Overridable for staging.
const API_BASE = process.env.VALE_API_BASE || "https://api.saisi.online";
// POST JSON to the gateway, return parsed JSON or throw with the error text.
function apiPost(pathname, body) {
    const res = (0, child_process_1.spawnSync)("curl", [
        "-sS",
        "-m",
        "30",
        "-X",
        "POST",
        "-H",
        "content-type: application/json",
        "-d",
        JSON.stringify(body),
        API_BASE + pathname,
    ], { encoding: "utf8" });
    if (res.status !== 0)
        throw new Error("gateway unreachable: " + (res.stderr || "").trim());
    const out = (res.stdout || "").trim();
    try {
        return JSON.parse(out);
    }
    catch {
        throw new Error("gateway bad response: " + out.slice(0, 120));
    }
}
function sh(cmd, opts = {}) {
    return (0, child_process_1.spawnSync)(cmd, { shell: true, stdio: "inherit", ...opts });
}
/**
 * The argv for a one-shot PowerShell script — NO SHELL, and that is the point.
 *
 * `shell: true` routed this through cmd.exe, where `"` is a quote TOGGLE and
 * `\"` is not an escape at all. So cmd re-parsed the argument before PowerShell
 * ever saw it, and any character it treats specially became an OPERATOR.
 *
 * Observed on d1: the round-7 update receipt contains `1.2.322 -> 1.2.323`.
 * cmd saw the `>` and performed a REDIRECTION — the log line landed as
 * "update requested 1.2.322 - (CLI reached the device...)" (arrow and TARGET
 * VERSION gone, exactly the half that says what is being installed) and a stray
 * zero-byte file named `1.2.323` appeared in the working directory. The
 * receipt's whole purpose is to distinguish "the CLI ran but the swap did not"
 * from "nothing ran"; a receipt that cannot name its target is half a receipt.
 *
 * Passing argv straight to CreateProcess means PowerShell receives the script
 * VERBATIM and no quoting layer sits between the two. This is also what every
 * other spawn in this file already does (`spawnSync("reg", [...])`) — `ps()` was
 * the only one that shelled out.
 */
function psArgv(script) {
    return ["-NoProfile", "-Command", script];
}
function ps(script) {
    // npm audit #7: results were discarded — a failed Register-ScheduledTask
    // printed SUCCESS anyway. Return the spawn result.
    return (0, child_process_1.spawnSync)("powershell", psArgv(script), { stdio: "inherit" });
}
// Run a PowerShell script from a temp .ps1 FILE instead of -Command. The
// layout-migration script is ~10KB — past cmd.exe's 8191-char command-line
// limit — so `ps()` (which shells through cmd) failed it with "命令行太长"
// and the migration silently no-op'd. A file path is short, so the script
// length is then unbounded. This is a DIRECT child spawn (not the WMI
// handoff where -ExecutionPolicy Bypass dies silently on d1), so Bypass is
// safe here and sidesteps any Restricted execution policy on the box.
function psFile(script) {
    const tmpDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
    const tmp = path.join(tmpDir, `vale-mig-${process.pid}.ps1`);
    try {
        fs.writeFileSync(tmp, script, "utf8");
        return (0, child_process_1.spawnSync)("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], { encoding: "utf8" });
    }
    catch (e) {
        console.log("setup: psFile failed (" + (e?.message || e) + ")");
        return { status: 1 };
    }
    finally {
        try {
            fs.unlinkSync(tmp);
        }
        catch {
            /* best-effort */
        }
    }
}
// npm audit #6: setup interpolated RAW paths into PS single-quote literals;
// an apostrophe in a path (O'Brien) unbalanced the literal and the script
// PARSE-failed invisibly. Shared doubling helper.
// exported: unit-tested in test/cli.test.mjs (SYSTEM-context PS quoting = injection surface)
const psq = (x) => String(x).replace(/'/g, "''");
exports.psq = psq;
// stage-brand: healed desktop shortcut. A 2026-09-01 Vale.lnk on devices
// points at the RETIRED Tauri vale-desktop.exe (embedded stale icon) —
// double-clicking it launches the dead app instead of the Electron shell.
// Repair (only if the link already exists — headless installs must not
// sprout desktop icons): repoint at start-desktop.ps1 (the ValeDesktop
// onlogon path) with IconLocation pinned to the sunrise icon.ico, and
// remove the retired Tauri/tray orphans nothing ships anymore.
// Best-effort + logged, never fatal. `sink` is a PS output pipe
// (e.g. Write-Host, or the update log pipe). Single-quoted PS literals
// only (npm audit #6) except the double quotes the .lnk Arguments path
// needs — callers passing through -Command "..." must backslash-escape
// them (see setup step 7); the update swap script runs from a file.
// exported: unit-tested in test/cli.test.mjs.
function deskShortcutRepairPs(scriptsQ, deskDirQ, sink) {
    return [
        `$dLnk = Join-Path $env:PUBLIC 'Desktop\\Vale.lnk'`,
        `$dIco = '${deskDirQ}\\icon.ico'`,
        `$dPs1 = '${scriptsQ}\\start-desktop.ps1'`,
        `$dNeed = $false`,
        `if (Test-Path $dLnk) {`,
        `  try { $dEx = (New-Object -ComObject WScript.Shell).CreateShortcut($dLnk); if (($dEx.TargetPath -like '*vale-desktop.exe') -or ($dEx.TargetPath -like '*vale-tray.exe') -or (-not (Test-Path $dEx.TargetPath))) { $dNeed = $true } } catch { $dNeed = $true }`,
        `}`,
        `if ($dNeed -and (Test-Path $dIco) -and (Test-Path $dPs1)) {`,
        `  try { $dWs = New-Object -ComObject WScript.Shell; $dSc = $dWs.CreateShortcut($dLnk); $dSc.TargetPath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $dSc.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $dPs1 + '"'; $dSc.WorkingDirectory = '${deskDirQ}'; $dSc.IconLocation = $dIco + ',0'; $dSc.Save(); 'desk: Vale.lnk repointed to electron shell' | ${sink} } catch { ('desk: Vale.lnk repair failed: ' + $_.Exception.Message) | ${sink} }`,
        `}`,
        `foreach ($dRx in @('vale-desktop.exe','vale-tray.exe')) { $dRp = '${deskDirQ}\\' + $dRx; if (Test-Path $dRp) { try { Remove-Item -Force -ErrorAction Stop $dRp; ('desk: removed retired ' + $dRx) | ${sink} } catch { ('desk: retired ' + $dRx + ' locked, kept') | ${sink} } } }`,
    ];
}
// exported: the start-desktop.ps1 launcher (the ValeDesktop onlogon task +
// desktop Vale.lnk both call it). Launches the Electron shell from
// components\vale-desktop-electron\ with the working directory set there
// (electron . resolves src/main.js via package.json main). The script is
// intentionally tiny + ASCII-only (system-locale PS). unit-tested.
function startDesktopPs(deskDirQ) {
    return [
        `$dir = '${deskDirQ}'`,
        `Set-Location $dir`,
        `& "$dir\\node_modules\\electron\\dist\\electron.exe" .`,
    ];
}
// exported: agent bind port plumbing (custom-port installs). server.port
// out of <dir>/config.yaml (first `port:` under top-level `server:`),
// canonical 18080 when absent/invalid/missing (fresh installs have no
// config yet — the agent writes defaults on first boot). Pure core
// unit-tested; agentPort() is the thin fs wrapper. unit-tested in
// test/cli.test.mjs.
function parseAgentPort(yamlText) {
    let inServer = false;
    for (const raw of String(yamlText || "").split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "");
        if (/^\S/.test(line))
            inServer = /^server\s*:/.test(line);
        if (!inServer)
            continue;
        const m = /^\s*port\s*:\s*"?(\d{1,5})"?\s*(#.*)?$/.exec(line);
        if (m) {
            const n = Number(m[1]);
            return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
        }
    }
    return null;
}
function agentPort(dir) {
    try {
        return (parseAgentPort(fs.readFileSync(path.join(dir, "config.yaml"), "utf8")) ??
            18080);
    }
    catch {
        return 18080;
    }
}
// exported: idempotent Windows firewall inbound rule for the agent port
// (LAN clients are dropped at the firewall otherwise, even bound 0.0.0.0).
// ASCII-only PS, plain statements (WMI/session-0 rule). Prunes our own
// stale-port rules, never foreign ones (DisplayName-scoped). unit-tested.
function firewallPs(port) {
    return [
        `$fwPort = ${port};`,
        `foreach ($fr in @(Get-NetFirewallRule -DisplayName 'Vale Agent' -ErrorAction SilentlyContinue)) { try { $fp = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $fr | Select-Object -ExpandProperty LocalPort); if ($fp -notcontains "$fwPort") { Remove-NetFirewallRule -Name $fr.Name -Confirm:$false -ErrorAction SilentlyContinue } } catch {} }`,
        `if (-not (Get-NetFirewallRule -DisplayName 'Vale Agent' -ErrorAction SilentlyContinue | Where-Object { @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $PSItem | Select-Object -ExpandProperty LocalPort) -contains "$fwPort" })) { New-NetFirewallRule -DisplayName 'Vale Agent' -Direction Inbound -LocalPort $fwPort -Protocol TCP -Action Allow | Out-Null }`,
    ];
}
// exported: ValeAgent boot-task registration (SYSTEM, hardened). The task's
// -Argument is the EXPLICIT config path (layout v2: etc\config.yaml) — never
// the exe path (Rust takes argv[1] as the config FILE; an exe path fails
// YAML parse and quarantines the install). Shared by setup (fresh install)
// and the update swap (repoint, fail-closed — the repoint runs BEFORE any
// swap, and a config-path argument boots old AND new agents alike, so a
// repoint failure aborts the update with the old version still running).
// `start` appends the kick for setup; the swap omits it (it restarts the
// task itself after the swap). ASCII-only PS. unit-tested.
function bootTaskPs(exeQ, cfgQ, start = false) {
    const lines = [
        `$action = New-ScheduledTaskAction -Execute '${exeQ}' -Argument ('"' + '${cfgQ}' + '"')`,
        "$boot = New-ScheduledTaskTrigger -AtStartup",
        "$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 5)",
        "$principal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest",
        "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 8 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable",
        "Register-ScheduledTask ValeAgent -Action $action -Trigger @($boot,$watch) -Principal $principal -Settings $settings -Force | Out-Null",
    ];
    if (start)
        lines.push("Start-ScheduledTask ValeAgent");
    return lines;
}
// exported: layout-v2 one-time migration (ADR 0008) for the setup/update
// paths. Mirrors paths.rs migration_moves EXACTLY (same pairs — both sides
// pinned by tests; drift strands upgraded devices). Moves only when the
// target is missing (never clobbers staged .new output); dirs merge
// children. Best-effort per item; callers GATE on etc\config.yaml +
// hostname afterwards (fail-closed). Marker aging (same contract as
// paths.rs): skip entirely when etc\.layout-v2 exists; write it only when
// nothing is pending (old home exists, new missing). q = escaped DIR,
// dq = escaped DataDir. ASCII-only PS. unit-tested.
function migrateLayoutPs(q, dq) {
    const mvf = (oldRel, newAbs) => `if ($valeMg -and (Test-Path '${q}\\${oldRel}') -and (-not (Test-Path '${newAbs}'))) { try { New-Item -ItemType Directory -Force -Path (Split-Path '${newAbs}') | Out-Null; Move-Item -Force -Path '${q}\\${oldRel}' -Destination '${newAbs}' -ErrorAction Stop } catch {} }`;
    const mvd = (oldRel, newAbs) => `if ($valeMg -and (Test-Path '${q}\\${oldRel}')) { try { if (-not (Test-Path '${newAbs}')) { New-Item -ItemType Directory -Force -Path (Split-Path '${newAbs}') | Out-Null; Move-Item -Path '${q}\\${oldRel}' -Destination '${newAbs}' -ErrorAction Stop } else { Get-ChildItem -Force '${q}\\${oldRel}' | ForEach-Object { if (-not (Test-Path (Join-Path '${newAbs}' $_.Name))) { Move-Item -Force -Path $_.FullName -Destination (Join-Path '${newAbs}' $_.Name) -ErrorAction SilentlyContinue } } } } catch {} }`;
    const etc = `${q}\\etc`;
    const comp = `${q}\\components`;
    const scr = `${q}\\scripts`;
    const logs = `${dq}\\logs`;
    // (oldRel, newAbs, kind) pairs — 'f' files move atomically, 'd' dirs
    // merge children. The pending check covers EVERY pair exactly once with
    // paths.rs' rule (old && !new); a merged dir whose target EXISTS is not
    // pending even with locked leftovers behind them (garbage for uninstall).
    const moves = [
        ["config.yaml", `${etc}\\config.yaml`, "f"],
        ["vale-agent.hostname", `${etc}\\vale-agent.hostname`, "f"],
        ["tunnel.yml", `${etc}\\tunnel.yml`, "f"],
        [".vale-release", `${etc}\\.vale-release`, "f"],
        ["boxed-versions.json", `${etc}\\boxed-versions.json`, "f"],
        ["tools\\node", `${comp}\\node`, "d"],
        ["tools\\npm-global", `${comp}\\npm-global`, "d"],
        ["tools\\cloudflared.exe", `${comp}\\cloudflared.exe`, "f"],
        ["playwright", `${comp}\\playwright`, "d"],
        ["vale-desktop-electron", `${comp}\\vale-desktop-electron`, "d"],
        ["ensure-desktop.ps1", `${scr}\\ensure-desktop.ps1`, "f"],
        ["desktop-pulse.vbs", `${scr}\\desktop-pulse.vbs`, "f"],
        ["start-desktop.ps1", `${scr}\\start-desktop.ps1`, "f"],
        ["vale-online-setup.ps1", `${scr}\\vale-online-setup.ps1`, "f"],
        ["fix-tunnel.ps1", `${scr}\\fix-tunnel.ps1`, "f"],
        ["playwright\\run-hidden.vbs", `${scr}\\run-hidden.vbs`, "f"],
        ["playwright\\playwright-probe.ps1", `${scr}\\playwright-probe.ps1`, "f"],
        ["shell-integration", `${scr}\\shell-integration`, "d"],
        ["installer.log", `${logs}\\installer.log`, "f"],
        ["install-result.txt", `${logs}\\install-result.txt`, "f"],
        ["vale-update.log", `${logs}\\vale-update.log`, "f"],
        ["agent.log", `${logs}\\agent.log`, "f"],
        ["startup.log", `${logs}\\startup.log`, "f"],
        ["pwout", `${dq}\\pwout`, "d"],
    ];
    const pending = moves
        .map(([o, n]) => `((Test-Path '${q}\\${o}') -and (-not (Test-Path '${n}')))`)
        .join(" -or ");
    // All statements stay SINGLE-LINE (setup passes them joined with "; "
    // through -Command): the marker guard is precomputed into $valeMg and
    // every line carries it, instead of wrapping the block in braces.
    return [
        `$valeMg = (-not (Test-Path '${etc}\\.layout-v2'))`,
        // A running boxed node locks the playwright tree — stop DIR-local ones
        // first (setup precedent; the updater itself runs from npm-global,
        // which never matches the playwright filter).
        `if ($valeMg) { Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${q}*playwright*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
        ...moves.map(([o, n, k]) => (k === "d" ? mvd(o, n) : mvf(o, n))),
        `if ($valeMg -and (-not (${pending}))) { try { New-Item -ItemType Directory -Force -Path '${etc}' | Out-Null; New-Item -ItemType File -Force -Path '${etc}\\.layout-v2' | Out-Null } catch {} }`,
    ];
}
// exported: Add/Remove-Programs version parity. The NSIS installer writes
// DisplayVersion once at install time, but `vale update` swaps the exe
// out-of-band — without this the control-panel entry shows the ORIGINAL
// version forever and misleads troubleshooting. Same round-298 discipline
// as .vale-release: the caller splices these lines right after the marker
// write, gated on $ok (a failed swap must not move the version), wrapped
// in try/catch (best-effort — a registry failure must never fail the
// update). Creates the key when missing (npm-only installs never had one)
// but never fabricates UninstallString (NSIS owns it; npm uninstall is
// `vale uninstall`). q = single-quote-escaped install dir, ver = release
// version. ASCII-only PS. unit-tested.
// exported: Add/Remove-Programs entry body (shared by setup + the update
// swap). Writes DisplayVersion/DisplayName/InstallLocation/Publisher always;
// writes UninstallString ONLY when absent — NSIS installs own theirs
// ($INSTDIR\uninstall.exe) and it must never be overwritten. The fallback
// value relaunches vale.cmd ELEVATED (control panel does not elevate for
// us; without RunAs the uninstall dies on HKLM/schtasks with access
// denied), preferring components\npm-global (layout v2) then the legacy
// tools\ path. Best-effort try/catch throughout — a registry failure must
// never fail install/update. Empty ver = no-op. ASCII-only PS. unit-tested.
function uninstallRegBodyPs(q, ver) {
    if (!ver)
        return [];
    return [
        `try {`,
        `  $rk = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ValeAgent'`,
        `  if (-not (Test-Path $rk)) { New-Item -Path $rk -Force | Out-Null }`,
        `  Set-ItemProperty -Path $rk -Name DisplayVersion -Value '${ver}' -ErrorAction Stop`,
        `  Set-ItemProperty -Path $rk -Name DisplayName -Value 'Vale Agent ${ver}' -ErrorAction Stop`,
        `  Set-ItemProperty -Path $rk -Name InstallLocation -Value '${q}' -ErrorAction Stop`,
        `  Set-ItemProperty -Path $rk -Name Publisher -Value 'Vale' -ErrorAction Stop`,
        `  $uv = '${q}\\components\\npm-global\\vale.cmd'`,
        `  if (-not (Test-Path $uv)) { $uv = '${q}\\tools\\npm-global\\vale.cmd' }`,
        `  if ((Test-Path $uv) -and (-not (Get-ItemProperty -Path $rk -Name UninstallString -ErrorAction SilentlyContinue))) { Set-ItemProperty -Path $rk -Name UninstallString -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath ''' + $uv + ''' -ArgumentList ''uninstall'' -Verb RunAs -Wait"') -ErrorAction Stop }`,
        `} catch {}`,
    ];
}
function uninstallVersionPs(q, ver) {
    if (!ver)
        return [];
    return [`if ($ok -and '${ver}') {`, ...uninstallRegBodyPs(q, ver), `}`];
}
// exported: autostart (boot) switch for the two scheduled tasks. ValeAgent
// (SYSTEM service task) + ValeDesktop (logon shell task) ARE the autostart
// surface — `vale stop` only Ends the running instance and the 5-min
// watchdog revives it, so stop != opting out of autostart. This flips the
// task ENABLED flag itself. /ENABLE|/DISABLE need no credentials, unlike
// trigger edits which prompt for the /ru password interactively (and hang
// the caller) — never add /RI /RU /RP /TR here. unit-tested.
exports.BOOT_TASKS = ["ValeAgent", "ValeDesktop"];
function autostartArgv(task, action) {
    return [
        "schtasks",
        "/Change",
        "/TN",
        task,
        action === "on" ? "/ENABLE" : "/DISABLE",
    ];
}
// exported: the ValePlaywright probe launcher (playwright-probe.ps1).
// Probe order matches the agent's preferred_cdp_endpoint(): 9333
// (Electron DESKTOP embedded view — what the user watches) when up, else
// private --headless. --output-dir pins MCP screenshots where the Evidence
// drawer lists them (install\pwout). ASCII-only, plain -NoProfile -File
// (the repo rule: -ExecutionPolicy Bypass / -EncodedCommand die silently
// under WMI/session-0 launches). unit-tested in test/cli.test.mjs.
function playwrightProbePs() {
    return [
        "param([string]$node, [string]$cli)",
        "$ErrorActionPreference = 'Continue'",
        "$pwout = Join-Path (Split-Path $node -Parent) '..\\pwout'",
        "if (!(Test-Path $pwout)) { New-Item -ItemType Directory -Path $pwout -Force | Out-Null }",
        "$ep = ''",
        "function Test-Port([int]$port) {",
        "  try {",
        "    $c = New-Object System.Net.Sockets.TcpClient",
        "    $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)",
        "    if ($iar.AsyncWaitHandle.WaitOne(1500)) { return $c.Connected }",
        "    $c.Close()",
        "  } catch { }",
        "  return $false",
        "}",
        // Boot race: the task can fire before the desktop's CDP is up (Electron
        // starts at logon, later than the task). A single check then forks a
        // private headless chromium nobody sees (device-caught: detached 9229
        // serving about:blank while the user watched the embedded view). Wait
        // up to ~60s for 9333 before falling back to headless.
        "for ($i = 1; $i -le 12; $i++) { if (Test-Port 9333) { $ep = 'http://127.0.0.1:9333'; break }; Start-Sleep -Seconds 5 }",
        "if ($ep) {",
        "  & $node $cli --port 9229 --host 127.0.0.1 --cdp-endpoint $ep --output-dir $pwout --ignore-https-errors --allowed-hosts '127.0.0.1:9229,localhost:9229'",
        "} else {",
        "  & $node $cli --port 9229 --browser chromium --host 127.0.0.1 --headless --output-dir $pwout --ignore-https-errors --allowed-hosts '127.0.0.1:9229,localhost:9229'",
        "}",
    ];
}
// exported: the update mutual-exclusion window (npm audit #10 seam), unit-tested.
//
// TEN MINUTES, AND IT MUST EQUAL THE AGENT'S `BUSY_STALE_SECS`. It did not: this
// reclaimed at ten minutes while `agent/src/plugins/update/tools.rs` refused for
// an hour, so at eleven minutes this side OVERWROTE a marker the agent still
// honoured and a CLI update could start alongside a console-launched one —
// interleaving `Copy-Item` on `*.new`, the half-written-exe hazard this marker
// exists to prevent (npm audit #10). The agent now uses ten minutes too, and
// `test/cli.test.mjs` pins the two numbers against each other, because no test
// inside either language can see the other's.
function busyIsFresh(mtimeMs, nowMs) {
    return nowMs - mtimeMs < 10 * 60 * 1000;
}
/**
 * The newest version the release CDN advertises, or `null` when it cannot be
 * read. Never throws and never guesses — the caller renders `null` as "could not
 * be checked", because a silent failure here is indistinguishable from "current".
 *
 * Uses `curl` (what `vale rollback` already uses for its HEAD check) rather than
 * a Node HTTP client: it inherits the proxy and TLS store the rest of the CLI
 * relies on, and a 3 s cap keeps `status` from hanging on a bad network.
 */
function latestCdnVersion() {
    const base = (process.env.VALE_CDN || "https://agent.saisi.online").replace(/\/+$/, "");
    const r = (0, child_process_1.spawnSync)("curl", ["-s", "-m", "3", `${base}/api/version`], {
        encoding: "utf8",
        timeout: 5000,
    });
    if (r.status !== 0 || !r.stdout)
        return null;
    try {
        const j = JSON.parse(r.stdout);
        const v = j && typeof j.version === "string" ? j.version.trim() : "";
        return v || null;
    }
    catch {
        // A body that is not JSON is NOT a version — the same rule the gateway's
        // tool path had to learn.
        return null;
    }
}
function statusReport(f) {
    const out = [];
    out.push(f.agentRunning ? "status: RUNNING" : "status: STOPPED");
    out.push("install dir: " + f.installDir);
    out.push("panel: " +
        (f.exeExists ? `http://127.0.0.1:${f.port}/panel/` : "(not installed)"));
    // A device without a release marker is not "on some version" — it is a device
    // whose version is UNKNOWN (a fresh box, or an install predating the marker).
    // Printing this CLI's version here would be a fabricated fact.
    out.push("release: " +
        (f.releaseVersion ? f.releaseVersion : "unknown (no release marker)"));
    out.push("this CLI: " + f.packageVersion);
    if (f.updateMarkerMs === null) {
        out.push(f.updateMarkerUnreadable
            ? "update: state UNKNOWN -- the busy marker exists but could not be read (permissions or a lock); do not assume no update is running"
            : "update: none in flight");
    }
    else if (busyIsFresh(f.updateMarkerMs, f.nowMs)) {
        const secs = Math.max(0, Math.round((f.nowMs - f.updateMarkerMs) / 1000));
        out.push(`update: IN FLIGHT (marker ${secs}s old -- a swap is running now; the connection drops for ~10s)`);
    }
    else {
        const mins = Math.round((f.nowMs - f.updateMarkerMs) / 60_000);
        out.push(`update: a previous update STARTED AND DID NOT FINISH (marker ${mins} min old). ` +
            `Check the log tail, then re-run 'vale update' -- a stale marker is safe to overwrite.`);
    }
    // The drift line: what a human actually wants from `status` after an update.
    // Only claimed when the running version is KNOWN — otherwise the comparison
    // would be against a guess.
    if (f.releaseVersion && f.releaseVersion !== f.packageVersion) {
        out.push(`update: device runs ${f.releaseVersion}, this CLI is ${f.packageVersion} -- ` +
            `run 'vale update' to swap, then 'vale status' again to confirm.`);
    }
    // THE DELIVERY GAP, WHICH NOTHING ELSE IN THIS REPO CHECKS.
    //
    // `release` answers "what is this device running"; it did NOT answer "is that
    // current", and the two questions are answered by different machines. Every
    // round of this project's log records a device found MANY RELEASES BEHIND the
    // CDN — five, six, once three in a single round — and each time the only thing
    // that noticed was a human looking. This closes it where a human already
    // looks: the one command run after every update.
    //
    // `null` IS NOT "UP TO DATE". If the CDN could not be read the line says so
    // instead of staying silent, because silence here reads exactly like
    // agreement — the failure mode this whole log is about.
    // `== null` COVERS `undefined` TOO, AND THAT IS THE POINT. The first version of
    // this tested `=== null`, and a caller that simply OMITS the field — an older
    // edition, a test fixture — fell through to the drift branch with `undefined`
    // and crashed reading `.split` of nothing. Missing and null are both "we do not
    // know what the CDN has"; only a STRING is a comparison. (The panel learned the
    // same distinction the hard way in round 36: `undefined` is not `null`.)
    if (f.latestVersion == null) {
        out.push("latest: could NOT be checked (the release CDN did not answer) -- this says nothing about whether the device is current");
    }
    else if (f.releaseVersion && f.releaseVersion !== f.latestVersion) {
        out.push(`latest: ${f.latestVersion} is on the CDN -- THIS DEVICE IS BEHIND by ${behindBy(f.releaseVersion, f.latestVersion)}; run 'vale update'`);
    }
    else if (f.releaseVersion) {
        out.push(`latest: ${f.latestVersion} (this device is current)`);
    }
    return out;
}
/**
 * How far behind, in patch releases, WITHIN THE SAME MINOR. Returns a phrase,
 * never a fabricated number: `1.2.9` → `1.2.12` is "3 releases", but a MINOR or
 * MAJOR difference is not a count of anything a reader can act on, so it is
 * stated as such. The last-5-per-minor CDN prune means a cross-minor jump is a
 * different operation anyway (`vale rollback` refuses it for the same reason).
 */
function behindBy(device, latest) {
    const a = device.split(".").map(Number);
    const b = latest.split(".").map(Number);
    if (a.length !== 3 ||
        b.length !== 3 ||
        [...a, ...b].some((n) => !Number.isFinite(n))) {
        return "an unknown number of releases";
    }
    if (a[0] !== b[0] || a[1] !== b[1])
        return "a release line, not a patch count";
    const n = b[2] - a[2];
    return n === 1 ? "1 release" : `${n} releases`;
}
/**
 * The CLI's pre-handoff receipt, appended to the swap's own log.
 *
 * Takes the resolved DATA dir and rebuilds the same `<data>\logs\vale-update.log`
 * path the swap script appends to — NOT a `..` relative guess, because
 * `DATA_DIR` can be a registry-remapped location that is not `DIR`, and a
 * receipt written to a different file than the swap writes is worse than none:
 * it would look like the swap never started.
 *
 * Deliberately NOT the swap's `update start` wording: the value of the receipt
 * is that its presence-without-`update start` proves the CLI ran and the swap
 * did not, so the two markers must stay distinguishable in the file.
 */
function updateReceiptPs(dataDirQ, fromVersion, toVersion) {
    const log = `Out-File '${dataDirQ}\\logs\\vale-update.log' -Append`;
    const line = `"[$(Get-Date -Format o)] update requested ${fromVersion} -> ${toVersion} ` +
        `(CLI reached the device; the swap has not started yet)"`;
    return [`${line} | ${log}`];
}
/**
 * The update mutual-exclusion marker — ONE owner for the path.
 *
 * Three readers now depend on it agreeing: the mutual-exclusion check in
 * `setup()`, the guard in `update()`, and `statusReport`'s "is a swap pending"
 * line. If they ever computed the path differently, `status` would confidently
 * report "none in flight" while an update was refusing to start because a
 * marker it could not see was in the way.
 *
 * A SURVIVING STALE MARKER means the update started and never finished: the
 * swap script clears it on its own known-failure paths (task repoint, migration
 * gate) and after a successful restart, so one still sitting there is an update
 * that died before cleanup. `statusReport` deliberately reuses `busyIsFresh` —
 * the SAME predicate `update()` refuses on — so "stale" cannot mean one thing
 * to the guard and another to the report.
 */
function updateBusyPath() {
    return path.join(process.env.ProgramData || "C:\\ProgramData", "ValeAgent", "update-busy");
}
/**
 * Poll `etc\.vale-release` until it shows `want`, or the budget expires.
 *
 * Bounded on purpose: the swap kills the agent and restarts a scheduled task, so
 * a delay is NORMAL — but a marker that never arrives is a failed swap and must
 * be reported as one. `read`/`sleep`/`now` are injected so the behaviour is
 * testable without real timers or a device.
 */
async function awaitReleaseMarker(o) {
    const deadline = o.now() + o.timeoutMs;
    let saw = null;
    for (;;) {
        try {
            const v = String(o.read()).trim();
            saw = v || null;
            if (saw === o.want)
                return { ok: true, saw };
        }
        catch {
            saw = null; // absent / unreadable is NOT success and NOT a crash
        }
        if (o.now() >= deadline)
            return { ok: false, saw };
        await o.sleep(o.intervalMs);
    }
}
/**
 * What to do about a rollback whose swap could not be proven.
 *
 * Separated from the I/O so the DECISION is assertable: the pin is the device's
 * protection against being auto-upgraded back, and the marker is what every UI
 * believes — writing either on an unproven swap is how a device ends up
 * misreporting its own version and refusing the update that would fix it.
 */
function releaseMarkerVerdict(c) {
    if (c.ok) {
        return {
            writePin: true,
            exitCode: 0,
            message: `rollback: pinned to ${c.want} -- auto-upgrade refused until 'vale rollback --clear' or a forced agent_update`,
        };
    }
    return {
        writePin: false,
        exitCode: 1,
        message: `rollback: the swap did NOT take -- device is on ${c.saw ?? "an unknown version"}, ` +
            `not ${c.want}. NOT pinned (the pin would claim a version this device is not running) ` +
            `and no release marker written. Check the update log, then re-run 'vale rollback ${c.want}'.`,
    };
}
function boxedVersions(installDir, pkgDir) {
    const pkgVer = (p) => {
        try {
            const j = JSON.parse(fs.readFileSync(p, "utf8"));
            return typeof j?.version === "string" && j.version
                ? j.version
                : "unknown";
        }
        catch {
            return "unknown";
        }
    };
    const shaOf = (p) => {
        try {
            const st = fs.statSync(p);
            if (!st.isFile() || st.size > 300 * 1024 * 1024)
                return "unknown";
            return crypto
                .createHash("sha256")
                .update(fs.readFileSync(p))
                .digest("hex");
        }
        catch {
            return "unknown";
        }
    };
    // Layout v2: callers (setup/update) always run after staging/migration, so
    // the components\ homes exist — no legacy fallback (single semantic).
    const cfBin = fs.existsSync(path.join(installDir, "components", "cloudflared.exe"))
        ? path.join(installDir, "components", "cloudflared.exe")
        : path.join(pkgDir, "cloudflared.exe");
    let cfVer = "unknown";
    try {
        if (fs.existsSync(cfBin)) {
            const r = (0, child_process_1.spawnSync)(cfBin, ["--version"], {
                encoding: "utf8",
                timeout: 15000,
            });
            const line = ((r.stdout || "") + (r.stderr || ""))
                .split(/\r?\n/)[0]
                .trim();
            if (line)
                cfVer = line.slice(0, 120);
        }
    }
    catch {
        /* best-effort */
    }
    const pwRoot = path.join(installDir, "components", "playwright");
    return {
        updated: new Date().toISOString(),
        playwright_mcp: {
            version: pkgVer(path.join(pwRoot, "node_modules", "@playwright", "mcp", "package.json")),
            sha256: shaOf(path.join(pkgDir, "vale-playwright.zip")),
        },
        playwright_core: {
            version: pkgVer(path.join(pwRoot, "node_modules", "playwright-core", "package.json")),
            sha256: "unknown",
        },
        cloudflared: {
            version: cfVer,
            sha256: fs.existsSync(cfBin) ? shaOf(cfBin) : "unknown",
        },
    };
}
// exported: best-effort writer for the P2-4 manifest (never throws).
function writeBoxedVersions(installDir, pkgDir) {
    try {
        fs.mkdirSync(path.join(installDir, "etc"), { recursive: true });
        fs.writeFileSync(path.join(installDir, "etc", "boxed-versions.json"), JSON.stringify(boxedVersions(installDir, pkgDir), null, 2));
    }
    catch (e) {
        console.log("boxed-versions: manifest write skipped (" + (e?.message || e) + ")");
    }
}
// round-298 parity: record this package's release version next to the install
// dir as `.vale-release` — the file agent_update reads as the LOCAL version
// (fallback: Cargo 1.0.x, which never changes, so remote always looks newer
// and every agent_update call re-downloads + swaps). `vale update` writes it
// from the swap script after a provable copy; `vale setup` (fresh install)
// copies THIS package's exe, so the provable-success point is right after the
// boot task registers — the caller invokes this only once setup succeeded.
// Best-effort, never fail-closed (a marker failure must not block install).
function writeReleaseMarker(installDir) {
    try {
        const v = String(require("../package.json").version || "");
        if (!v)
            return;
        // No mkdir: callers (setup/update) always run after staging/migration,
        // so etc\ exists — a missing dir stays a silent best-effort skip.
        fs.writeFileSync(path.join(installDir, "etc", ".vale-release"), v, "utf8");
    }
    catch {
        /* best-effort */
    }
}
/**
 * Stage the Electron desktop shell sources (main/preload/url-policy +
 * icons) into components\vale-desktop-electron. setup writes them in place;
 * update writes `*.new` so the swap script can atomically replace them. The
 * two flows used to each inline this block.
 */
function stageDesktopShell(installDir, suffix) {
    const DESK_SRC = path.join(__dirname, "..", "vale-desktop-electron", "src");
    if (!fs.existsSync(DESK_SRC))
        return;
    const desDst = path.join(installDir, "components", "vale-desktop-electron", "src");
    fs.mkdirSync(desDst, { recursive: true });
    for (const f of ["main.js", "preload.js", "url-policy.js"]) {
        const s = path.join(DESK_SRC, f);
        if (fs.existsSync(s))
            fs.copyFileSync(s, path.join(desDst, f + suffix));
    }
    // icon.png/.ico go next to src/ (Electron loads from ../icon.png;
    // Windows Tray requires the .ico).
    for (const icon of ["icon.png", "icon.ico"]) {
        const iconSrc = path.join(__dirname, "..", "vale-desktop-electron", icon);
        if (fs.existsSync(iconSrc))
            fs.copyFileSync(iconSrc, path.join(installDir, "components", "vale-desktop-electron", icon));
    }
    // Fresh-install desktop fix: the shell is launched as `electron .`
    // (start-desktop.ps1), which resolves its entry ONLY via package.json
    // "main". stageDesktopShell used to ship src/*.js + icons but NO
    // package.json — so `electron .` had nothing to load, AND the installer's
    // Electron step (gated on Test-Path package.json) was skipped entirely,
    // leaving the desktop shell dead on every fresh box. Write the minimal
    // manifest here (setup + update paths; idempotent, not held open by the
    // running shell).
    const shellDir = path.join(installDir, "components", "vale-desktop-electron");
    try {
        fs.writeFileSync(path.join(shellDir, "package.json"), JSON.stringify({
            name: "vale-desktop-electron",
            version: "0.2.0",
            main: "src/main.js",
            private: true,
        }, null, 2), "utf8");
    }
    catch {
        /* best-effort — a failed write must not break staging */
    }
}
function svc(action) {
    // RETURN the status. It used to be discarded, which is why `stop` printed "stopped"
    // and exited 0 for a missing task or an access-denied, and why `start`/`restart` were
    // silent either way. `autostart` already checks; this is the same pattern.
    return sh(`schtasks /${action} /TN ${TASK}`, { stdio: "inherit" });
}
// Shared tunnel bootstrap: login (token or interactive) → create tunnel →
// DNS route → write tunnel.yml. Used by `vale setup --tunnel` and
// `vale tunnel install`.
function initTunnel(hostname, regKey) {
    const cf = path.join(COMPONENTS_DIR, "cloudflared.exe");
    const cfg = path.join(ETC_DIR, "tunnel.yml");
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
            if (r && r.apiToken) {
                token = r.apiToken;
                console.log("tunnel: key exchanged (consumed once)");
            }
            else
                console.log("tunnel: tunnel-token exchange failed (" +
                    (r && r.error ? r.error : "no token") +
                    ") -- falling back");
        }
        catch (e) {
            console.log("tunnel: exchange unavailable (" + e.message + ") -- falling back");
        }
    }
    const r1 = (0, child_process_1.spawnSync)(cf, token ? ["tunnel", "login", "--token", token] : ["tunnel", "login"], { stdio: "inherit" });
    if (r1.status !== 0) {
        console.error("tunnel: cloudflare login failed");
        process.exit(1);
    }
    const name = "vale-agent-" + host.split(".")[0];
    (0, child_process_1.spawnSync)(cf, ["tunnel", "create", name], { stdio: "inherit" });
    const list = (0, child_process_1.spawnSync)(cf, ["tunnel", "list", "--name", name], { encoding: "utf8" })
        .stdout || "";
    const m = /([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})/.exec(list);
    const tunnelId = m ? m[1] : null;
    if (!tunnelId) {
        console.error("tunnel: could not determine tunnel id");
        process.exit(1);
    }
    const r3 = (0, child_process_1.spawnSync)(cf, ["tunnel", "route", "dns", name, host], {
        stdio: "inherit",
    });
    if (r3.status !== 0) {
        console.error("tunnel: dns route failed");
        process.exit(1);
    }
    const cred = path.join(process.env.USERPROFILE || "", ".cloudflared", tunnelId + ".json");
    // Ingress follows the agent's configured bind port (custom ports 502
    // otherwise); DIR/config.yaml may not exist on fresh installs → default.
    const tunPort = agentPort(ETC_DIR);
    // THE INGRESS MUST NAME THE ADDRESS THE AGENT LISTENS ON, AND IT IS 127.0.0.1.
    //
    // This wrote `http://127.0.0.2:<port>` — and the agent's own provisioning
    // (`agent/src/tunnel.rs`) writes `127.0.0.1`, keeping a helper
    // (`ingress_service`) whose comment says it exists to "reach the agent where it
    // actually listens", and calling 127.0.0.2 "a dead address (502)". Two writers,
    // two answers, one file — and the LIVE DEVICE settles it: `netstat` shows the
    // listener on `127.0.0.1:18080`, and d1's own `etc\tunnel.yml` (written by the
    // agent) says `service: http://127.0.0.1:18080`. So this writer would have
    // repointed a working tunnel at a socket nobody holds.
    //
    // `allow-remote-config: false` IS NOT OPTIONAL EITHER, and it was missing here.
    // The agent writes it deliberately: cloudflared prefers a REMOTE config when one
    // exists, so a stale remote ingress keeps proxying to a dead address "no matter
    // what tunnel.yml says" (tunnel.rs). This writer silently re-enabled that.
    fs.writeFileSync(cfg, [
        "tunnel: " + tunnelId,
        "credentials-file: " + cred,
        "allow-remote-config: false",
        "ingress:",
        "  - hostname: " + host,
        "    service: http://127.0.0.1:" + tunPort,
        "  - service: http_status:404",
        "",
    ].join("\n"));
    console.log("tunnel: installed -- tunnel.yml written, agent spawns it on boot");
    console.log("  hostname:", host);
}
// exported: rollback version gate — a plain dotted triple only (the tgz URL
// interpolates it; anything else could escape the /vale-agent/ prefix). unit-tested.
function rollbackVersionOk(v) {
    return /^\d+\.\d+\.\d+$/.test(v);
}
const commands = {
    // `vale setup` = PURE LOCAL install (no key, no tunnel, no cloud). The
    // gateway/tunnel are OPTIONAL extras configured LATER via the Settings
    // page or the optional flags below:
    //   --reg-key <key>   register the device with the gateway console now
    //   --tunnel <host>   also provision the (free) cloudflared tunnel
    setup(args) {
        const regOk = [];
        let i = args.indexOf("--reg-key");
        let regKey = i >= 0 ? args[i + 1] : process.env.VALE_REG_KEY;
        let ti = args.indexOf("--tunnel");
        let tunnelHost = ti >= 0 ? args[ti + 1] : "";
        let wantTunnel = args.includes("--tunnel") || !!process.env.CLOUDFLARE_API_TOKEN;
        // Device hostname for self-register: explicit --hostname, else default
        // d1.agent.saisi.online. Written to vale-agent.hostname (the agent's
        // self-register reads it at boot).
        const hi = args.indexOf("--hostname");
        const deviceHost = hi >= 0
            ? args[hi + 1]
            : process.env.VALE_HOSTNAME || "d1.agent.saisi.online";
        // review #1 (HIGH): the hostname write ran BEFORE the mkdirSync below —
        // on a FRESH machine DIR doesn't exist yet → ENOENT throw → setup died
        // having installed nothing. Ensure the dir first.
        fs.mkdirSync(ETC_DIR, { recursive: true });
        fs.mkdirSync(COMPONENTS_DIR, { recursive: true });
        fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        fs.writeFileSync(HOSTNAME_FILE, deviceHost);
        // No key required for a local install — key/tunnel are optional extras.
        if (regKey) {
            // WAS: "setup: registering device with the gateway (--reg-key)" — FALSE on this
            // path. `regKey` has exactly ONE consumer, the Cloudflare token exchange inside
            // `initTunnel`, and that runs only under `--tunnel`. So `vale setup --reg-key K`
            // without `--tunnel` printed that line and never used K at all; the device still
            // appeared in the console, but via the AGENT's own token-based self-register on
            // first boot, which needs no key — so the operator credited the key.
            //
            // It cannot be fixed by registering here: the device token is minted by the agent
            // on first boot, and the gateway's POST /api/register wants {key, name, hostname,
            // token}. So the line says what the key is actually for.
            console.log(wantTunnel
                ? "setup: --reg-key will be exchanged for the tunnel token (--tunnel)"
                : "setup: --reg-key noted, but WITHOUT --tunnel it is not used — the device registers itself on first start with its own token. Pass --tunnel to use the key, or add the gateway later in the Settings page.");
        }
        else {
            // WAS: "setup: LOCAL install (no cloud)." — FALSE, and privacy-relevant.
            // The CLI does not write config.yaml at all; the AGENT creates it on first boot
            // from its embedded default, which sets platform.console_url to the public
            // console, and main.rs then POSTs {name, hostname, token} to
            // /api/devices/self-register at boot and every 6h. So a no-key install DOES
            // contact the cloud and appear in the console — which is what the very next lines
            // already say ("device registers on start"), so the operator was told both things
            // at once. The URL is NOT repeated here on purpose: it lives in the agent's
            // embedded default, and a second copy in a CLI message is a copy that drifts.
            console.log("setup: no key or tunnel configured — the device will still self-register with the console URL in its config on start.");
            console.log("setup: to keep it purely local, clear platform.console_url in config.yaml (unset = no cloud), or point it at your own gateway.");
        }
        fs.mkdirSync(DIR, { recursive: true });
        // Layout-v2 migration (ADR 0008): a re-setup on a pre-v2 device moves
        // the old root paths into their v2 homes before anything stages.
        // Idempotent (fresh installs no-op). Runs here — before the residue
        // cleanup below, which targets the NEW homes.
        try {
            const mig = psFile(migrateLayoutPs((0, exports.psq)(DIR), (0, exports.psq)(DATA_DIR)).join("\r\n"));
            if (!mig || mig.status !== 0)
                console.log("setup: layout migration had warnings (continuing)");
        }
        catch {
            console.log("setup: layout migration skipped (continuing)");
        }
        // ---- idempotent reinstall: clean every legacy residue BEFORE writing
        // anything (a re-run of `vale setup` must leave a pristine install).
        // 1. Stop any running vale processes (a live agent locks its exe and the
        //    copy below would fail).
        console.log("setup: stopping existing vale processes...");
        // Best-effort cleanup of things that usually do NOT exist, so send BOTH
        // streams to NUL. `2>NUL` alone left sc/reg/schtasks messages on STDOUT:
        // every install printed scary fake errors ("[SC] OpenService 失败 1060",
        // "错误: 系统找不到指定的文件。") that were really "nothing to clean".
        sh("cmd /c schtasks /End /TN ValeAgent >NUL 2>&1");
        sh("taskkill /F /IM vale-agent.exe 2>NUL");
        sh("taskkill /F /IM vale-desktop.exe 2>NUL");
        sh("taskkill /F /IM vale-tray.exe 2>NUL");
        // 2. Remove legacy scheduled tasks (ValePlaywright from old installs,
        //    ValeAgentTray) — ValeAgent is re-registered below with -Force.
        sh("cmd /c schtasks /Delete /TN ValeAgentTray /F >NUL 2>&1");
        sh("cmd /c schtasks /Delete /TN ValePlaywright /F >NUL 2>&1");
        // 3. Remove the legacy Cloudflared Windows service + EventLog source
        //    (installed by the retired setup.ps1; the agent-supervised model
        //    installs no service).
        sh("sc stop Cloudflared >NUL 2>&1");
        sh("sc delete Cloudflared >NUL 2>&1");
        sh("reg delete HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Cloudflared /f >NUL 2>&1");
        // 4. Stale update-busy marker (a crashed update would lock updates).
        const BUSY = path.join(process.env.ProgramData || "C:\\ProgramData", "ValeAgent", "update-busy");
        sh(`powershell -NoProfile -Command "Remove-Item -Force -ErrorAction SilentlyContinue '${(0, exports.psq)(BUSY)}'"`);
        // 5. Refresh the BOXED playwright bundle: delete the old tree first so a
        //    removed package/version never leaves stale files behind.
        //    round-163: kill the runner/bridge node processes FIRST — a running
        //    node.exe holds its image file locked, the Remove-Item/Expand-Archive
        //    pair silently skipped it, and the device was left with a playwright
        //    dir WITHOUT node.exe (bridge could never spawn again; observed d1).
        sh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${(0, exports.psq)(DIR)}*playwright*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`);
        sh(`powershell -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${(0, exports.psq)(PW_DIR)}'"`);
        // 6. Legacy install dirs from retired installers (C:\vale-agent /
        //    D:\vale-agent). If the registry now points at a DIFFERENT dir and a
        //    legacy dir exists, it is a residue of the old channel — remove it
        //    (the data that matters lives in %ProgramData%\Vale; the old dirs
        //    held programs + config only).
        for (const legacy of ["C:\\vale-agent", "D:\\vale-agent"]) {
            if (legacy !== DIR && fs.existsSync(legacy)) {
                console.log("setup: removing legacy install dir", legacy);
                sh(`powershell -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${(0, exports.psq)(legacy)}'"`);
            }
        }
        // 7. stage-brand: heal a stale desktop shortcut (a 2026-09-01 Vale.lnk
        //    launches the RETIRED Tauri exe with the old embedded icon) + drop
        //    the retired orphans. Repair-only (helper checks link existence).
        //    Backslash-escape the .lnk Arguments double quotes for -Command.
        console.log("setup: reconciling desktop shortcut (retired-exe repair)...");
        sh(`powershell -NoProfile -Command "${deskShortcutRepairPs((0, exports.psq)(SCRIPTS_DIR), (0, exports.psq)(DESK_DIR), "Write-Host").join("; ").replace(/"/g, '\\"')}"`);
        // C1: write the registry single source of truth (InstallDir; DataDir
        // defaults to %ProgramData%\Vale). Everything else reads it back.
        // `regOk` is collected here and summarised at the end of setup: best-effort, but the
        // operator should be told once, with the consequence, rather than not at all.
        regOk.push(regWrite("InstallDir", DIR));
        regOk.push(regWrite("DataDir", path.join(process.env.ProgramData || "C:\\ProgramData", "Vale")));
        // Pre-create the data dir tree (sessions/memory/logs — C1 separation).
        const DATA = DATA_DIR;
        for (const sub of ["sessions", "memory", "logs"]) {
            fs.mkdirSync(path.join(DATA, sub), { recursive: true });
        }
        if (!fs.existsSync(EXE_SRC)) {
            console.error("setup: vale-agent.exe missing from package:", EXE_SRC);
            process.exit(1);
        }
        // The just-killed agent's file handle can lag a beat (and AV may scan the
        // fresh exe), so a bare copyFileSync raced EBUSY on reinstall — the update
        // swap retries this 12x; setup never did. Retry, re-killing a respawned
        // instance between attempts.
        {
            let copied = false;
            for (let i = 0; i < 12; i++) {
                try {
                    fs.copyFileSync(EXE_SRC, EXE_DST);
                    copied = true;
                    break;
                }
                catch (e) {
                    if (e?.code !== "EBUSY" &&
                        e?.code !== "EPERM" &&
                        e?.code !== "EACCES") {
                        console.error("setup: exe copy failed:", e?.message || e);
                        process.exit(1);
                    }
                    (0, child_process_1.spawnSync)("cmd", ["/c", "taskkill", "/F", "/IM", "vale-agent.exe"], {
                        stdio: "ignore",
                    });
                    try {
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
                    }
                    catch {
                        /* best-effort sleep */
                    }
                }
            }
            if (!copied) {
                console.error("setup: FATAL -- could not replace vale-agent.exe (locked). Close any running Vale agent and re-run the installer.");
                process.exit(1);
            }
        }
        // B2: stage the boxed playwright bundle (node_modules ONLY — node.exe is
        // NOT bundled; the system node detected below runs it). Single small
        // artifact in the npm package, Vale version-locked.
        const PW_ZIP = path.join(__dirname, "..", "vale-playwright.zip");
        if (fs.existsSync(PW_ZIP)) {
            const pwDir = PW_DIR;
            fs.mkdirSync(pwDir, { recursive: true });
            sh(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${(0, exports.psq)(PW_ZIP)}' -DestinationPath '${(0, exports.psq)(COMPONENTS_DIR)}'"`);
            // round-163: the whole point of the bundle is node.exe — VERIFY it
            // landed (a silently-missing copy killed the bridge forever on d1).
            // One retry, then fail loudly: a half-staged bundle is worse than none.
            if (!fs.existsSync(path.join(pwDir, "node.exe"))) {
                console.log("setup: node.exe missing after expand -- retrying once");
                sh(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${(0, exports.psq)(PW_ZIP)}' -DestinationPath '${(0, exports.psq)(COMPONENTS_DIR)}'"`);
            }
            // "node_modules verified" was in the message while only node.exe was checked —
            // and node_modules is where the entry point the agent actually runs lives, so a
            // half-expanded bundle passed the check and failed at first use.
            const pwCli = path.join(pwDir, "node_modules", "@playwright", "mcp", "cli.js");
            if (fs.existsSync(path.join(pwDir, "node.exe")) && fs.existsSync(pwCli)) {
                console.log("setup: playwright bundle staged (node.exe + node_modules/@playwright/mcp verified)");
            }
            else {
                // NEVER fatal. The browser bundle is an OPTIONAL component, but this
                // branch hard-failed (exit 1) the whole agent install the moment
                // 1.2.311 started shipping the zip — its trigger is AV quarantining
                // playwright\node.exe (documented on d1). Drop the half-staged tree so
                // the agent cleanly sees "no bundle" and carry on: the agent core
                // does not need playwright.
                console.error("setup: WARNING -- playwright bundle staged WITHOUT node.exe (AV/lock interference?); browser tools stay disabled, agent install continues.");
                try {
                    fs.rmSync(pwDir, { recursive: true, force: true });
                }
                catch {
                    /* best-effort */
                }
            }
        }
        else {
            console.log("setup: vale-playwright.zip not in package (browser tools disabled)");
        }
        // Node runtime: the device has node (npm works), but the agent runs as
        // SYSTEM which may not see the user PATH — resolve the ABSOLUTE node path
        // now and record it in the registry so the agent can spawn it.
        const nodeWhich = (0, child_process_1.spawnSync)("where", ["node"], { encoding: "utf8" });
        const nodePath = nodeWhich.status === 0 && nodeWhich.stdout
            ? nodeWhich.stdout.split(/\r?\n/)[0].trim()
            : "";
        if (nodePath) {
            try {
                regOk.push(regWrite("NodePath", nodePath));
                console.log("setup: system node detected:", nodePath);
            }
            catch {
                /* non-fatal */
            }
        }
        else {
            console.log("setup: WARNING -- node not found in PATH (browser tools need node)");
        }
        // C2: stage the boxed cloudflared binary into components/ (optional — local
        // mode works without it; only used when the user opts into public access).
        const CF_SRC = path.join(__dirname, "..", "cloudflared.exe");
        if (fs.existsSync(CF_SRC)) {
            fs.mkdirSync(COMPONENTS_DIR, { recursive: true });
            fs.copyFileSync(CF_SRC, path.join(COMPONENTS_DIR, "cloudflared.exe"));
            console.log("setup: cloudflared staged (tunnel optional -- `vale tunnel install` to enable)");
        }
        // P2-4: record the boxed-component versions (never fail-closed).
        writeBoxedVersions(DIR, path.join(__dirname, ".."));
        // round-330: Tauri vale-desktop staging removed (retired).
        // stage-l: stage the Electron shell sources (main/preload) so the desktop
        // app picks up menu/command features on a fresh install too.
        stageDesktopShell(DIR, "");
        console.log("setup: vale-desktop-electron sources staged");
        // Layout v2: write the start-desktop.ps1 launcher into scripts\ (the
        // ValeDesktop onlogon task + desktop Vale.lnk both call it). Was never
        // written before — a real gap that left the shell unlaunchable.
        fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCRIPTS_DIR, "start-desktop.ps1"), startDesktopPs((0, exports.psq)(DESK_DIR)).join("\r\n"), "utf8");
        console.log("setup: scripts\\start-desktop.ps1 written");
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
        //   - explicit config -Argument   layout v2 (never the exe path)
        const regRes = ps(bootTaskPs((0, exports.psq)(EXE_DST), (0, exports.psq)(CFG_FILE), true).join("; "));
        if (!regRes || regRes.status !== 0) {
            console.error("setup: FATAL -- task registration failed (audit #7: used to claim success regardless).");
            process.exit(1);
        }
        // round-298 parity: a FRESH install must carry the release marker — without it
        // agent_update compares against the Cargo 1.0.x fallback and re-downloads + swaps
        // on every call.
        //
        // WRITTEN HERE, and that placement IS the fix: it used to sit ~20 lines ABOVE this
        // point while its comment claimed "after the exe copy + task registration (setup
        // provably succeeded)". The registration exits 1 on failure, so an aborted setup
        // left the marker claiming a version on an install with NO boot task — and
        // `vale status` reported "(this device is current)" for a device that never starts.
        // A marker must not be written before the thing it attests to.
        writeReleaseMarker(DIR);
        // Control-panel entry for npm-path installs too (the NSIS writer owns
        // UninstallString on its installs; the helper never overwrites one).
        // Best-effort — a registry failure must not fail the install.
        try {
            const pkgVer = String(require("../package.json").version || "");
            const ureg = ps(uninstallRegBodyPs((0, exports.psq)(DIR), pkgVer).join("; "));
            console.log("setup: control-panel uninstall entry" +
                (ureg && ureg.status === 0
                    ? " ensured"
                    : " (ensure failed -- uninstall via `vale uninstall`)"));
        }
        catch {
            console.log("setup: control-panel entry skipped (uninstall via `vale uninstall`)");
        }
        console.log("setup: installed to", DIR);
        // One summary rather than N scattered warnings, and it names the CONSEQUENCE
        // (path resolution disagrees) instead of just the failed call.
        if (regOk.includes(false)) {
            console.error("setup: WARNING -- the registry entry for this install is INCOMPLETE (" +
                regOk.filter((ok) => !ok).length +
                " of " +
                regOk.length +
                " writes failed). The agent resolves its paths from the registry, so it may look in the DEFAULT location instead of " +
                DIR +
                ". Re-run `vale setup` elevated if that matters.");
        }
        console.log("setup: device registers on start -- check the console Devices list");
        // Inbound firewall for the agent port (idempotent; inert when bound to
        // loopback, required for LAN clients otherwise). Best-effort, never
        // fail-closed — a locked-down box keeps working locally regardless.
        try {
            const fwPort = agentPort(ETC_DIR);
            const fw = ps(firewallPs(fwPort).join("; "));
            console.log("setup: firewall inbound TCP " +
                fwPort +
                (fw && fw.status === 0
                    ? " ensured"
                    : " (ensure failed -- LAN clients may be blocked)"));
        }
        catch {
            console.log("setup: firewall ensure skipped (LAN clients may be blocked)");
        }
        // Optional: provision the tunnel in the same command (no second step).
        if (wantTunnel) {
            console.log("setup: provisioning cloudflare tunnel...");
            initTunnel(tunnelHost, regKey);
        }
        else {
            console.log("setup: no tunnel configured (local mode). Enable later with `vale tunnel install <hostname>`.");
        }
    },
    status() {
        // NOT via shell: `shell: true` concatenates argv into one cmd.exe string,
        // so the unquoted filter "IMAGENAME eq …" was split at its spaces, tasklist
        // rejected it, and this ALWAYS printed STOPPED even with the agent running.
        // (IMAGENAME also takes no wildcard — the old `vale-agent*` never matched.)
        const out = (0, child_process_1.spawnSync)("tasklist", ["/FI", "IMAGENAME eq vale-agent.exe"], {
            encoding: "utf8",
        }).stdout || "";
        // The report answers "where is this device, and is a swap still pending" —
        // the question that cost four hand reads (and one wrong conclusion) in the
        // incident. Gathering the facts is thin I/O; the SHAPE lives in the pure
        // `statusReport`, which is where the tests can reach it.
        let releaseVersion = null;
        try {
            const v = fs
                .readFileSync(path.join(ETC_DIR, ".vale-release"), "utf8")
                .trim();
            if (v)
                releaseVersion = v;
        }
        catch {
            /* absent => unknown, never fabricated */
        }
        let updateMarkerMs = null;
        // Only ENOENT means "no marker". Any OTHER stat error (EACCES/EBUSY) used to land
        // here too and was reported as "update: none in flight" — a claim about an update
        // that may be running right now. This is the sibling of the `rollback --clear` fix:
        // the same catch treated a failure to READ as evidence of ABSENCE.
        let updateMarkerUnreadable = false;
        try {
            updateMarkerMs = fs.statSync(updateBusyPath()).mtimeMs;
        }
        catch (e) {
            if (e && e.code !== "ENOENT")
                updateMarkerUnreadable = true;
        }
        let packageVersion = "";
        try {
            packageVersion = String(require("../package.json").version || "");
        }
        catch {
            /* best-effort */
        }
        // What the CDN advertises, so `status` can answer "is this device current" —
        // the question every round of this project's log answered by hand. Bounded
        // HARD (3 s): `status` is the command an operator runs when something is
        // already wrong, and a status that hangs on a network blip is worse than one
        // that says it could not check. A failure yields `null`, which the report
        // renders as "could NOT be checked" — never as agreement.
        const latestVersion = latestCdnVersion();
        for (const line of statusReport({
            agentRunning: out.includes("vale-agent"),
            installDir: DIR,
            exeExists: fs.existsSync(EXE_DST),
            port: agentPort(ETC_DIR),
            releaseVersion,
            updateMarkerMs,
            updateMarkerUnreadable,
            packageVersion,
            latestVersion,
            nowMs: Date.now(),
        })) {
            console.log(line);
        }
    },
    start() {
        svc("Run");
    },
    stop() {
        const r = svc("End");
        if (r && r.status !== 0) {
            console.error(`vale stop: schtasks /End failed (status ${r.status}) -- the agent may still be running`);
            process.exit(1);
        }
        console.log("stopped -- revives via 'vale start' or the 5-min watchdog ('vale autostart off' opts out of autostart)");
    },
    restart() {
        svc("End");
        sh("timeout /t 2 >nul");
        svc("Run");
    },
    // Boot switch: `vale autostart on|off|status` (default status). Flips the
    // ENABLED flag on BOTH boot tasks (service + desktop shell) — this is the
    // only real "don't start at boot" control; `vale stop` is one-shot and
    // the watchdog revives it. Missing task = skipped with a note (never
    // fatal — headless installs have no ValeDesktop). State read via
    // Get-ScheduledTask (locale-independent enum, unlike schtasks /Query
    // headers which localize).
    autostart(args) {
        const sub = String(args[0] || "status").toLowerCase();
        if (sub === "status") {
            for (const t of exports.BOOT_TASKS) {
                const r = (0, child_process_1.spawnSync)("powershell", [
                    "-NoProfile",
                    "-Command",
                    `(Get-ScheduledTask -TaskName '${t}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State -ErrorAction SilentlyContinue)`,
                ], { encoding: "utf8" });
                const s = String((r && r.stdout) || "").trim();
                console.log(`${t}: ${s || "(not installed)"}`);
            }
            return;
        }
        if (sub !== "on" && sub !== "off") {
            console.error("usage: vale autostart <on|off|status>");
            process.exit(1);
        }
        let failed = false;
        let skipped = 0;
        for (const t of exports.BOOT_TASKS) {
            // ASK WHETHER THE TASK EXISTS FIRST. The comment above this loop has said
            // "Missing task = skipped with a note (never fatal -- headless installs have no
            // ValeDesktop)" all along, and the code below it made a missing task FATAL — so a
            // headless install could not turn autostart off at all, and the advice printed with
            // it ("run vale setup first") cannot help, because `vale setup` never registers
            // ValeDesktop (only the NSIS online installer does).
            const exists = (0, child_process_1.spawnSync)("schtasks", ["/Query", "/TN", t], { encoding: "utf8" })
                .status === 0;
            if (!exists) {
                console.log(`autostart: ${t} not installed -- skipped (headless install)`);
                skipped += 1;
                continue;
            }
            const argv = autostartArgv(t, sub);
            const r = (0, child_process_1.spawnSync)(argv[0], argv.slice(1), { stdio: "inherit" });
            if (!r || r.status !== 0) {
                console.error(`autostart: ${t} ${sub} FAILED on an existing task (status ${r ? r.status : "?"}) -- the change did not take`);
                failed = true;
            }
            else {
                console.log(`autostart: ${t} ${sub === "on" ? "enabled" : "disabled"}`);
            }
        }
        if (skipped === exports.BOOT_TASKS.length) {
            console.error("autostart: no boot tasks found -- nothing to switch. `vale setup` registers the agent task; the desktop task comes from the installer.");
            process.exit(1);
        }
        // Only claim the durable outcome when every EXISTING task actually changed.
        if (sub === "off" && !failed)
            console.log("autostart: off -- tasks stay disabled across reboot until 'vale autostart on'");
        if (failed)
            process.exit(1);
    },
    async update() {
        // npm audit #10: no mutual exclusion — two updates (or setup racing a
        // swap) interleave Copy-Item on *.new, leaving a half-written exe "ok".
        // setup REMOVES the marker; update now CREATES it (refuse if <10 min
        // old); the swap script clears it after restart.
        // MEDIUM npm audit: use 'wx' exclusive-create so two racing updaters
        // cannot BOTH pass the freshness check — the second openSync throws
        // EEXIST and the WMI swap is never launched concurrently.
        const BUSYM = updateBusyPath();
        try {
            fs.mkdirSync(path.dirname(BUSYM), { recursive: true });
            const fd = fs.openSync(BUSYM, "wx");
            fs.writeSync(fd, String(Date.now()));
            fs.closeSync(fd);
        }
        catch (e) {
            if (e?.code === "EEXIST") {
                // Exists → check freshness (the owner may have died mid-swap).
                try {
                    const st = fs.statSync(BUSYM);
                    if (busyIsFresh(st.mtimeMs, Date.now())) {
                        console.error("update: another update looks in progress (" +
                            BUSYM +
                            " <10 min old) -- wait, or delete the marker after a mid-swap reboot");
                        process.exit(1);
                    }
                    // Stale marker — overwrite it.
                    fs.writeFileSync(BUSYM, String(Date.now()));
                }
                catch {
                    console.error("update: another update looks in progress (cannot stat " +
                        BUSYM +
                        ")");
                    process.exit(1);
                }
            }
            else {
                throw e; // a real FS error — do not proceed
            }
        }
        // THE RECEIPT, before anything irreversible happens. Everything past this
        // point ends with the agent being killed — which is the DOCUMENTED success
        // signal ("the connection drops for ~10 s"), and therefore indistinguishable
        // from a transport failure that never ran this command at all. One line in
        // the log the swap itself appends to is what separates the two cases for
        // whoever reads the device afterwards.
        let fromVersion = "";
        try {
            fromVersion = fs
                .readFileSync(path.join(ETC_DIR, ".vale-release"), "utf8")
                .trim();
        }
        catch {
            /* unknown */
        }
        let toVersion = "";
        try {
            toVersion = String(require("../package.json").version || "");
        }
        catch {
            /* best-effort */
        }
        console.log(`update: ${fromVersion || "unknown"} -> ${toVersion || "unknown"} -- staging, the connection will drop`);
        try {
            ps(updateReceiptPs((0, exports.psq)(DATA_DIR), fromVersion || "unknown", toVersion || "unknown").join("; "));
        }
        catch {
            /* best-effort: a missing receipt must never block a real update */
        }
        // Swap the exe in-place: stop -> replace (with retry; the running agent
        // locks its own file) -> start.
        //
        // THE MARKER IS ALREADY CREATED at this point, and the only things that
        // release it are the WMI-failure handler below and the swap script's own
        // cleanup. Staging in between is NOT guarded by either: a full disk, an
        // antivirus lock or a permission error on the copy throws straight out to
        // the top level, leaving the marker behind — and the NEXT `vale update`
        // then refuses for ten minutes citing an update that never started, while
        // the operator sees only a stack trace. Its neighbours
        // (`writeBoxedVersions`, `writeReleaseMarker`) are best-effort for the same
        // reason; this is the one region where a throw strands a LOCK.
        try {
            if (!fs.existsSync(EXE_SRC)) {
                console.error("exe missing from package:", EXE_SRC);
                throw new Error("exe missing from package: " + EXE_SRC);
            }
            fs.mkdirSync(DIR, { recursive: true });
            fs.copyFileSync(EXE_SRC, path.join(DIR, "vale-agent.new.exe"));
            // stage-l: ship the Electron desktop shell's main/preload alongside —
            // the desktop app (components\vale-desktop-electron) loads these sources;
            // without the sync, new menu/command features never reach the device.
            // (setup writes in place; update stages *.new for the atomic swap.)
            stageDesktopShell(DIR, ".new");
        }
        catch (e) {
            try {
                fs.unlinkSync(BUSYM);
            }
            catch {
                /* never created, or already gone */
            }
            console.error("update: staging failed before the swap (" +
                (e && e.message ? e.message : e) +
                ")");
            console.error("update: nothing was swapped and the in-progress marker was released -- safe to re-run");
            process.exit(1);
        }
        // P2-4: refresh the boxed-component manifest from the staged package +
        // the current install dir (best-effort, never fail-closed).
        writeBoxedVersions(DIR, path.join(__dirname, ".."));
        const q = DIR.replace(/'/g, "''");
        const qd = DATA_DIR.replace(/'/g, "''");
        const log = `Out-File '${qd}\\logs\\vale-update.log' -Append`;
        // round-143: write the run-hidden.vbs wrapper next to node.exe, so the
        // ValePlaywright scheduled task can launch node.exe without flashing a
        // visible cmd window. Idempotent — overwrites any existing copy.
        // Layout v2: launchers live in scripts\, the runtime stays in
        // components\playwright\. The old-layout gate keeps migrating devices
        // refreshed too (migration carries the files over regardless).
        const pwDir = PW_DIR;
        const vbsPath = path.join(SCRIPTS_DIR, "run-hidden.vbs");
        // round-246 (browser-display audit C3) + round-257 + round-263:
        // ONE-BROWSER — the AI must drive the SAME browser the user watches:
        // the Electron desktop embedded WebContentsView (CDP 9333). The
        // ValePlaywright task used to launch playwright-mcp with --headless (a
        // PRIVATE chromium nobody sees). The task now goes through a probe
        // launcher that attaches to the DESKTOP view (9333) and falls back to a
        // private headless only when the desktop is down (agent restart window).
        // The bridge chromium (9223) tier was removed in round-263.
        const probePath = path.join(SCRIPTS_DIR, "playwright-probe.ps1");
        fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
        if (fs.existsSync(pwDir) || fs.existsSync(path.join(DIR, "playwright"))) {
            // round-143: ASCII-only VBS (no em-dash, no Unicode). VBScript on
            // Windows uses the system locale; non-ASCII in comments corrupts the
            // file and causes "unterminated string constant" (800A0409). Use chr(34)
            // to produce literal double-quotes without string-escaping issues.
            fs.writeFileSync(vbsPath, [
                "Dim sh,cmd,i",
                'Set sh=CreateObject("WScript.Shell")',
                'cmd=chr(34) & WScript.Arguments(0) & chr(34) & " " & chr(34) & WScript.Arguments(1) & chr(34)',
                "For i=2 To WScript.Arguments.Count-1",
                '  cmd=cmd & " " & WScript.Arguments(i)',
                "Next",
                "sh.Run cmd,0,False",
            ].join("\r\n"));
            // round-246 (C3) + round-257 + round-263: the probe launcher
            // (playwrightProbePs, unit-tested).
            fs.writeFileSync(probePath, playwrightProbePs().join("\r\n"));
        }
        // Layout v2: write the start-desktop.ps1 launcher into scripts\ (the
        // ValeDesktop onlogon task + desktop Vale.lnk both call it). Was never
        // written before — a real gap that left the shell unlaunchable. Written
        // unconditionally: on a pre-v2 device components\ appears only after
        // the swap script's migration, and a headless install simply never
        // calls the launcher (shortcut repair is Test-Path guarded anyway).
        fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCRIPTS_DIR, "start-desktop.ps1"), startDesktopPs((0, exports.psq)(DESK_DIR)).join("\r\n"), "utf8");
        // round-298: record the release version on a PROVABLY successful swap
        // so agent_update (which reads <install>/.vale-release as its local
        // version) reports up_to_date instead of re-swapping every call.
        let relVer = "";
        try {
            relVer = String(require("../package.json").version || "");
        }
        catch {
            /* best-effort */
        }
        const script = [
            `"[$(Get-Date -Format o)] update start" | ${log}`,
            // Layout v2 FIRST: repoint the boot task at the explicit config path
            // BEFORE touching anything (fail-closed — a config-path argument boots
            // old AND new agents alike, so aborting here leaves the old version
            // running untouched). Without this the moved config strands the boot.
            `try { ${bootTaskPs(`${q}\\vale-agent.exe`, `${q}\\etc\\config.yaml`, false).join("; ")} } catch { "[$(Get-Date -Format o)] task repoint FAILED: $($_.Exception.Message)" | ${log}; try { Remove-Item -Force (Join-Path $env:ProgramData 'ValeAgent\\update-busy') } catch {}; exit 1 }`,
            `"[$(Get-Date -Format o)] task repointed at etc\\config.yaml" | ${log}`,
            // Layout-v2 migration (ADR 0008): move pre-v2 root paths into their
            // v2 homes. Best-effort per item; the gate below is fail-closed.
            ...migrateLayoutPs(q, qd),
            // Fail-closed gate: the new agent reads ONLY the v2 homes. A missing
            // config/hostname here means migration failed — do NOT swap (the old
            // exe keeps running the old layout until the next update).
            `if ((-not (Test-Path '${q}\\etc\\config.yaml')) -or (-not (Test-Path '${q}\\etc\\vale-agent.hostname'))) { "[$(Get-Date -Format o)] migration gate FAILED (etc\\config.yaml/hostname missing) -- aborting, old version keeps running" | ${log}; try { Remove-Item -Force (Join-Path $env:ProgramData 'ValeAgent\\update-busy') } catch {}; exit 1 }`,
            // A running exe cannot be overwritten on Windows — stop the service
            // first (task end + process kill), THEN swap with retry.
            "try { Stop-ScheduledTask ValeAgent -ErrorAction Stop } catch {}",
            "Get-Process vale-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
            "Start-Sleep -Milliseconds 1500",
            "$ok=$false",
            `foreach($i in 1..12){ try { Copy-Item -Force -ErrorAction Stop '${q}\\vale-agent.new.exe' '${q}\\vale-agent.exe'; $ok=$true; break } catch { Start-Sleep -Milliseconds 800 } }`,
            `"[$(Get-Date -Format o)] copy ok=$ok" | ${log}`,
            // round-298: .vale-release is only written when the copy provably
            // completed (a failed swap keeps the device on the OLD exe — the
            // marker must not lie). The marker is what agent_update compares.
            `if ($ok -and '${relVer}') { Set-Content -Path '${q}\\etc\\.vale-release' -Value '${relVer}' -NoNewline -ErrorAction SilentlyContinue }`,
            // Add/Remove-Programs parity (same $ok gate — a failed swap must not
            // move the displayed version either).
            ...uninstallVersionPs(q, relVer),
            `Remove-Item -Force -ErrorAction SilentlyContinue '${q}\\vale-agent.new.exe'`,
            // stage-l: swap the desktop shell sources (main/preload) with retry —
            // the running Electron may hold them briefly.
            `foreach($df in @('main.js','preload.js','url-policy.js')){ $ds='${q}\\components\\vale-desktop-electron\\src\\'+$df+'.new'; if (Test-Path $ds) { $ok2=$false; foreach($i in 1..8){ try { Copy-Item -Force -ErrorAction Stop $ds ('${q}\\components\\vale-desktop-electron\\src\\'+$df); $ok2=$true; break } catch { Start-Sleep -Milliseconds 500 } }; Remove-Item -Force -ErrorAction SilentlyContinue $ds; "[$(Get-Date -Format o)] desk $df ok=$ok2" | ${log} } }`,
            // NEVER leave the device dark: even a failed swap must bring the task
            // back up (it will run the old exe until the next update).
            `try { Start-ScheduledTask ValeAgent -ErrorAction Stop } catch { schtasks /Run /TN ValeAgent }`,
            `"[$(Get-Date -Format o)] task restarted" | ${log}`,
            `try { Remove-Item -Force (Join-Path $env:ProgramData 'ValeAgent\\update-busy') } catch {}`,
            // Custom-port installs: the firewall rule must track the configured
            // bind port (baked at update time from the live config.yaml — the
            // swap itself runs from a static file and cannot read it).
            ...firewallPs(agentPort(ETC_DIR)),
            // stage-n: restart the Electron shell so newly-synced main/preload
            // sources take effect. The shell is INDEPENDENT of the ValeAgent task —
            // it probes the configured port and loads /desktop/. Kill + relaunch
            // via start-desktop.ps1 (the same path ValeDesktop onlogon uses); if
            // the task/script is missing (non-desktop install), skip silently.
            `$deskDir = '${q}\\components\\vale-desktop-electron'`,
            `$deskStart = '${q}\\scripts\\start-desktop.ps1'`,
            // stage-n: harden the SHELL supervisor itself — ValeDesktop gains a
            // 5-minute repetition trigger so a dead electron is reborn within
            // ≤5 min (previously only started at logon: "the watchdog died" left
            // d1 dark on 2026-09-25). Two field-test lessons encoded here:
            //  - `schtasks /Change /RI 5` prompts for the /ru password interactively
            //    (hung the PTY) and PS-array invocation mangles cmd-style args —
            //    use the ScheduledTasks cmdlets (SYSTEM runs them without prompt,
            //    mirroring ValeAgent's proven -Once + -RepetitionInterval pattern).
            //  - the pulse must NOT start a second electron while one is alive
            //    (second-instance focuses the window = focus steal every 5 min) —
            //    the guarded ensure-desktop.ps1 checks Get-Process first, and the
            //    wscript wrapper runs it with no console flash.
            `$en1 = '${q}\\scripts\\ensure-desktop.ps1'`,
            `$vb1 = '${q}\\scripts\\desktop-pulse.vbs'`,
            `Set-Content -Path $en1 -Value 'if (Get-Process electron -ErrorAction SilentlyContinue) { exit }; & powershell -NoProfile -ExecutionPolicy Bypass -File "${q}\\scripts\\start-desktop.ps1"' -Force`,
            `Set-Content -Path $vb1 -Value 'CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & "${q}\\scripts\\ensure-desktop.ps1" & Chr(34), 0, False' -Force`,
            `if ($null -ne (Get-ScheduledTask -TaskName 'ValeDesktop' -ErrorAction SilentlyContinue)) {`,
            `  $da = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vb1 + '"') -WorkingDirectory '${q}'`,
            `  $dt1 = New-ScheduledTaskTrigger -AtLogOn`,
            `  $dw1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 5)`,
            `  Set-ScheduledTask -TaskName 'ValeDesktop' -Action $da -Trigger @($dt1, $dw1) | Out-Null`,
            `  "[$(Get-Date -Format o)] desk: ValeDesktop hardened (guarded 5-min pulse)" | ${log}`,
            `}`,
            `if ((Test-Path $deskDir) -and (Test-Path $deskStart)) {`,
            `  "[$(Get-Date -Format o)] desk: restarting electron shell" | ${log}`,
            `  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
            `  Start-Sleep -Milliseconds 1500`,
            `  $deskTask = Get-ScheduledTask -TaskName 'ValeDesktop' -ErrorAction SilentlyContinue`,
            // Start-ScheduledTask works for Ready AND Running tasks (Running is a
            // no-op) — use it unconditionally; the WMI-hosted swap process must not
            // spawn electron as its own child (it would be reaped with us; proven
            // twice on d1).
            `  if ($deskTask) { Start-ScheduledTask -TaskName 'ValeDesktop' -ErrorAction SilentlyContinue }`,
            // no ValeDesktop task (headless install): `cmd start` detaches the
            // shell from the swap host so it is not reaped with it.
            `  else { & cmd /c start /min "" powershell -NoProfile -ExecutionPolicy Bypass -File "$deskStart" }`,
            `  "[$(Get-Date -Format o)] desk: electron restart initiated" | ${log}`,
            `} else { "[$(Get-Date -Format o)] desk: no electron shell (skipped)" | ${log} }`,
            // stage-brand: heal a stale desktop shortcut (Vale.lnk -> retired
            // Tauri exe) + drop the retired orphans. Repair-only, best-effort.
            ...deskShortcutRepairPs(`${q}\\scripts`, `${q}\\components\\vale-desktop-electron`, log),
            // round-143: re-register ValePlaywright via the wscript/VBS wrapper so
            // node.exe no longer allocates a visible console. Idempotent — task may
            // not exist (older install paths), so wrap in try/catch.
            `$pwVbs = '${q}\\scripts\\run-hidden.vbs'`,
            `$pwProbe = '${q}\\scripts\\playwright-probe.ps1'`,
            `if ((Test-Path $pwVbs) -and (Test-Path $pwProbe)) {`,
            `  $pwNode = '${q}\\components\\playwright\\node.exe'`,
            `  $pwCli  = '${q}\\components\\playwright\\node_modules\\@playwright\\mcp\\cli.js'`,
            `  if ((Test-Path $pwNode) -and (Test-Path $pwCli)) {`, // parens: bare -and is a param parse error
            // Read the CURRENT task's UserId BEFORE unregistering — we need to know
            // who the task runs as (Administrator), but $env:USERNAME returns
            // "SYSTEM" when spawned via WMI, and Win32_ComputerSystem.UserName is
            // empty from session 0. The existing task's Principal is the most
            // reliable source. Fall back to the local user if the task doesn't exist.
            `    $oldTask = Get-ScheduledTask -TaskName 'ValePlaywright' -ErrorAction SilentlyContinue`,
            `    $pwUser = if ($oldTask) { $oldTask.Principal.UserId } else { (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName -replace '^.*\\\\', '' }`,
            `    try { Unregister-ScheduledTask -TaskName 'ValePlaywright' -Confirm:$false -ErrorAction SilentlyContinue } catch {}`,
            // round-246 (C3) + round-263: route through the probe launcher — it
            // attaches to the Electron desktop view (CDP 9333) when up, so AI
            // actions on 9229 drive the SAME browser the user watches (no more
            // invisible private headless).
            `    $pwPs = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'`,
            `    $pwArgs = '"' + $pwVbs + '" "' + $pwPs + '" -NoProfile -File "' + $pwProbe + '" "' + $pwNode + '" "' + $pwCli + '"'`,
            `    $pwAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\wscript.exe') -Argument $pwArgs`,
            `    $pwBoot = New-ScheduledTaskTrigger -AtLogOn`,
            `    $pwWatch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)`,
            `    $pwSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable`,
            `    Register-ScheduledTask -TaskName 'ValePlaywright' -Action $pwAction -Trigger @($pwBoot, $pwWatch) -Principal (New-ScheduledTaskPrincipal -UserId $pwUser -LogonType Interactive -RunLevel Limited) -Settings $pwSettings -Force | Out-Null`,
            `    Start-ScheduledTask -TaskName 'ValePlaywright' | Out-Null`,
            `    "[$(Get-Date -Format o)] ValePlaywright re-registered (probe launcher, user=$pwUser)" | ${log}`,
            `  }`,
            `}`,
            // Layout v2: the swap script itself is transient — delete it last
            // (the Rust agent_update twin already self-deletes; this one lingered
            // at the install root forever).
            `try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction Stop } catch {}`,
        ].join("\r\n");
        fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCRIPTS_DIR, "vale-update.ps1"), script);
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
        (0, child_process_1.spawnSync)("powershell", [
            "-NoProfile",
            "-Command",
            "if((Get-ExecutionPolicy) -eq 'Restricted'){ Set-ExecutionPolicy RemoteSigned -Scope LocalMachine -Force }",
        ], { stdio: "ignore", timeout: 30000 });
        const ps1 = path.join(SCRIPTS_DIR, "vale-update.ps1");
        // stage-n npm audit LOW: DIR can contain characters that break the
        // inner PS double-quote literal (backslash, quote). Escape for the
        // inner -File arg; the outer WMI literal is already escaped on L562.
        const ps1Safe = ps1.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const inner = `powershell -NoProfile -File "${ps1Safe}"`;
        const wmi = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${inner.replace(/'/g, "''")}'} | ConvertTo-Json -Compress`;
        const r = (0, child_process_1.spawnSync)("powershell", ["-NoProfile", "-Command", wmi], {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 20000,
        });
        // review #2 (HIGH): Win32_Process.Create reports success via
        // ReturnValue=0, but the old stdio:"inherit" printed the object and
        // checked only powershell's own exit code — a Create that returned 9
        // (path not found) / 21 still printed "swap launched" and the update
        // was a silent no-op (exactly incident #1's class). Parse the code.
        let retval = null;
        try {
            const j = JSON.parse((r.stdout || Buffer.from("")).toString().trim());
            retval = typeof j?.ReturnValue === "number" ? j.ReturnValue : null;
        }
        catch {
            /* fall through to the status/retval guard below */
        }
        if (r.status !== 0 || retval !== 0) {
            try {
                fs.unlinkSync(BUSYM);
            }
            catch {
                /* never created */
            }
            console.error(`update: WMI handoff failed (ps status ${r.status}, ReturnValue ${retval ?? "?"})` +
                (r.stderr ? " — " + r.stderr.toString().trim() : ""));
            process.exit(1);
        }
        // ASK THE DEVICE, DO NOT TRUST THE HANDOFF. `ReturnValue=0` means a process was
        // created; every decision that matters (the fail-closed migration gate, the 12x
        // copy retry, the task restart) happens after, in a WmiPrvSE-parented script whose
        // exit code nobody reads — so a swap that fails one second later looked identical
        // to one that worked. `rollback` already solves this by reading the release marker
        // back; `update` reported the HANDOFF instead and this is the only reason the two
        // commands disagreed about whether an update took.
        //
        // The read is a FILE, not the network, so the dropped connection does not matter.
        // A successful swap finishes in ~10s; the bound only elapses on failure, and it is
        // the same bound `rollback` uses.
        console.log("update: swap launched -- waiting for the device to confirm");
        const markerFile = path.join(ETC_DIR, ".vale-release");
        const check = await awaitReleaseMarker({
            want: toVersion,
            timeoutMs: 90_000,
            intervalMs: 2_000,
            read: () => fs.readFileSync(markerFile, "utf8"),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            now: () => Date.now(),
        });
        const verdict = releaseMarkerVerdict({ ...check, want: toVersion });
        if (verdict.writePin) {
            console.log(`update: ${fromVersion || "?"} -> ${toVersion} COMPLETE (the device reported the new release)`);
        }
        else {
            // Not a pin decision here — `update` never writes one — but the same verdict
            // logic answers "did it take", which is the question the operator asked.
            console.error(verdict.message);
            process.exit(1);
        }
    },
    // `vale rollback <x.y.z> | --clear` — pin the device to a CDN-retained
    // release and prevent the agent_update auto-upgrade from undoing it.
    // Mechanics (the swap itself reuses the installed package's `update`):
    //  1. HEAD-check the pinned tgz (CDN keeps last-5-per-minor — a pruned
    //     version fails HERE with a clear message, not as an npm 404 storm).
    //  2. npm install -g --prefix <components\npm-global> <tgz> — replaces
    //     the package whose bin/vale.js + exe the swap below uses.
    //  3. <npm-global>\vale.cmd update — runs the TARGET version's own swap
    //     (its staged exe IS the rollback build). Old (pre-v2) scripts write
    //     .vale-release to the install ROOT; steps 4/5 heal that: sync the
    //     marker into etc\ and delete the root leftover so agent_update can
    //     never read a split-brain version.
    //  4/5. write etc\.rollback-pin = <ver>, sync etc\.vale-release.
    // agent_update (Rust) refuses any non-matching version while the pin
    // exists; force:true (or a real Rust-side upgrade) clears it — same for
    // a later `vale rollback --clear`. A human `vale update` deliberately
    // does NOT clear the pin: the update flow swaps whatever npm-global
    // holds, so after rollback that IS the pinned version (no-op), and the
    // pin stays authoritative for the auto path.
    async rollback(args) {
        const NPM_GLOBAL = path.join(COMPONENTS_DIR, "npm-global");
        const PIN = path.join(ETC_DIR, ".rollback-pin");
        const val = String(args[0] || "");
        if (val === "--clear") {
            // A FAILED DELETE IS NOT AN ABSENT PIN. `rmSync(force)` ignores only ENOENT;
            // EPERM/EACCES/EBUSY/EISDIR landed in this same catch, so a pin that SURVIVED was
            // reported as "nothing to clear" and the command returned 0 — while
            // `rollback status` still said "pinned" and agent_update kept refusing every
            // release, which is the state that governs auto-updates.
            let cur = null;
            try {
                cur = fs.readFileSync(PIN, "utf8").trim();
            }
            catch (e) {
                if (e && e.code !== "ENOENT") {
                    console.error(`rollback: could not READ ${PIN} (${e.code || e.message}) -- not assuming it is absent`);
                    process.exitCode = 1;
                    return;
                }
            }
            try {
                fs.rmSync(PIN, { force: true });
            }
            catch (e) {
                // fall through to the read-back below, which is what decides.
            }
            if (fs.existsSync(PIN)) {
                console.error(`rollback: FAILED to clear ${PIN} -- the pin is still in place and agent_update keeps refusing releases`);
                process.exitCode = 1;
            }
            else if (cur !== null) {
                console.log(`rollback: pin cleared (was ${cur || "?"}) -- agent_update tracks the release channel again`);
            }
            else {
                console.log("rollback: no pin present (nothing to clear)");
            }
            return;
        }
        if (val === "status") {
            try {
                console.log("rollback: pinned to", fs.readFileSync(PIN, "utf8").trim());
            }
            catch (e) {
                // "not pinned" is a claim about ABSENCE; a read error is not evidence of it.
                if (e && e.code !== "ENOENT") {
                    console.error(`rollback: could not read ${PIN} (${e.code || e.message}) -- pin state UNKNOWN`);
                    process.exitCode = 1;
                }
                else {
                    console.log("rollback: not pinned (tracks the release channel)");
                }
            }
            return;
        }
        if (!rollbackVersionOk(val)) {
            console.error("usage: vale rollback <x.y.z> | status | --clear");
            process.exit(1);
        }
        const base = (process.env.VALE_CDN || "https://agent.saisi.online").replace(/\/+$/, "");
        const url = `${base}/vale-agent/vale-agent-${val}.tgz`;
        const head = (0, child_process_1.spawnSync)("curl", [
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "-m",
            "30",
            "--head",
            url,
        ], { encoding: "utf8", timeout: 40000 });
        const code = String(head.stdout || "").trim();
        if (head.status !== 0 || code !== "200") {
            console.error(`rollback: ${val} is not on the release CDN (HTTP ${code || "?"}) -- the last-5-per-minor prune removed it;` +
                " pick a retained version (see https://agent.saisi.online/vale-agent/version.json for the current line)");
            process.exit(1);
        }
        console.log(`rollback: installing vale-agent ${val} into ${NPM_GLOBAL} ...`);
        const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
        const inst = (0, child_process_1.spawnSync)(npmCmd, ["install", "-g", "--prefix", NPM_GLOBAL, url], { stdio: "inherit", timeout: 300000 });
        if (inst.status !== 0) {
            console.error("rollback: npm install failed -- device left untouched");
            process.exit(1);
        }
        const valeCmd = path.join(NPM_GLOBAL, "vale.cmd");
        if (!fs.existsSync(valeCmd)) {
            console.error("rollback: vale.cmd missing after install (broken package?) -- aborting before any swap");
            process.exit(1);
        }
        console.log(`rollback: swapping in ${val} (connection drops ~10s) ...`);
        const upd = (0, child_process_1.spawnSync)(valeCmd, ["update"], {
            stdio: "inherit",
            timeout: 120000,
        });
        if (upd.status !== 0) {
            console.error("rollback: swap failed -- pin NOT written, device still runs the previous release");
            process.exit(1);
        }
        // status 0 means the HANDOFF was accepted, not that the swap succeeded (the
        // script that decides that runs afterwards, parented by WmiPrvSE, with
        // nobody reading its exit code). So ASK THE DEVICE: read the marker back and
        // require it to show the version we just staged. Only then is the pin — and
        // the claim to every UI — earned.
        const markerFile = path.join(ETC_DIR, ".vale-release");
        const check = await awaitReleaseMarker({
            want: val,
            timeoutMs: 90_000,
            intervalMs: 2_000,
            read: () => fs.readFileSync(markerFile, "utf8"),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            now: () => Date.now(),
        });
        const verdict = releaseMarkerVerdict({ ...check, want: val });
        if (!verdict.writePin) {
            console.error(verdict.message);
            process.exit(verdict.exitCode);
        }
        try {
            fs.mkdirSync(ETC_DIR, { recursive: true });
            fs.writeFileSync(PIN, val);
            // Heal a pre-v2 swap's split-brain marker (old CLI wrote ROOT
            // .vale-release; the agent reads etc\). Root leftover is garbage.
            // NOTE: etc\.vale-release is NOT written here — the swap script wrote it
            // from a provable copy, and overwriting it would erase that proof.
            fs.rmSync(path.join(DIR, ".vale-release"), { force: true });
            console.log(verdict.message);
        }
        catch (e) {
            console.error("rollback: WARNING -- pin write failed (" +
                e.message +
                "); device runs " +
                val +
                " but agent_update is NOT blocked");
        }
    },
    // The ONLY uninstall path (NSIS installer is retired — npm CLI is the
    // single install/update channel). Stops the agent, removes the scheduled
    // tasks, deletes the program dir + registry keys. The DATA dir
    // (%ProgramData%\Vale) is KEPT by default (sessions/memory survive);
    // pass --purge-data to delete it too.
    uninstall(args) {
        const purge = args.includes("--purge-data");
        // DATA_DIR, not a local recomputation: the registry-first resolver is the single
        // source of truth (setup already uses it), and a second copy here meant a
        // registry-remapped install had the WRONG directory purged — and named in
        // "data kept at" — while the command reported success.
        const DATA = DATA_DIR;
        // HIGH npm audit: verify DIR is actually a Vale install dir before
        // recursively deleting — an attacker who controls VALE_AGENT_DIR (env
        // var) or the registry key could point it at D:\Windows or C:\.
        if (!fs.existsSync(path.join(DIR, "vale-agent.exe")) &&
            !fs.existsSync(path.join(ETC_DIR, "vale-agent.hostname")) &&
            !fs.existsSync(path.join(DIR, "vale-agent.hostname"))) {
            console.error("uninstall: REFUSE — " +
                DIR +
                " does not look like a Vale install dir (no vale-agent.exe/hostname). Set VALE_AGENT_DIR to the correct path.");
            process.exit(1);
        }
        console.log("uninstall: stopping ValeAgent...");
        sh("cmd /c schtasks /End /TN ValeAgent 2>NUL");
        sh("taskkill /F /IM vale-agent.exe 2>NUL");
        sh("taskkill /F /IM vale-desktop.exe 2>NUL");
        // npm audit #11: electron survived uninstall (dead SPA window); the
        // update-hardened ValeDesktop 5-min pulse kept firing against the deleted dir.
        sh("taskkill /F /IM electron.exe 2>NUL");
        sh("cmd /c schtasks /End /TN ValeDesktop 2>NUL");
        sh("cmd /c schtasks /Delete /TN ValeDesktop /F 2>NUL");
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
                sh(`powershell -NoProfile -Command "Remove-Item -LiteralPath '${(0, exports.psq)(legacy)}' -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath '${(0, exports.psq)(legacy)}' -Recurse -Force -ErrorAction SilentlyContinue"`);
                if (fs.existsSync(legacy)) {
                    console.log("uninstall: WARNING -- legacy dir still present:", legacy);
                }
            }
        }
        sh("reg delete HKLM\\SOFTWARE\\Vale\\Agent /f 2>NUL");
        // VERIFY, because `sh()` discards its result at every one of its call sites — so a
        // locked file, an AV hold or a denied HKLM write produced "removed" with the thing
        // still there, and exit 0. The legacy-dir loop just above is the pattern.
        const survivors = [];
        if (fs.existsSync(DIR))
            survivors.push(`install dir ${DIR}`);
        const regLeft = (0, child_process_1.spawnSync)("reg", ["query", "HKLM\\SOFTWARE\\Vale\\Agent"], {
            encoding: "utf8",
        });
        if (regLeft.status === 0)
            survivors.push("registry key HKLM\\SOFTWARE\\Vale\\Agent");
        if (survivors.length) {
            console.log("uninstall: WARNING -- still present after removal:", survivors.join(", "));
            console.log("uninstall: a locked file or a permission problem; re-run after stopping the agent.");
        }
        else {
            console.log("uninstall: program dir + registry removed");
        }
        if (purge) {
            sh(`rmdir /s /q "${DATA}"`);
            // A failed rmdir used to print "data dir purged" anyway.
            if (fs.existsSync(DATA)) {
                console.error(`uninstall: FAILED to purge the data dir -- ${DATA} is still present`);
                process.exitCode = 1;
            }
            else {
                console.log("uninstall: data dir purged");
            }
        }
        else {
            console.log("uninstall: data kept at", DATA, "(pass --purge-data to delete)");
        }
    },
    run(args) {
        // EXE_DST is always truthy, so the old `EXE_DST || EXE_SRC` was dead code and there
        // was no existence check: ENOENT yields `status: null`, and `?? 0` reported that as
        // a clean run. The banner printed either way.
        if (!fs.existsSync(EXE_DST)) {
            console.error(`vale run: agent binary not found at ${EXE_DST} -- run 'vale setup' first`);
            process.exit(1);
        }
        console.log("running vale-agent (foreground, Ctrl+C to stop)");
        const r = (0, child_process_1.spawnSync)(EXE_DST, args.length ? args : [], {
            stdio: "inherit",
        });
        if (r.error || r.status === null) {
            console.error(`vale run: could not start the agent (${r.error ? r.error.message : "no exit status"})`);
            process.exit(1);
        }
        process.exitCode = r.status;
    },
    // C2: cloudflared is a boxed, Vale-supervised component — operators never
    // touch the binary directly. This CLI is the only handle.
    async tunnel(args) {
        const sub = args[0] || "status";
        const cf = path.join(COMPONENTS_DIR, "cloudflared.exe");
        const cfg = path.join(ETC_DIR, "tunnel.yml");
        const has = fs.existsSync(cf) && fs.existsSync(cfg);
        switch (sub) {
            case "status": {
                if (!has) {
                    console.log("tunnel: not installed (cloudflared is OPTIONAL -- local mode needs no tunnel)");
                    console.log("  to enable public access: `vale tunnel install`");
                    return;
                }
                // No shell:true — see status(): an unquoted filter through cmd.exe is
                // split at its spaces, so this reported STOPPED while cloudflared ran.
                const out = (0, child_process_1.spawnSync)("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe"], {
                    encoding: "utf8",
                }).stdout || "";
                console.log(out.toLowerCase().includes("cloudflared")
                    ? "tunnel: RUNNING"
                    : "tunnel: STOPPED");
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
                if (!has) {
                    console.error("tunnel: not installed -- run setup with public-access enabled");
                    process.exit(1);
                }
                // npm audit #12: detached/unref are NO-OPS on spawnSync —
                // `vale tunnel start` blocked the CLI until the tunnel died.
                // intent to background the tunnel); kept for parity.
                // OBSERVE THE SPAWN. stdio was ignored, there was no 'error'/'exit' listener and
                // the CLI exited 0 immediately — so the success line printed for a cloudflared
                // that died on a bad config, a missing credentials file, a gone route, or an
                // already-running instance. Worse, when the SPAWN ITSELF failed there was no
                // 'error' listener either, so node printed the success line and THEN died with an
                // unhandled 'error' stack trace.
                let spawnErr = null;
                let exitedEarly = null;
                const ch = (0, child_process_1.spawn)(cf, ["tunnel", "--config", cfg, "run"], {
                    stdio: "ignore",
                    detached: true,
                });
                ch.on("error", (e) => {
                    spawnErr = e;
                });
                ch.on("exit", (code) => {
                    exitedEarly = code === null ? -1 : code;
                });
                ch.unref();
                // Give it long enough to fail visibly, then ASK the same question `tunnel
                // status` asks rather than assuming. `await` here is why this method is async.
                await new Promise((r) => setTimeout(r, 1500));
                if (spawnErr) {
                    console.error(`tunnel: FAILED to start cloudflared (${spawnErr.message})`);
                    process.exit(1);
                }
                if (exitedEarly !== null) {
                    console.error(`tunnel: cloudflared exited immediately (code ${exitedEarly}) -- check the config and credentials`);
                    process.exit(1);
                }
                const running = ((0, child_process_1.spawnSync)("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe"], {
                    encoding: "utf8",
                }).stdout || "")
                    .toLowerCase()
                    .includes("cloudflared");
                if (!running) {
                    console.error("tunnel: cloudflared did not come up -- see the tunnel log; the agent still auto-spawns it on boot");
                    process.exit(1);
                }
                console.log("tunnel: started in background (agent also auto-spawns it on boot)");
                return;
            }
            case "stop": {
                const r = (0, child_process_1.spawnSync)("taskkill", ["/F", "/IM", "cloudflared.exe"], {
                    stdio: "inherit",
                });
                if (r.status !== 0)
                    console.log("tunnel: nothing to stop");
                return;
            }
            case "update": {
                console.log("tunnel: version is locked by the Vale release flow -- update via the installer/npm package.");
                return;
            }
            default:
                console.log("usage: vale tunnel <status|install|start|stop|update>");
                process.exit(1);
        }
    },
};
// require.main guard: test/cli.test.mjs imports the pure helpers above
// WITHOUT tripping the usage print + process.exit at module load.
if (require.main === module) {
    const [cmd, ...rest] = process.argv.slice(2);
    if (!cmd || !commands[cmd]) {
        console.log("vale <setup|status|start|stop|restart|autostart|update|rollback|uninstall|run|tunnel> -- Vale Agent control");
        Object.keys(commands).forEach((k) => console.log(" ", k));
        process.exit(cmd ? 1 : 0);
    }
    // `rollback` is the only ASYNC command (it awaits the marker read-back), so
    // the dispatcher must catch a rejected promise: an unhandled rejection is a
    // raw stack trace with a non-obvious exit code, and this command runs on a
    // device where the operator sees only the console.
    Promise.resolve(commands[cmd](rest)).catch((e) => {
        console.error(`vale ${cmd}: ${e && e.message ? e.message : e}`);
        process.exit(1);
    });
}
