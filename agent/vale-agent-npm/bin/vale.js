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
exports.psq = void 0;
exports.busyIsFresh = busyIsFresh;
/**
 * vale CLI — DSH-style management for the Vale Agent.
 *
 * The agent is a headless auto-start service; management lives here (CLI)
 * and in the web panel (http://127.0.0.1:18080/panel/, desktop shortcut
 * created by setup). The native tray was retired 2026-08-22.
 */
const child_process_1 = require("child_process");
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
    catch { /* fall through */ }
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
    const res = (0, child_process_1.spawnSync)("curl", ["-sS", "-m", "30", "-X", "POST",
        "-H", "content-type: application/json",
        "-d", JSON.stringify(body),
        API_BASE + pathname], { encoding: "utf8" });
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
function ps(script) {
    // npm audit #7: results were discarded — a failed Register-ScheduledTask
    // printed SUCCESS anyway. Return the spawn result.
    return sh(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`);
}
// npm audit #6: setup interpolated RAW paths into PS single-quote literals;
// an apostrophe in a path (O'Brien) unbalanced the literal and the script
// PARSE-failed invisibly. Shared doubling helper.
// exported: unit-tested in test/cli.test.mjs (SYSTEM-context PS quoting = injection surface)
const psq = (x) => String(x).replace(/'/g, "''");
exports.psq = psq;
// exported: the update mutual-exclusion window (npm audit #10 seam), unit-tested.
function busyIsFresh(mtimeMs, nowMs) {
    return nowMs - mtimeMs < 10 * 60 * 1000;
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
            if (r && r.apiToken) {
                token = r.apiToken;
                console.log("tunnel: key exchanged (consumed once)");
            }
            else
                console.log("tunnel: tunnel-token exchange failed (" + (r && r.error ? r.error : "no token") + ") — falling back");
        }
        catch (e) {
            console.log("tunnel: exchange unavailable (" + e.message + ") — falling back");
        }
    }
    const r1 = (0, child_process_1.spawnSync)(cf, token ? ["tunnel", "login", "--token", token] : ["tunnel", "login"], { stdio: "inherit" });
    if (r1.status !== 0) {
        console.error("tunnel: cloudflare login failed");
        process.exit(1);
    }
    const name = "vale-agent-" + host.split(".")[0];
    (0, child_process_1.spawnSync)(cf, ["tunnel", "create", name], { stdio: "inherit" });
    const list = (0, child_process_1.spawnSync)(cf, ["tunnel", "list", "--name", name], { encoding: "utf8" }).stdout || "";
    const m = /([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})/.exec(list);
    const tunnelId = m ? m[1] : null;
    if (!tunnelId) {
        console.error("tunnel: could not determine tunnel id");
        process.exit(1);
    }
    const r3 = (0, child_process_1.spawnSync)(cf, ["tunnel", "route", "dns", name, host], { stdio: "inherit" });
    if (r3.status !== 0) {
        console.error("tunnel: dns route failed");
        process.exit(1);
    }
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
        // review #1 (HIGH): the hostname write ran BEFORE the mkdirSync below —
        // on a FRESH machine DIR doesn't exist yet → ENOENT throw → setup died
        // having installed nothing. Ensure the dir first.
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(path.join(DIR, "vale-agent.hostname"), deviceHost);
        // No key required for a local install — key/tunnel are optional extras.
        if (regKey) {
            console.log("setup: registering device with the gateway (--reg-key)");
        }
        else {
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
        sh(`powershell -NoProfile -Command "Remove-Item -Force -ErrorAction SilentlyContinue '${(0, exports.psq)(BUSY)}'"`);
        // 5. Refresh the BOXED playwright bundle: delete the old tree first so a
        //    removed package/version never leaves stale files behind.
        //    round-163: kill the runner/bridge node processes FIRST — a running
        //    node.exe holds its image file locked, the Remove-Item/Expand-Archive
        //    pair silently skipped it, and the device was left with a playwright
        //    dir WITHOUT node.exe (bridge could never spawn again; observed d1).
        sh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${(0, exports.psq)(DIR)}*playwright*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`);
        sh(`powershell -NoProfile -Command "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${(0, exports.psq)(DIR)}\\playwright'"`);
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
        // C1: write the registry single source of truth (InstallDir; DataDir
        // defaults to %ProgramData%\Vale). Everything else reads it back.
        try {
            (0, child_process_1.spawnSync)("reg", ["add", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "InstallDir", "/t", "REG_SZ", "/d", DIR, "/f"], { stdio: "ignore" });
            (0, child_process_1.spawnSync)("reg", ["add", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "DataDir", "/t", "REG_SZ", "/d", path.join(process.env.ProgramData || "C:\\ProgramData", "Vale"), "/f"], { stdio: "ignore" });
        }
        catch { /* non-fatal — runtime falls back to exe dir */ }
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
            sh(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${(0, exports.psq)(PW_ZIP)}' -DestinationPath '${(0, exports.psq)(DIR)}'"`);
            // round-163: the whole point of the bundle is node.exe — VERIFY it
            // landed (a silently-missing copy killed the bridge forever on d1).
            // One retry, then fail loudly: a half-staged bundle is worse than none.
            if (!fs.existsSync(path.join(pwDir, "node.exe"))) {
                console.log("setup: node.exe missing after expand — retrying once");
                sh(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${(0, exports.psq)(PW_ZIP)}' -DestinationPath '${(0, exports.psq)(DIR)}'"`);
            }
            if (fs.existsSync(path.join(pwDir, "node.exe"))) {
                console.log("setup: playwright bundle staged (node.exe + node_modules verified)");
            }
            else {
                console.error("setup: FATAL — playwright bundle expanded but node.exe is STILL missing; browser tools cannot run. Check AV/lock interference and re-run vale setup.");
                process.exit(1);
            }
        }
        else {
            console.log("setup: vale-playwright.zip not in package (browser tools disabled)");
        }
        // Node runtime: the device has node (npm works), but the agent runs as
        // SYSTEM which may not see the user PATH — resolve the ABSOLUTE node path
        // now and record it in the registry so the agent can spawn it.
        const nodeWhich = (0, child_process_1.spawnSync)("where", ["node"], { encoding: "utf8" });
        const nodePath = (nodeWhich.status === 0 && nodeWhich.stdout) ? nodeWhich.stdout.split(/\r?\n/)[0].trim() : "";
        if (nodePath) {
            try {
                (0, child_process_1.spawnSync)("reg", ["add", "HKLM\\SOFTWARE\\Vale\\Agent", "/v", "NodePath", "/t", "REG_SZ", "/d", nodePath, "/f"], { stdio: "ignore" });
                console.log("setup: system node detected:", nodePath);
            }
            catch { /* non-fatal */ }
        }
        else {
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
        // round-330: Tauri vale-desktop staging removed (retired).
        // stage-l: stage the Electron shell sources (main/preload) so the desktop
        // app picks up menu/command features on a fresh install too.
        const DESK_SRC = path.join(__dirname, "..", "vale-desktop-electron", "src");
        if (fs.existsSync(DESK_SRC)) {
            const desDst = path.join(DIR, "vale-desktop-electron", "src");
            fs.mkdirSync(desDst, { recursive: true });
            for (const f of ["main.js", "preload.js", "url-policy.js"]) {
                const s = path.join(DESK_SRC, f);
                if (fs.existsSync(s))
                    fs.copyFileSync(s, path.join(desDst, f));
            }
            // icon.png goes next to src/ (Electron loads from ../icon.png)
            const iconSrc = path.join(__dirname, "..", "vale-desktop-electron", "icon.png");
            if (fs.existsSync(iconSrc))
                fs.copyFileSync(iconSrc, path.join(DIR, "vale-desktop-electron", "icon.png"));
            console.log("setup: vale-desktop-electron sources staged");
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
            `$action = New-ScheduledTaskAction -Execute '${(0, exports.psq)(EXE_DST)}' -Argument ('"' + '${(0, exports.psq)(EXE_DST)}' + '"')`,
            "$boot = New-ScheduledTaskTrigger -AtStartup",
            "$watch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 5)",
            "$principal = New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest",
            "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 8 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable",
            "Register-ScheduledTask ValeAgent -Action $action -Trigger @($boot,$watch) -Principal $principal -Settings $settings -Force | Out-Null",
            "Start-ScheduledTask ValeAgent",
        ].join("; ");
        const regRes = ps(reg);
        if (!regRes || regRes.status !== 0) {
            console.error("setup: FATAL — task registration failed (audit #7: used to claim success regardless).");
            process.exit(1);
        }
        console.log("setup: installed to", DIR);
        console.log("setup: device registers on start — check the console Devices list");
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
        const out = (0, child_process_1.spawnSync)("tasklist", ["/FI", "IMAGENAME eq vale-agent*"], {
            shell: true,
            encoding: "utf8",
        }).stdout || "";
        console.log(out.includes("vale-agent") ? "status: RUNNING" : "status: STOPPED");
        console.log("install dir:", DIR);
        console.log("panel:", fs.existsSync(EXE_DST) ? "http://127.0.0.1:18080/panel/" : "(not installed)");
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
        // npm audit #10: no mutual exclusion — two updates (or setup racing a
        // swap) interleave Copy-Item on *.new, leaving a half-written exe "ok".
        // setup REMOVES the marker; update now CREATES it (refuse if <10 min
        // old); the swap script clears it after restart.
        // MEDIUM npm audit: use 'wx' exclusive-create so two racing updaters
        // cannot BOTH pass the freshness check — the second openSync throws
        // EEXIST and the WMI swap is never launched concurrently.
        const BUSYM = path.join(process.env.ProgramData || "C:\\ProgramData", "ValeAgent", "update-busy");
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
                        console.error("update: another update looks in progress (" + BUSYM + " <10 min old) — wait, or delete the marker after a mid-swap reboot");
                        process.exit(1);
                    }
                    // Stale marker — overwrite it.
                    fs.writeFileSync(BUSYM, String(Date.now()));
                }
                catch {
                    console.error("update: another update looks in progress (cannot stat " + BUSYM + ")");
                    process.exit(1);
                }
            }
            else {
                throw e; // a real FS error — do not proceed
            }
        }
        // Swap the exe in-place: stop -> replace (with retry; the running agent
        // locks its own file) -> start.
        if (!fs.existsSync(EXE_SRC)) {
            console.error("exe missing from package:", EXE_SRC);
            process.exit(1);
        }
        fs.mkdirSync(DIR, { recursive: true });
        fs.copyFileSync(EXE_SRC, path.join(DIR, "vale-agent.new.exe"));
        // stage-l: ship the Electron desktop shell's main/preload alongside —
        // the desktop app (D:\Vale\vale-desktop-electron) loads these sources;
        // without the sync, new menu/command features never reach the device.
        const DESK_SRC = path.join(__dirname, "..", "vale-desktop-electron", "src");
        if (fs.existsSync(DESK_SRC)) {
            const desDst = path.join(DIR, "vale-desktop-electron", "src");
            fs.mkdirSync(desDst, { recursive: true });
            for (const f of ["main.js", "preload.js", "url-policy.js"]) {
                const s = path.join(DESK_SRC, f);
                if (fs.existsSync(s))
                    fs.copyFileSync(s, path.join(desDst, f + ".new"));
            }
            // icon.png goes next to src/ (Electron loads from ../icon.png)
            const iconSrc = path.join(__dirname, "..", "vale-desktop-electron", "icon.png");
            if (fs.existsSync(iconSrc))
                fs.copyFileSync(iconSrc, path.join(DIR, "vale-desktop-electron", "icon.png"));
        }
        const q = DIR.replace(/'/g, "''");
        const log = `Out-File '${q}\\vale-update.log' -Append`;
        // round-143: write the run-hidden.vbs wrapper next to node.exe, so the
        // ValePlaywright scheduled task can launch node.exe without flashing a
        // visible cmd window. Idempotent — overwrites any existing copy.
        const pwDir = path.join(DIR, "playwright");
        const vbsPath = path.join(pwDir, "run-hidden.vbs");
        // round-246 (browser-display audit C3) + round-257 + round-263:
        // ONE-BROWSER — the AI must drive the SAME browser the user watches:
        // the Electron desktop embedded WebContentsView (CDP 9333). The
        // ValePlaywright task used to launch playwright-mcp with --headless (a
        // PRIVATE chromium nobody sees). The task now goes through a probe
        // launcher that attaches to the DESKTOP view (9333) and falls back to a
        // private headless only when the desktop is down (agent restart window).
        // The bridge chromium (9223) tier was removed in round-263.
        const probePath = path.join(pwDir, "playwright-probe.ps1");
        if (fs.existsSync(pwDir)) {
            // round-143: ASCII-only VBS (no em-dash, no Unicode). VBScript on
            // Windows uses the system locale; non-ASCII in comments corrupts the
            // file and causes "unterminated string constant" (800A0409). Use chr(34)
            // to produce literal double-quotes without string-escaping issues.
            fs.writeFileSync(vbsPath, [
                "Dim sh,cmd,i",
                "Set sh=CreateObject(\"WScript.Shell\")",
                "cmd=chr(34) & WScript.Arguments(0) & chr(34) & \" \" & chr(34) & WScript.Arguments(1) & chr(34)",
                "For i=2 To WScript.Arguments.Count-1",
                "  cmd=cmd & \" \" & WScript.Arguments(i)",
                "Next",
                "sh.Run cmd,0,False",
            ].join("\r\n"));
            // round-246 (C3) + round-257 + round-263: the probe launcher.
            // ASCII-only, plain -NoProfile -File (the repo rule: -ExecutionPolicy
            // Bypass / -EncodedCommand die silently under WMI/session-0 launches).
            // Args: $node $cli. Probe order matches the agent's
            // preferred_cdp_endpoint(): 9333 (Electron DESKTOP embedded view —
            // what the user watches) when up, else private --headless (the
            // bridge/9223 tier was removed in round-263). --output-dir pins MCP
            // screenshots where the Evidence drawer lists them (install\pwout).
            fs.writeFileSync(probePath, [
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
                "if (Test-Port 9333) { $ep = 'http://127.0.0.1:9333' }",
                "if ($ep) {",
                "  & $node $cli --port 9229 --host 127.0.0.1 --cdp-endpoint $ep --output-dir $pwout --ignore-https-errors --allowed-hosts '127.0.0.1:9229,localhost:9229'",
                "} else {",
                "  & $node $cli --port 9229 --browser chromium --host 127.0.0.1 --headless --output-dir $pwout --ignore-https-errors --allowed-hosts '127.0.0.1:9229,localhost:9229'",
                "}",
            ].join("\r\n"));
        }
        // round-298: record the release version on a PROVABLY successful swap
        // so agent_update (which reads <install>/.vale-release as its local
        // version) reports up_to_date instead of re-swapping every call.
        let relVer = "";
        try {
            relVer = String(require("../package.json").version || "");
        }
        catch { /* best-effort */ }
        const script = [
            `"[$(Get-Date -Format o)] update start" | ${log}`,
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
            `if ($ok -and '${relVer}') { Set-Content -Path '${q}\\.vale-release' -Value '${relVer}' -NoNewline -ErrorAction SilentlyContinue }`,
            `Remove-Item -Force -ErrorAction SilentlyContinue '${q}\\vale-agent.new.exe'`,
            // stage-l: swap the desktop shell sources (main/preload) with retry —
            // the running Electron may hold them briefly.
            `foreach($df in @('main.js','preload.js','url-policy.js')){ $ds='${q}\\vale-desktop-electron\\src\\'+$df+'.new'; if (Test-Path $ds) { $ok2=$false; foreach($i in 1..8){ try { Copy-Item -Force -ErrorAction Stop $ds ('${q}\\vale-desktop-electron\\src\\'+$df); $ok2=$true; break } catch { Start-Sleep -Milliseconds 500 } }; Remove-Item -Force -ErrorAction SilentlyContinue $ds; "[$(Get-Date -Format o)] desk $df ok=$ok2" | ${log} } }`,
            // NEVER leave the device dark: even a failed swap must bring the task
            // back up (it will run the old exe until the next update).
            `try { Start-ScheduledTask ValeAgent -ErrorAction Stop } catch { schtasks /Run /TN ValeAgent }`,
            `"[$(Get-Date -Format o)] task restarted" | ${log}`,
            `try { Remove-Item -Force (Join-Path $env:ProgramData 'ValeAgent\\update-busy') } catch {}`,
            // stage-n: restart the Electron shell so newly-synced main/preload
            // sources take effect. The shell is INDEPENDENT of the ValeAgent task —
            // it only probes 127.0.0.1:18080 and loads /desktop/. Kill + relaunch
            // via start-desktop.ps1 (the same path ValeDesktop onlogon uses); if
            // the task/script is missing (non-desktop install), skip silently.
            `$deskDir = '${q}\\vale-desktop-electron'`,
            `$deskStart = '${q}\\start-desktop.ps1'`,
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
            `$en1 = '${q}\\ensure-desktop.ps1'`,
            `$vb1 = '${q}\\desktop-pulse.vbs'`,
            `Set-Content -Path $en1 -Value 'if (Get-Process electron -ErrorAction SilentlyContinue) { exit }; & powershell -NoProfile -ExecutionPolicy Bypass -File "${q}\\start-desktop.ps1"' -Force`,
            `Set-Content -Path $vb1 -Value 'CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & "${q}\\ensure-desktop.ps1" & Chr(34), 0, False' -Force`,
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
            // round-143: re-register ValePlaywright via the wscript/VBS wrapper so
            // node.exe no longer allocates a visible console. Idempotent — task may
            // not exist (older install paths), so wrap in try/catch.
            `$pwVbs = '${q}\\playwright\\run-hidden.vbs'`,
            `$pwProbe = '${q}\\playwright\\playwright-probe.ps1'`,
            `if ((Test-Path $pwVbs) -and (Test-Path $pwProbe)) {`,
            `  $pwNode = '${q}\\playwright\\node.exe'`,
            `  $pwCli  = '${q}\\playwright\\node_modules\\@playwright\\mcp\\cli.js'`,
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
        (0, child_process_1.spawnSync)("powershell", [
            "-NoProfile",
            "-Command",
            "if((Get-ExecutionPolicy) -eq 'Restricted'){ Set-ExecutionPolicy RemoteSigned -Scope LocalMachine -Force }",
        ], { stdio: "ignore", timeout: 30000 });
        const ps1 = path.join(DIR, "vale-update.ps1");
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
        catch { /* fall through to the status/retval guard below */ }
        if (r.status !== 0 || retval !== 0) {
            try {
                fs.unlinkSync(BUSYM);
            }
            catch { /* never created */ }
            console.error(`update: WMI handoff failed (ps status ${r.status}, ReturnValue ${retval ?? "?"})`
                + (r.stderr ? " — " + r.stderr.toString().trim() : ""));
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
        // HIGH npm audit: verify DIR is actually a Vale install dir before
        // recursively deleting — an attacker who controls VALE_AGENT_DIR (env
        // var) or the registry key could point it at D:\Windows or C:\.
        if (!fs.existsSync(path.join(DIR, "vale-agent.exe")) &&
            !fs.existsSync(path.join(DIR, "vale-agent.hostname"))) {
            console.error("uninstall: REFUSE — " + DIR + " does not look like a Vale install dir (no vale-agent.exe/hostname). Set VALE_AGENT_DIR to the correct path.");
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
                    console.log("uninstall: WARNING — legacy dir still present:", legacy);
                }
            }
        }
        sh("reg delete HKLM\\SOFTWARE\\Vale\\Agent /f 2>NUL");
        console.log("uninstall: program dir + registry removed");
        if (purge) {
            sh(`rmdir /s /q "${DATA}"`);
            console.log("uninstall: data dir purged");
        }
        else {
            console.log("uninstall: data kept at", DATA, "(pass --purge-data to delete)");
        }
    },
    run(args) {
        console.log("running vale-agent (foreground, Ctrl+C to stop)");
        const r = (0, child_process_1.spawnSync)(EXE_DST || EXE_SRC, args.length ? args : [], {
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
                const out = (0, child_process_1.spawnSync)("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe"], { shell: true, encoding: "utf8" }).stdout || "";
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
                if (!has) {
                    console.error("tunnel: not installed — run setup with public-access enabled");
                    process.exit(1);
                }
                // npm audit #12: detached/unref are NO-OPS on spawnSync —
                // `vale tunnel start` blocked the CLI until the tunnel died.
                // intent to background the tunnel); kept for parity.
                const ch = (0, child_process_1.spawn)(cf, ["tunnel", "--config", cfg, "run"], { stdio: "ignore", detached: true });
                ch.unref();
                console.log("tunnel: started in background (agent also auto-spawns it on boot)");
                return;
            }
            case "stop": {
                const r = (0, child_process_1.spawnSync)("taskkill", ["/F", "/IM", "cloudflared.exe"], { stdio: "inherit" });
                if (r.status !== 0)
                    console.log("tunnel: nothing to stop");
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
// require.main guard: test/cli.test.mjs imports the pure helpers above
// WITHOUT tripping the usage print + process.exit at module load.
if (require.main === module) {
    const [cmd, ...rest] = process.argv.slice(2);
    if (!cmd || !commands[cmd]) {
        console.log("vale <setup|status|start|stop|restart|update|uninstall|run|tunnel> — Vale Agent control");
        Object.keys(commands).forEach((k) => console.log(" ", k));
        process.exit(cmd ? 1 : 0);
    }
    commands[cmd](rest);
}
