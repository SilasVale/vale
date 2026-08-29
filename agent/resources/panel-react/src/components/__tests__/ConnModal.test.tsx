// ConnModal tests — the round-160 SSH private-key support: key_path rides in
// the connect extras only when entered, and the password field doubles as the
// key passphrase (server-side russh load_secret_key(path, password)).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnModal } from "../ConnModal";
import { callApi } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  callApi: vi.fn(),
  callTool: vi.fn(),
}));
const mockCallApi = callApi as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockCallApi.mockReset();
  mockCallApi.mockResolvedValue({ result: { connections: [] } });
});

function fill(host: string, user: string) {
  fireEvent.change(screen.getByPlaceholderText("host.example.com"), { target: { value: host } });
  fireEvent.change(screen.getByPlaceholderText("22"), { target: { value: "22" } });
  fireEvent.change(screen.getByPlaceholderText("user"), { target: { value: user } });
}

describe("ConnModal (ssh)", () => {
  it("passes key_path in the connect extras when a key path is entered", async () => {
    const onConnect = vi.fn().mockResolvedValue({});
    render(<ConnModal kind="ssh" onClose={() => {}} onConnect={onConnect} />);
    fill("box.example.com", "me");
    fireEvent.change(screen.getByPlaceholderText("C:\\Users\\me\\.ssh\\id_ed25519"), {
      target: { value: "C:\\keys\\id_ed25519" },
    });
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
    expect(onConnect).toHaveBeenCalledWith("me@box.example.com:22", {
      password: "",
      key_path: "C:\\keys\\id_ed25519",
    });
  });

  it("omits key_path when empty (password-only connect)", async () => {
    const onConnect = vi.fn().mockResolvedValue({});
    render(<ConnModal kind="ssh" onClose={() => {}} onConnect={onConnect} />);
    fill("box.example.com", "root");
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
    expect(onConnect.mock.calls[0]![1]).toEqual({ password: "" });
  });
});
