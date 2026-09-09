// npm CLI first tests (coverage audit rows 13+14). The CLI is the SOLE
// install/update channel and runs PowerShell under SYSTEM/admin — its
// quoting and update-mutual-exclusion previously had zero coverage.
// bin/vale.js exports the pure helpers (dispatch is require.main-guarded).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { psq, busyIsFresh, deskShortcutRepairPs, playwrightProbePs, parseAgentPort, agentPort, firewallPs, uninstallVersionPs, BOOT_TASKS, autostartArgv, bootTaskPs, migrateLayoutPs, startDesktopPs, rollbackVersionOk } = require("../bin/vale.js");

test("psq: PowerShell single-quote doubling (injection surface for SYSTEM task scripts)", () => {
  assert.equal(psq("C:\\Program Files\\Vale\\a'b"), "C:\\Program Files\\Vale\\a''b");
  assert.equal(psq("/plain/path"), "/plain/path");
  assert.equal(psq(""), "");
  assert.equal(psq("'"), "''");
  assert.equal(psq("a'b'c"), "a''b''c");
});

test("busyIsFresh: the 10-minute update-exclusion window", () => {
  const now = 1_700_000_000_000;
  const MIN = 60_000;
  assert.equal(busyIsFresh(now - 9 * MIN, now), true, "9 min old = in-progress, refuse");
  assert.equal(busyIsFresh(now - 11 * MIN, now), false, "11 min old = stale marker after reboot, proceed");
  assert.equal(busyIsFresh(now, now), true, "brand-new = fresh");
  assert.equal(busyIsFresh(now - 10 * MIN - 1, now), false, "just past the window");
});

test("deskShortcutRepairPs: stale-shortcut repair is repair-only + sunrise-pinned", () => {
  const lines = deskShortcutRepairPs("D:\\Vale\\scripts", "D:\\Vale\\components\\vale-desktop-electron", "Write-Host");
  const body = lines.join("\n");
  assert.match(body, /Vale\.lnk/, "touches the desktop Vale link");
  assert.match(body, /vale-desktop\.exe/, "detects the retired Tauri target");
  assert.match(body, /vale-tray\.exe/, "detects the retired tray target");
  assert.match(body, /icon\.ico/, "pins IconLocation to the sunrise ico");
  assert.match(body, /start-desktop\.ps1/, "repoints at the Electron onlogon path");
  assert.match(body, /Write-Host/, "uses the caller sink for logging");
  assert.ok(!body.includes("Remove-Item -Recurse"), "never deletes directories, files only");
});

test("playwrightProbePs: waits for desktop CDP before forking headless", () => {
  const body = playwrightProbePs().join("\n");
  assert.match(body, /Test-Port 9333/, "probes the desktop CDP port");
  assert.match(body, /for \(\$i = 1/, "retries instead of a single check (boot race)");
  assert.match(body, /Start-Sleep -Seconds 5/, "backs off between probes");
  assert.match(body, /--cdp-endpoint \$ep/, "attaches to the watched view when up");
  assert.match(body, /--headless/, "keeps the private-chromium fallback");
  assert.match(body, /127\.0\.0\.1:9229,localhost:9229/, "keeps the anti-DNS-rebinding hosts");
  assert.match(body, /--output-dir \$pwout/, "pins screenshots to the evidence dir");
  assert.ok(![...body].some((c) => c.charCodeAt(0) > 127), "ASCII-only (system-locale PS)");
});

test("parseAgentPort: server.port only, strict", () => {
  const { parseAgentPort } = require("../bin/vale.js");
  assert.equal(parseAgentPort('server:\n  host: "0.0.0.0"\n  port: 7740\n'), 7740);
  assert.equal(parseAgentPort('server:\n  port: 18080\n'), 18080);
  assert.equal(parseAgentPort('server:\n  host: "127.0.0.1"\n'), null, "absent port");
  assert.equal(parseAgentPort('serial:\n  port: 1234\n'), null, "non-server section ignored");
  assert.equal(parseAgentPort('server:\n  port: 0\n'), null, "ephemeral rejected");
  assert.equal(parseAgentPort('server:\n  port: 99999\n'), null, "out of range rejected");
  assert.equal(parseAgentPort(""), null);
});

test("agentPort: reads dir config, defaults 18080", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { agentPort } = require("../bin/vale.js");
  assert.equal(agentPort("/definitely/not/here"), 18080, "missing config");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vale-port-"));
  fs.writeFileSync(path.join(d, "config.yaml"), 'server:\n  port: 7740\n');
  assert.equal(agentPort(d), 7740);
  fs.rmSync(d, { recursive: true, force: true });
});

test("firewallPs: idempotent Vale-scoped rule for the port", () => {
  const { firewallPs } = require("../bin/vale.js");
  const body = firewallPs(7740).join("\n");
  assert.match(body, /LocalPort \$fwPort/, "uses the variable, hardcodes nothing else");
  assert.match(body, /\$fwPort = 7740/, "bakes the configured port");
  assert.match(body, /New-NetFirewallRule/, "creates the allow rule");
  assert.match(body, /Remove-NetFirewallRule/, "prunes stale own rules");
  assert.match(body, /'Vale Agent'/, "DisplayName-scoped, never foreign rules");
  assert.ok(![...body].some((c) => c.charCodeAt(0) > 127), "ASCII-only (system-locale PS)");
});

test("startDesktopPs: the electron launcher matches the migrated layout", () => {
  const { startDesktopPs } = require("../bin/vale.js");
  const body = startDesktopPs("D:\\Vale\\components\\vale-desktop-electron").join("\n");
  assert.match(body, /\$dir = 'D:\\Vale\\components\\vale-desktop-electron'/, "pins the components dir");
  assert.match(body, /Set-Location \$dir/, "cwd matters (electron resolves package.json main)");
  assert.match(body, /node_modules\\electron\\dist\\electron\.exe/, "launches the boxed electron");
  // second-instance (ValeDesktop pulse every 5 min) must NOT open a window —
  // the app's single-instance lock focuses the existing one. No -new flag here.
  assert.ok(!/Start-Process/i.test(body), "plain invocation (focus steal is the app's job)");
  assert.ok(![...body].some((c) => c.charCodeAt(0) > 127), "ASCII-only (system-locale PS)");
});

test("writeReleaseMarker: fresh-install parity with the round-298 update marker", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { writeReleaseMarker } = require("../bin/vale.js");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vale-relmark-"));
  try {
    // Writes the package.json version under etc/ (layout v2). Callers
    // (setup/update) always create etc/ during staging/migration first.
    fs.mkdirSync(path.join(d, "etc"), { recursive: true });
    writeReleaseMarker(d);
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(fs.readFileSync(path.join(d, "etc", ".vale-release"), "utf8"), pkg.version);
    // Idempotent (re-run overwrites with the same value).
    writeReleaseMarker(d);
    assert.equal(fs.readFileSync(path.join(d, "etc", ".vale-release"), "utf8"), pkg.version);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("writeReleaseMarker: missing dir stays silent (best-effort, never throws)", () => {
  const { writeReleaseMarker } = require("../bin/vale.js");
  assert.doesNotThrow(() => writeReleaseMarker("Z:\\definitely\\not\\here"));
});

test("uninstallVersionPs: $ok-gated DisplayVersion parity, never fabricates UninstallString", () => {
  const { uninstallVersionPs } = require("../bin/vale.js");
  const body = uninstallVersionPs("C:\\Program Files\\Vale", "1.2.307").join("\n");
  assert.match(body, /\$ok -and '1\.2\.307'/, "gated on provable swap success like .vale-release");
  assert.match(body, /DisplayVersion/, "moves the Add/Remove version");
  assert.match(body, /DisplayName/, "moves the display name with it");
  assert.match(body, /InstallLocation/, "records where the release lives");
  assert.ok(!body.includes("UninstallString"), "never fabricates UninstallString (NSIS owns it)");
  assert.match(body, /catch \{\}/, "best-effort: registry failure never fails the update");
  assert.match(body, /Test-Path \$rk/, "creates the key for npm-only installs that lack one");
  assert.ok(![...body].some((c) => c.charCodeAt(0) > 127), "ASCII-only (system-locale PS)");
});

test("autostartArgv: ENABLE/DISABLE both boot tasks, no credential-prompt flags", () => {
  const { autostartArgv, BOOT_TASKS } = require("../bin/vale.js");
  assert.deepEqual([...BOOT_TASKS].sort(), ["ValeAgent", "ValeDesktop"], "both boot tasks covered");
  for (const t of BOOT_TASKS) {
    assert.deepEqual(autostartArgv(t, "off"), ["schtasks", "/Change", "/TN", t, "/DISABLE"]);
    assert.deepEqual(autostartArgv(t, "on"), ["schtasks", "/Change", "/TN", t, "/ENABLE"]);
  }
  const all = BOOT_TASKS.flatMap((t) => [autostartArgv(t, "on").join(" "), autostartArgv(t, "off").join(" ")]).join("\n");
  for (const banned of ["/RU", "/RP", "/RI", "/TR"]) {
    assert.ok(!all.includes(banned), `${banned} must never appear (it prompts for the account password and hangs)`);
  }
});

test("bootTaskPs: explicit config argument, hardened SYSTEM task, optional kick", () => {
  const { bootTaskPs } = require("../bin/vale.js");
  const reg = bootTaskPs("C:\\V\\vale-agent.exe", "C:\\V\\etc\\config.yaml", false).join("\n");
  assert.match(reg, /-Argument \('"'\s*\+\s*'C:\\V\\etc\\config\.yaml'\s*\+\s*'"'\)/, "-Argument is the config path");
  assert.ok(!reg.includes("vale-agent.exe' + '\"'"), "the exe path must never be the argument");
  assert.match(reg, /-UserId SYSTEM/, "SYSTEM principal");
  assert.match(reg, /ExecutionTimeLimit.*0/, "never kill the running task");
  assert.match(reg, /Register-ScheduledTask ValeAgent/, "re-registers with -Force semantics");
  assert.ok(!reg.includes("Start-ScheduledTask"), "no kick without start=true");
  const kick = bootTaskPs("C:\\V\\vale-agent.exe", "C:\\V\\etc\\config.yaml", true).join("\n");
  assert.match(kick, /Start-ScheduledTask ValeAgent/, "setup kicks the task once");
  for (const banned of ["/RU", "/RP", "/RI", "/TR"]) {
    assert.ok(!reg.includes(` ${banned}`), `${banned} must never appear (password prompt hangs headless setup)`);
  }
  assert.ok(![...reg].some((c) => c.charCodeAt(0) > 127), "ASCII-only (system-locale PS)");
});

test("migrateLayoutPs: mirrors paths.rs pairs, never clobbers, kills boxed node first, marker-gated", () => {
  const { migrateLayoutPs } = require("../bin/vale.js");
  const body = migrateLayoutPs("D:\\Vale", "C:\\ProgramData\\Vale").join("\n");
  for (const pair of [
    ["D:\\Vale\\config.yaml", "D:\\Vale\\etc\\config.yaml"],
    ["D:\\Vale\\vale-agent.hostname", "D:\\Vale\\etc\\vale-agent.hostname"],
    ["D:\\Vale\\.vale-release", "D:\\Vale\\etc\\.vale-release"],
    ["D:\\Vale\\tools\\node", "D:\\Vale\\components\\node"],
    ["D:\\Vale\\playwright", "D:\\Vale\\components\\playwright"],
    ["D:\\Vale\\vale-desktop-electron", "D:\\Vale\\components\\vale-desktop-electron"],
    ["D:\\Vale\\start-desktop.ps1", "D:\\Vale\\scripts\\start-desktop.ps1"],
    ["D:\\Vale\\installer.log", "C:\\ProgramData\\Vale\\logs\\installer.log"],
    ["D:\\Vale\\pwout", "C:\\ProgramData\\Vale\\pwout"],
  ]) {
    assert.ok(body.includes(pair[0]) && body.includes(pair[1]), `migration covers ${pair[0]} -> ${pair[1]}`);
  }
  assert.match(body, /-not \(Test-Path/, "every move is guarded (never clobbers staged output)");
  assert.match(body, /CommandLine -like '\*.*playwright\*/, "boxed node processes are stopped before the tree moves");
  // Marker aging (ADR 0008): whole block skips when done-marker present,
  // and the marker is written only when NO old->new pair is still pending.
  assert.ok(body.includes("$valeMg = (-not (Test-Path 'D:\\Vale\\etc\\.layout-v2'))"), "marker short-circuits re-runs (single-line guard)");
  // 24 move lines + the node-kill line + the marker write all carry the guard.
  assert.equal(body.split("if ($valeMg").length - 1, 26, "every statement carries the marker guard");
  assert.ok(body.includes("if ($valeMg -and (-not (") && body.includes("(Test-Path 'D:\\Vale\\config.yaml')"), "marker write gated on pending pairs");
  assert.ok(body.includes(`New-Item -ItemType File -Force -Path 'D:\\Vale\\etc\\.layout-v2'`), "marker file itself");
  assert.ok(![...body].some((c) => c.charCodeAt(0) > 127), "ASCII-only (system-locale PS)");
});

test("rollbackVersionOk: plain dotted triples only (URL interpolation gate)", () => {
  const { rollbackVersionOk } = require("../bin/vale.js");
  assert.equal(rollbackVersionOk("1.2.307"), true);
  assert.equal(rollbackVersionOk("0.0.1"), true);
  assert.equal(rollbackVersionOk("1.2"), false, "two parts");
  assert.equal(rollbackVersionOk("1.2.3.4"), false, "four parts");
  assert.equal(rollbackVersionOk("1.2.307/../../evil"), false, "path escape");
  assert.equal(rollbackVersionOk("--clear"), false, "flag is not a version");
  assert.equal(rollbackVersionOk(""), false);
});
