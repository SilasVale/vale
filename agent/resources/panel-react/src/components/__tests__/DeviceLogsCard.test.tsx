import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { callApi } from "../../lib/api";
import { DeviceLogsCard } from "../DeviceLogsCard";

vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  callApi: vi.fn(),
}));

const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;
const R = "[2026-09-12T06:51:49+08:00] update requested 1.2.327 -> 1.2.328 (CLI reached the device)";

function device(logs: Array<{ name: string; present: boolean; log: string }>) {
  mockCallApi.mockResolvedValue({ ok: true, dir: "C:\\ProgramData\\Vale\\logs", logs });
}

describe("DeviceLogsCard — the device's logs, and the update verdict they answer", () => {
  beforeEach(() => mockCallApi.mockReset());

  it("reads GET /api/logs — its first consumer", async () => {
    device([{ name: "vale-update.log", present: true, log: R }]);
    render(<DeviceLogsCard />);
    expect(await screen.findByText(/never launched/i)).toBeTruthy();
    expect(mockCallApi).toHaveBeenCalledWith("/api/logs");
  });

  it("names an ABSENT log as absent instead of showing an empty one", async () => {
    // The route distinguishes "never written" from "written, empty" on purpose.
    // Rendering both as a blank tail would throw that distinction away.
    device([
      { name: "vale-update.log", present: true, log: R },
      { name: "agent.log", present: false, log: "" },
    ]);
    render(<DeviceLogsCard />);
    expect(await screen.findByText("not written yet")).toBeTruthy();
  });

  it("a FAILED read does not render as a device with no logs", async () => {
    // "I could not read the logs" and "there are no logs" are different claims,
    // and only one of them is true when the device is unreachable.
    //
    // Driven through a RESOLVED `{ok:false}` rather than a rejected promise: the
    // component takes the SAME branch for both, and a rejected promise makes
    // vitest attribute an "unhandled rejection" to the test even though the
    // component catches it — a harness artifact that would obscure which fact
    // was being asserted. `ok` is part of the route's contract, so a device that
    // refuses to answer must not be drawn as a device with nothing to say.
    mockCallApi.mockResolvedValue({ ok: false, error: "logs unavailable" });
    render(<DeviceLogsCard />);
    expect(await screen.findByText(/did not answer/i)).toBeTruthy();
    expect(screen.getByText(/not the same as a device with no logs/i)).toBeTruthy();
    // And it does NOT draw the healthy-empty state.
    expect(screen.queryByText(/not written yet/i)).toBeNull();
  });
  it("carries the verdict as DATA, so the tone is not the only signal", async () => {
    device([{ name: "vale-update.log", present: true, log: [R, "update start", "copy ok=true"].join("\n") }]);
    const { container } = render(<DeviceLogsCard />);
    await screen.findByText(/swap launched/i);
    const el = container.querySelector(".device-logs-verdict")!;
    expect(el.getAttribute("data-verdict")).toBe("cli-swap-launched");
  });

  it("an empty log is 'no-log', not 'the update was lost'", async () => {
    device([{ name: "vale-update.log", present: false, log: "" }]);
    render(<DeviceLogsCard />);
    expect(await screen.findByText(/no update has been attempted here/i)).toBeTruthy();
  });
});
