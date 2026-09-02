// Coverage audit row 17: computeBoot is the ONE place the SPA decides
// host/token/connected — its precedence chain (injected > ?token= > stored)
// and proxy-mode non-persistence carry two past regressions (round-139
// blank-viewport 401 loop; round-122/124 plaintext token on the console
// origin). None of it had a test.
import { describe, it, expect, vi, beforeEach } from "vitest";

const initTransport = vi.fn();
vi.mock("./api", () => ({
  initTransport: (...a: unknown[]) => initTransport(...a),
}));

const setLocation = (pathname: string, search = "", host = "d1.test") => {
  vi.stubGlobal("location", { pathname, search, host, origin: `https://${host}` });
};

describe("computeBoot", () => {
  let computeBoot: (f: () => void) => { host: string; tok: string; connected: boolean };
  beforeEach(async () => {
    initTransport.mockClear();
    localStorage.clear();
    delete (window as any).__PANEL_TOKEN__;
    vi.resetModules();
    vi.stubGlobal("location", undefined as any); // re-stubbed per test
    ({ computeBoot } = await import("./boot"));
  });

  it("desktop injected token wins and seeds BOTH transport and state", () => {
    setLocation("/desktop/");
    (window as any).__PANEL_TOKEN__ = "inj";
    localStorage.setItem("valeToken", "stale");
    const boot = computeBoot(() => {});
    expect(boot.tok).toBe("inj");
    expect(boot.connected).toBe(true);
    expect(initTransport).toHaveBeenCalledWith("d1.test", "inj", expect.anything());
  });

  it("?token= beats stored when nothing is injected", () => {
    setLocation("/panel/", "?token=urltok");
    localStorage.setItem("valeToken", "stale");
    const boot = computeBoot(() => {});
    expect(boot.tok).toBe("urltok");
    expect(boot.connected).toBe(true);
  });

  it("stored token is the fallback", () => {
    setLocation("/panel/");
    localStorage.setItem("valeToken", "stale");
    expect(computeBoot(() => {}).tok).toBe("stale");
  });

  it("proxy mode: cookie credential — never persists the token, deletes stale", () => {
    setLocation("/proxy/panel", "?token=ptok", "console.test");
    localStorage.setItem("valeToken", "stale-leftover");
    const boot = computeBoot(() => {});
    expect(boot.tok).toBe("ptok");
    expect(localStorage.getItem("valeToken")).toBeNull(); // R122/124 contract
  });

  it("same-origin with NO token shows the conn form (not a dead 401 loop)", () => {
    setLocation("/panel/");
    const boot = computeBoot(() => {});
    expect(boot.connected).toBe(false);
  });

  it("private-mode localStorage (setItem throws) must not crash boot", () => {
    setLocation("/desktop/");
    (window as any).__PANEL_TOKEN__ = "inj";
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      const boot = computeBoot(() => {});
      expect(boot.tok).toBe("inj"); // session-only, still boots
    } finally {
      Storage.prototype.setItem = real;
    }
  });
});
