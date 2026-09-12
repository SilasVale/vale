// SettingsPage memory-capacity card (round-358): GET prefills the three
// fields, Save PUTs them (retention "" → null = keep forever), and invalid
// input blocks the PUT with a hint.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPage } from "../SettingsPage";
import { callApi } from "../../lib/api";

// Partial mock via importOriginal, NOT a hand-written factory. A factory that
// lists only the exports a test happens to use breaks the moment a NEW
// component under SettingsPage reaches for another export — which is exactly
// what happened when ConnectCard began reading getHost/getToken: three
// unrelated memory-card tests failed with "No getHost export is defined on the
// mock". Spreading the real module keeps the mock correct by construction.
vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  callApi: vi.fn(),
}));
const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;

const SETTINGS = {
  ok: true,
  buffer_mb: 8,
  console_url: null,
  tunnel_configured: false,
  tunnel_running: false,
  memory_max_entries: 50,
  memory_max_bytes_mb: 16,
  memory_retention_days: 30,
};

beforeEach(() => {
  mockCallApi.mockReset();
  mockCallApi.mockImplementation(async (path: string, opts?: any) => {
    if (!opts || !opts.method || opts.method === "GET") return SETTINGS;
    return { ok: true, buffer_mb: 8 };
  });
});

describe("SettingsPage memory card", () => {
  it("prefills entries/MiB/retention from GET /api/settings", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Memory max entries") as HTMLInputElement).value,
      ).toBe("50");
    });
    expect(
      (screen.getByLabelText("Memory max MiB") as HTMLInputElement).value,
    ).toBe("16");
    expect(
      (screen.getByLabelText("Memory retention days") as HTMLInputElement)
        .value,
    ).toBe("30");
  });

  it("PUTs the edited capacity with retention null when cleared", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Memory max entries") as HTMLInputElement).value,
      ).toBe("50");
    });
    fireEvent.change(screen.getByLabelText("Memory max entries"), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText("Memory retention days"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByLabelText("Save memory capacity"));
    await waitFor(() =>
      expect(screen.getByText("saved — applies immediately")).toBeTruthy(),
    );
    const put = mockCallApi.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!put) throw new Error("expected a PUT /api/settings call");
    expect(JSON.parse(put[1].body)).toEqual({
      memory_max_entries: 100,
      memory_max_bytes_mb: 16,
      memory_retention_days: null,
    });
  });

  it("blocks the PUT on invalid entries with a hint", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Memory max entries") as HTMLInputElement).value,
      ).toBe("50");
    });
    fireEvent.change(screen.getByLabelText("Memory max entries"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByLabelText("Save memory capacity"));
    await waitFor(() =>
      expect(screen.getByText("entries must be >= 1")).toBeTruthy(),
    );
    expect(
      mockCallApi.mock.calls.filter((c) => c[1]?.method === "PUT"),
    ).toHaveLength(0);
  });
});
