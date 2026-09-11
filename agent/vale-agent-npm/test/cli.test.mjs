// npm CLI first tests (coverage audit rows 13+14). The CLI is the SOLE
// install/update channel and runs PowerShell under SYSTEM/admin — its
// quoting and update-mutual-exclusion previously had zero coverage.
// bin/vale.js exports the pure helpers (dispatch is require.main-guarded).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { psq, busyIsFresh, deskShortcutRepairPs, playwrightProbePs, parseAgentPort, agentPort, firewallPs, uninstallVersionPs, uninstallRegBodyPs, BOOT_TASKS, autostartArgv, bootTaskPs, migrateLayoutPs, startDesktopPs, rollbackVersionOk } = require("../bin/vale.js");

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

test("uninstallVersionPs: $ok-gated DisplayVersion parity, UninstallString only when absent", () => {
  const { uninstallVersionPs } = require("../bin/vale.js");
  const body = uninstallVersionPs("C:\\Program Files\\Vale", "1.2.307").join("\n");
  assert.match(body, /\$ok -and '1\.2\.307'/, "gated on provable swap success like .vale-release");
  assert.match(body, /DisplayVersion/, "moves the Add/Remove version");
  assert.match(body, /DisplayName/, "moves the display name with it");
  assert.match(body, /InstallLocation/, "records where the release lives");
  assert.match(body, /catch \{\}/, "best-effort: registry failure never fails the update");
  assert.match(body, /Test-Path \$rk/, "creates the key for npm-only installs that lack one");
  assert.ok(![...body].some((c) => c.charCodeAt(0) > 127), "ASCII-only (system-locale PS)");
});

test("uninstallRegBodyPs: shared setup/swap body, conditional elevated uninstall", () => {
  const { uninstallRegBodyPs } = require("../bin/vale.js");
  const body = uninstallRegBodyPs("D:\\Vale", "1.2.307").join("\n");
  assert.ok(!body.includes("$ok"), "ungated body (setup has no $ok; the swap wraps it)");
  assert.match(body, /DisplayVersion/, "versions the entry");
  // UninstallString is conditional — an NSIS install owns its
  // $INSTDIR\uninstall.exe value and it must never be overwritten.
  assert.match(body, /Get-ItemProperty -Path \$rk -Name UninstallString/, "reads before writing");
  const idxRead = body.indexOf("Get-ItemProperty -Path $rk -Name UninstallString");
  const idxWrite = body.indexOf("-Name UninstallString -Value", idxRead);
  assert.ok(idxRead >= 0 && idxWrite > idxRead, "write is guarded by the absence read");
  // v2 path first, legacy fallback second.
  const idxComp = body.indexOf("components\\npm-global\\vale.cmd");
  const idxTools = body.indexOf("tools\\npm-global\\vale.cmd");
  assert.ok(idxComp >= 0 && idxTools > idxComp, "components first, tools legacy fallback");
  // Control panel does not elevate: relaunch elevated or uninstall dies.
  assert.match(body, /-Verb RunAs/, "re-elevates (HKLM/schtasks need admin)");
  assert.match(body, /-Wait/, "control panel waits for completion");
  // Empty version = no-op (setup with an unreadable package.json).
  assert.deepEqual(uninstallRegBodyPs("D:\\Vale", ""), [], "empty ver writes nothing");
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

// SOLID Round-17 (contract completion): boxedVersions/writeBoxedVersions
// carry an "exported: unit-tested shape" comment but had ZERO pins — the
// boxed-component manifest (/api/status surfaces it) is the version-lock
// supervision for playwright + cloudflared. Staged temp dirs only; the
// cloudflared --version probe never fires here (no staged binary).
test("boxedVersions: empty trees → all unknown, ISO updated stamp", () => {
  const { boxedVersions } = require("../bin/vale.js");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vale-boxed-empty-${process.pid}-`));
  try {
    const m = boxedVersions(dir, dir);
    assert.ok(!Number.isNaN(Date.parse(m.updated)), "machine-readable stamp");
    assert.equal(m.playwright_mcp.version, "unknown");
    assert.equal(m.playwright_mcp.sha256, "unknown");
    assert.equal(m.playwright_core.version, "unknown");
    assert.equal(m.cloudflared.version, "unknown");
    assert.equal(m.cloudflared.sha256, "unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("boxedVersions: staged versions read, zip hashed exactly", () => {
  const { boxedVersions } = require("../bin/vale.js");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vale-boxed-full-${process.pid}-`));
  try {
    const mcpPkg = path.join(dir, "components", "playwright", "node_modules", "@playwright", "mcp");
    fs.mkdirSync(mcpPkg, { recursive: true });
    fs.writeFileSync(path.join(mcpPkg, "package.json"), '{"version":"9.9.9"}');
    const zipBytes = Buffer.from("fake-playwright-zip-bytes");
    fs.writeFileSync(path.join(dir, "vale-playwright.zip"), zipBytes);
    const m = boxedVersions(dir, dir);
    assert.equal(m.playwright_mcp.version, "9.9.9");
    assert.equal(m.playwright_mcp.sha256, crypto.createHash("sha256").update(zipBytes).digest("hex"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("boxedVersions: >300MB blob → unknown sha without reading it", () => {
  const { boxedVersions } = require("../bin/vale.js");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vale-boxed-big-${process.pid}-`));
  try {
    // Sparse file: stat reports 301MB instantly, disk use stays ~nil.
    const big = path.join(dir, "vale-playwright.zip");
    fs.writeFileSync(big, "x");
    fs.truncateSync(big, 301 * 1024 * 1024);
    const t0 = Date.now();
    const m = boxedVersions(dir, dir);
    assert.equal(m.playwright_mcp.sha256, "unknown", "oversize guard, not a hash");
    assert.ok(Date.now() - t0 < 5000, "must not read 301MB");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeBoxedVersions: writes a parseable manifest; hostile dirs stay silent", () => {
  const { writeBoxedVersions } = require("../bin/vale.js");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vale-boxed-write-${process.pid}-`));
  try {
    writeBoxedVersions(dir, dir); // etc/ auto-created, never throws
    const back = JSON.parse(fs.readFileSync(path.join(dir, "etc", "boxed-versions.json"), "utf8"));
    for (const k of ["updated", "playwright_mcp", "playwright_core", "cloudflared"]) {
      assert.ok(back[k] !== undefined, `manifest carries ${k}`);
    }
    // A file where a directory is expected: best-effort skip, never throws.
    const file = path.join(dir, "blocker");
    fs.writeFileSync(file, "x");
    writeBoxedVersions(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The update that left no trace ───────────────────────────────────────────
//
// INCIDENT: a device update was issued through the sanctioned flow and the
// connection dropped, which is the DOCUMENTED behaviour of a successful swap
// ("the terminal connection DROPS for ~10 s mid-update"). It was therefore read
// as "the update started". It had not: on the device there was no
// update-busy marker, no staged vale-agent.new.exe, no scripts\vale-update.ps1,
// and no `update start` line in vale-update.log — the command never reached the
// device at all, and the transport failure was indistinguishable from the
// success signal. Only the RELEASE MARKER, still reading the old version, told
// the truth, and the operator had to go and read four things by hand to learn it.
//
// `vale status` is the command a person runs to ask "where is this device". It
// reported RUNNING / install dir / panel URL and NOTHING about the release or a
// pending swap, so it could not answer the only question that mattered.
//
// These tests pin the report's CONTENT, because the failure mode is an
// omission: a `status` that prints three plausible lines while leaving out the
// release version looks perfectly healthy.
test("statusReport: reports the running release and a FAILED update, not just RUNNING", () => {
  const { statusReport } = require("../bin/vale.js");
  const now = 1_700_000_000_000;

  // (a) An update was attempted and never finished: the marker survives with
  //     its original mtime. This is THE diagnostic the incident lacked.
  const stalled = statusReport({
    agentRunning: true,
    installDir: "D:\\Vale",
    exeExists: true,
    port: 18080,
    releaseVersion: "1.2.321",
    updateMarkerMs: now - 27 * 60_000,
    packageVersion: "1.2.322",
    nowMs: now,
  }).join("\n");
  assert.match(stalled, /1\.2\.321/, "must name the version the device is actually running");
  assert.match(
    stalled,
    /did not finish|DID NOT FINISH/i,
    "a marker past the freshness window means an update STARTED AND DID NOT FINISH — status must say so, not stay silent",
  );
  // The DRIFT line specifically — the one that answers "am I up to date?".
  // Pinned separately from the bare version numbers above, because those also
  // match the `this CLI:` line and would keep passing if the drift line were
  // dropped in a refactor. That is the whole failure mode under test: a status
  // that looks informative while omitting the fact that matters.
  assert.match(
    stalled,
    /device runs 1\.2\.321.*1\.2\.322/,
    "must state the DRIFT (device runs X, this CLI is Y), not merely print both numbers somewhere",
  );

  // (b) Nothing in flight and the device matches this CLI: say so plainly.
  const current = statusReport({
    agentRunning: true,
    installDir: "D:\\Vale",
    exeExists: true,
    port: 18080,
    releaseVersion: "1.2.322",
    updateMarkerMs: null,
    packageVersion: "1.2.322",
    nowMs: now,
  }).join("\n");
  assert.match(current, /1\.2\.322/);
  assert.ok(
    !/DID NOT FINISH/i.test(current),
    "an absent marker must NOT be reported as a failed update — absent is not the same as broken",
  );

  // (c) An update IS in flight (fresh marker): distinct from both above.
  const inFlight = statusReport({
    agentRunning: true,
    installDir: "D:\\Vale",
    exeExists: true,
    port: 18080,
    releaseVersion: "1.2.321",
    updateMarkerMs: now - 30_000,
    packageVersion: "1.2.322",
    nowMs: now,
  }).join("\n");
  assert.match(inFlight, /in flight|IN FLIGHT/i, "a fresh marker means a swap is running right now");

  // (d) An install with no release marker at all (pre-round-298 or a fresh box)
  //     says "unknown" rather than inventing a version.
  const unknown = statusReport({
    agentRunning: false,
    installDir: "D:\\Vale",
    exeExists: false,
    port: 18080,
    releaseVersion: null,
    updateMarkerMs: null,
    packageVersion: "1.2.322",
    nowMs: now,
  }).join("\n");
  assert.match(unknown, /STOPPED/);
  assert.match(unknown, /unknown/i, "no marker => unknown, never a fabricated version");
});

// The receipt that makes "the command never ran" provable from the log alone.
test("updateReceiptPs: appends the INTENT before the handoff, to the same log the swap writes", () => {
  const { updateReceiptPs } = require("../bin/vale.js");
  const lines = updateReceiptPs("D:\\Vale", "1.2.321", "1.2.322");
  const body = lines.join("\n");
  assert.match(body, /vale-update\.log/, "same file the swap script appends to — one timeline");
  assert.match(body, /1\.2\.321/, "records the version being replaced");
  assert.match(body, /1\.2\.322/, "records the version being installed");
  assert.match(body, /-Append/, "appends; must never truncate the swap's own log");
  assert.match(body, /requested/i, "the word that distinguishes it from the swap's own 'update start'");
  // The swap script's first line is `update start`. The receipt must be a
  // DIFFERENT marker, or the two become indistinguishable and the whole point
  // (did the CLI run? did the swap run?) is lost.
  assert.ok(!/update start/.test(body), "must not reuse the swap's 'update start' marker");
});

// The receipt is only worth anything if it lands in the SAME file the swap
// appends to. A receipt written to a different path is worse than none: the
// log would look like the swap never started, which is the false conclusion
// this whole change exists to prevent. Pinned against the swap's own
// construction rather than against a literal, so moving one moves the test.
test("updateReceiptPs: the sink is byte-identical to the swap script's log sink", () => {
  const { updateReceiptPs, psq } = require("../bin/vale.js");
  const probe = ["D:\\Vale", "D:\\ProgramData\\Vale", "C:\\Program Files\\Vale"];
  for (const dataDir of probe) {
    // Mirrors the `const log = ...` line in update(), verbatim.
    const swapLog = `Out-File '${dataDir.replace(/'/g, "''")}\\logs\\vale-update.log' -Append`;
    const receipt = updateReceiptPs(psq(dataDir), "1.0.0", "1.0.1")[0];
    const receiptLog = receipt.slice(receipt.indexOf("Out-File"));
    assert.equal(receiptLog, swapLog, `sinks must agree for ${dataDir}`);
  }
  // A quote in the data dir must be doubled, exactly as the swap does it —
  // otherwise the single-quoted PS literal breaks and the receipt never lands.
  const quoted = updateReceiptPs(psq("D:\\it's\\Vale"), "1.0.0", "1.0.1")[0];
  assert.match(quoted, /it''s/, "embedded quote doubled for the PS single-quoted literal");
});
