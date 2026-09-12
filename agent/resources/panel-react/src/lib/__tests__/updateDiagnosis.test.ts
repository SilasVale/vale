import { describe, it, expect } from "vitest";
import { diagnoseUpdate } from "../updateDiagnosis";

// The four cases are the repo's own release-docs table, and each one drives a
// different operator action — which is why the verdict is asserted, not just the
// presence of lines.
describe("diagnoseUpdate — the four-way update diagnosis", () => {
  const R = "[2026-09-12T06:51:49+08:00] update requested 1.2.327 -> 1.2.328 (CLI reached the device; the swap has not started yet)";

  it("receipt alone: the CLI reached the device, the swap never launched", () => {
    const d = diagnoseUpdate(R);
    expect(d.verdict).toBe("cli-only");
    expect(d.summary).toMatch(/never launched/i);
    // The action is named: re-running is safe.
    expect(d.summary).toMatch(/re-running the update is safe/i);
  });

  it("receipt + start: launched, and the script's own copy verdict is reported", () => {
    const d = diagnoseUpdate([R, "update start", "copy ok=true", "task restarted"].join("\n"));
    expect(d.verdict).toBe("cli-swap-launched");
    expect(d.copyOk).toBe(true);
    expect(d.restarted).toBe(true);
    expect(d.summary).toMatch(/copy succeeded and the agent was restarted/i);
  });

  it("a launched swap whose COPY FAILED does not read as success", () => {
    // The distinction that matters most: "launched" is not "replaced". A swap
    // that could not copy leaves the device on the old binary.
    const d = diagnoseUpdate([R, "update start", "copy ok=false"].join("\n"));
    expect(d.verdict).toBe("cli-swap-launched");
    expect(d.copyOk).toBe(false);
    expect(d.summary).toMatch(/still running the previous build/i);
  });

  it("start with no receipt: launched by the Rust path, not the CLI", () => {
    const d = diagnoseUpdate("update start\ncopy ok=true");
    expect(d.verdict).toBe("rust-swap");
    expect(d.receipt).toBeNull();
  });

  it("neither: the command never reached the device", () => {
    const d = diagnoseUpdate("some unrelated line\nanother");
    expect(d.verdict).toBe("never-arrived");
    // The sentence that costs a device an hour when it is missing.
    expect(d.summary).toMatch(/connection drop is NOT proof/i);
  });

  it("an ABSENT log is 'no-log', NOT 'never-arrived'", () => {
    // Collapsing these would tell an operator their update was lost on a device
    // that has never been updated. Different facts.
    for (const empty of ["", "   ", null, undefined]) {
      expect(diagnoseUpdate(empty).verdict).toBe("no-log");
    }
  });

  it("presence is decided PER KIND, not by which line is last", () => {
    // A device whose earlier update used the CLI and whose LATEST used the Rust
    // path has both kinds on disk. Deciding by the last line would call it
    // "cli-only" and hide that a swap ran.
    const log = [R, "update start", "copy ok=true", "task restarted"].join("\n");
    expect(diagnoseUpdate(log).verdict).toBe("cli-swap-launched");
    // And the reverse order still reports the launch.
    const rev = ["update start", "copy ok=true", R].join("\n");
    expect(diagnoseUpdate(rev).verdict).toBe("cli-swap-launched");
  });

  it("reads the LAST copy verdict when a device has updated more than once", () => {
    const log = [R, "update start", "copy ok=true", "update start", "copy ok=false"].join("\n");
    expect(diagnoseUpdate(log).copyOk).toBe(false);
  });
});
