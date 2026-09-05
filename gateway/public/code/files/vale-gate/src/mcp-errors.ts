/**
 * mcp-errors — the stable tool-failure code family shared by the MCP tool
 * dispatch paths (terminal self-heal dispatch in mcp.ts, the browser bridge
 * in mcp-browser.ts). Structure refactor: moved verbatim from mcp.ts; the
 * codes surface to MCP clients in the error `data` (round-55) so the model
 * can retry smartly.
 */

export const DEVICE_UNREACHABLE = "DEVICE_UNREACHABLE";
export const TIMEOUT = "TIMEOUT";
export const SESSION_NOT_FOUND = "SESSION_NOT_FOUND";
export const SESSION_BUSY = "SESSION_BUSY";
export const TOOL_ERROR = "TOOL_ERROR";
export function ToolErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
