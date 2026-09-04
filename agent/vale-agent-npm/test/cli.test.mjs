// npm CLI first tests (coverage audit rows 13+14). The CLI is the SOLE
// install/update channel and runs PowerShell under SYSTEM/admin — its
// quoting and update-mutual-exclusion previously had zero coverage.
// bin/vale.js exports the pure helpers (dispatch is require.main-guarded).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { psq, busyIsFresh, deskShortcutRepairPs } = require("../bin/vale.js");

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
