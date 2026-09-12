/**
 * The device reports TWO versions and only one of them answers "is my device current?".
 *
 * `release` is the npm release (1.2.x, changes every release); `version` is the Cargo
 * protocol version (1.0.x, FROZEN). `DesktopShell` preferred `release` and said so in
 * a comment; `ConnectCard` used `version` — so in the desktop shell the status strip
 * read v1.2.354 while Settings reported v1.0.145 for the SAME device, and a user
 * checking whether an update took got two contradictory answers.
 *
 * The rule is one function now, so a third caller cannot pick differently.
 */
import { describe, it, expect } from "vitest";
import { releaseVersion, releaseVersionLabel } from "./agentVersion";

describe("releaseVersion", () => {
  it("prefers the npm RELEASE — the number that actually changes", () => {
    expect(releaseVersion({ release: "1.2.354", version: "1.0.145" })).toBe(
      "1.2.354",
    );
  });

  it("falls back to the Cargo version for a device too old to send `release`", () => {
    expect(releaseVersion({ version: "1.0.145" })).toBe("1.0.145");
  });

  it("treats empty and non-string as absent rather than rendering them", () => {
    expect(releaseVersion({ release: "", version: "1.0.145" })).toBe("1.0.145");
    expect(releaseVersion({ release: 42, version: "1.0.145" })).toBe("1.0.145");
    expect(releaseVersion({})).toBe("");
    expect(releaseVersion(null)).toBe("");
    expect(releaseVersion(undefined)).toBe("");
  });

  it("never yields a bare 'v' — an unknown device says v?", () => {
    expect(releaseVersionLabel({})).toBe("v?");
    expect(releaseVersionLabel({ release: "1.2.354" })).toBe("v1.2.354");
  });

  it("THE REGRESSION: a device reporting both shows the release, not the frozen one", () => {
    // This is the exact shape /api/status returns, and the assertion the two
    // callers disagreed on.
    const status = { release: "1.2.354", version: "1.0.145", live_sessions: 1 };
    expect(releaseVersionLabel(status)).toBe("v1.2.354");
    expect(releaseVersionLabel(status)).not.toContain("1.0.145");
  });
});
