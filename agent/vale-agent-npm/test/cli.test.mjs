// npm CLI first tests (coverage audit rows 13+14). The CLI is the SOLE
// install/update channel and runs PowerShell under SYSTEM/admin — its
// quoting and update-mutual-exclusion previously had zero coverage.
// bin/vale.js exports the pure helpers (dispatch is require.main-guarded).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { psq, busyIsFresh, deskShortcutRepairPs, playwrightProbePs, parseAgentPort, agentPort, firewallPs } = require("../bin/vale.js");

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
  const lines = deskShortcutRepairPs("D:\\Vale", "Write-Host");
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

test("writeReleaseMarker: fresh-install parity with the round-298 update marker", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { writeReleaseMarker } = require("../bin/vale.js");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vale-relmark-"));
  try {
    // Writes the package.json version (same source `vale update` uses).
    writeReleaseMarker(d);
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(fs.readFileSync(path.join(d, ".vale-release"), "utf8"), pkg.version);
    // Idempotent (re-run overwrites with the same value).
    writeReleaseMarker(d);
    assert.equal(fs.readFileSync(path.join(d, ".vale-release"), "utf8"), pkg.version);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("writeReleaseMarker: missing dir stays silent (best-effort, never throws)", () => {
  const { writeReleaseMarker } = require("../bin/vale.js");
  assert.doesNotThrow(() => writeReleaseMarker("Z:\\definitely\\not\\here"));
});
