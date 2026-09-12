/**
 * mcp-browser — the gateway-side browser_* bridge: relay tool calls to the
 * agent's playwright-mcp via mcp_client_call, with self-healing (start →
 * connect → retry), a per-call total budget, and a per-device concurrency
 * semaphore. Structure refactor: moved verbatim from mcp.ts (the extension/
 * PluginHubDO path was deleted round-341; the bridge is the only browser
 * path left, so it lives on its own next to its dedicated test file).
 */

import { deviceHostError } from "./device-fetch.ts";
import { ToolErr, DEVICE_UNREACHABLE, SESSION_BUSY } from "./mcp-errors.ts";

/** Browser tools → agent's mcp_client_call → playwright-mcp.
 *   (The extension/PluginHubDO path was deleted round-341.) */
//
// Gateway-side guardrails for this bridge: the per-fetch budget below is
// per ATTEMPT, and the old code stacked attempts serially (invoke + start +
// connect + retry ≈ 4×320s ≈ 21min of pinned isolate time on a hung device,
// with unbounded concurrent browser_* calls piling on):
//   - BROWSER_GATEWAY_BUDGET_MS: hard TOTAL cap for one browser_* call
//     (invoke + self-heal + retry combined).
//   - BROWSER_SELFHEAL_TIMEOUT_MS: start/connect are liveness probes, not
//     work — they get a short timeout, never the call budget.
//   - BROWSER_MAX_CONCURRENT_PER_DEVICE: isolate-local per-device semaphore
//     (same pattern as __probeRate in index.ts). No existing mechanism was
//     reusable: BreakerDO guards upstream CHANNEL health per channel-name via
//     DO state, and withKeyLock serializes KV read-modify-write — neither is
//     a per-device in-flight semaphore. Excess calls fail with SESSION_BUSY
//     so MCP clients back off and retry instead of dogpiling.
const BROWSER_GATEWAY_BUDGET_MS = 350_000;
const BROWSER_SELFHEAL_TIMEOUT_MS = 15_000;
const BROWSER_MAX_CONCURRENT_PER_DEVICE = 4;
const __browserInflight = new Map<string, number>();

async function withBrowserSlot<T>(slot: string, fn: () => Promise<T>): Promise<T> {
  const cur = __browserInflight.get(slot) || 0;
  if (cur >= BROWSER_MAX_CONCURRENT_PER_DEVICE) {
    throw ToolErr(
      SESSION_BUSY,
      `too many concurrent browser calls on device ${slot} — retry shortly`,
    );
  }
  __browserInflight.set(slot, cur + 1);
  try {
    return await fn();
  } finally {
    const left = (__browserInflight.get(slot) || 1) - 1;
    if (left <= 0) __browserInflight.delete(slot);
    else __browserInflight.set(slot, left);
  }
}

export async function callMcpClientBridge(
  name: string,
  _env: any,
  device: any,
  args: any,
): Promise<any> {
  // SSRF guard (same checks as deviceFetch): the device record's hostname is
  // dialed here with the device Bearer token, and these raw fetches bypass
  // deviceFetch's private-IP/userinfo guards. deviceFetch
  // itself can't be used: its POST bound is 60s while browser waits
  // legitimately run up to ~320s (timeout_secs clamp 300 + 20s headroom) —
  // so apply the identical hostname checks up front instead.
  const hostErr = deviceHostError(device.hostname);
  if (hostErr) throw ToolErr(DEVICE_UNREACHABLE, hostErr);
  let base: string;
  try {
    const u = new URL(`https://${device.hostname}/`);
    // Belt-and-suspenders (mirrors deviceFetch): URL-significant characters
    // smuggled in the hostname field must not redirect the dial elsewhere.
    if (u.hostname.toLowerCase() !== String(device.hostname).toLowerCase()) {
      throw new Error("host mismatch");
    }
    base = `https://${device.hostname}`;
  } catch (e: any) {
    if (e?.code) throw e;
    throw ToolErr(DEVICE_UNREACHABLE, "invalid device hostname");
  }
  const token = device.token || "";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  // Tool name mapping: gateway name → playwright-mcp name
  const toolMap: Record<string, string> = {
    browser_open: "browser_navigate",
    browser_snapshot: "browser_snapshot",
    browser_screenshot: "browser_take_screenshot",
    browser_click: "browser_click",
    browser_type: "browser_type",
    browser_wait: "browser_wait_for",
    browser_close: "browser_close",
  };
  const pmTool = toolMap[name] || name;
  // round-138: playwright-mcp's new click/type use the {element?, target} protocol
  // (target = a snapshot reference "eN" or a unique selector); the gateway's old declaration took element_ref integers.
  // We translate to target here, so callers' habits don't change; type's text passes through as-is.
  const pmArgs: any = { ...args };
  // ONE RENAME, because the console and the shipped server disagree on the
  // spelling: the console says `text_gone`, playwright-mcp 0.0.79 says
  // `textGone`. Everything else is forwarded verbatim — which is why every
  // advertised name must exist in the server (pinned by browser-contract.test.mjs).
  if (name === "browser_wait" && pmArgs.text_gone != null) {
    pmArgs.textGone = pmArgs.text_gone;
    delete pmArgs.text_gone;
  }
  // Extension audit M2: timeout_secs was forwarded UNCLAMPED and the fetch
  // below had NO signal — a hung playwright-mcp (modal CDP block) pinned the
  // worker request AND an isolate for the platform ceiling. Clamp + bound.
  if (typeof pmArgs.timeout_secs === "number") {
    pmArgs.timeout_secs = Math.min(Math.max(Math.trunc(pmArgs.timeout_secs) || 1, 1), 300);
  }
  const callBudgetMs = ((pmArgs.timeout_secs as number) || 120) * 1000 + 20_000;
  // Gateway-side total budget (see the guardrails comment above): every
  // attempt below draws from this deadline instead of stacking full budgets.
  const slot = String(device?.name || device?.hostname || "default");
  const deadline = Date.now() + BROWSER_GATEWAY_BUDGET_MS;
  // Floor 1s so the final attempt still fires instead of
  // AbortSignal.timeout(0/negative) aborting instantly.
  const budgetLeftMs = () => Math.max(1000, deadline - Date.now());
  if ((name === "browser_click" || name === "browser_type") && args?.element_ref != null) {
    pmArgs.target = /^e?\d+$/.test(String(args.element_ref))
      ? String(args.element_ref).replace(/^(\d+)$/, "e$1")
      : String(args.element_ref);
    if (!pmArgs.element) pmArgs.element = "target element";
    delete pmArgs.element_ref;
  }
  const invoke = async (): Promise<any> => {
    // RUN IDENTITY: the run_id belongs to the DEVICE CALL, not to
    // playwright-mcp. It rides `arguments` (which is a verbatim spread of the
    // caller's args) but must be lifted OUT to the top level, because the
    // device reads it from `params.run_id` — nested inside `arguments` it would
    // reach playwright-mcp, which knows nothing about runs, and be dropped. A
    // silently dropped id shows a run with commands and ZERO browser actions:
    // indistinguishable from "the AI never used the browser".
    const { run_id, ...pwArgs } = pmArgs as Record<string, unknown>;
    const deviceCall: Record<string, unknown> = { tool: pmTool, arguments: pwArgs };
    if (run_id != null) deviceCall.run_id = run_id;
    const res = await fetch(`${base}/api/tools/mcp_client_call`, {
      method: "POST",
      headers,
      body: JSON.stringify(deviceCall),
      signal: AbortSignal.timeout(Math.min(callBudgetMs, budgetLeftMs())),
    });
    // The agent's tool API always returns 200 + {ok:false,error,code} (web.rs api_call_tool);
    // the failure info is in the body, so res.ok alone can't be trusted.
    try {
      return await res.json();
    } catch {
      throw new Error(`mcp_client_call failed: ${res.status}`);
    }
  };
  const run = async (): Promise<any> => {
    let out = await invoke();
    if (out && out.ok === false) {
      const msg = String(out.error || "");
      // round-118 self-healing: after a device reboot nothing relaunches playwright-mcp and nobody
      // creates a client session — the first browser_* is bound to be "not connected", requiring manual
      // intervention. Here we do start → connect → retry once, so the browser chain self-heals on boot.
      // round-132: "Session not found" is also covered by self-healing — playwright-mcp 0.0.79
      // reclaims sessions server-side after ~15s idle; resending connect restores them.
      if (/not connected|server running|refused|timed out|session not found/i.test(msg)) {
        // Liveness probes, not work: short timeouts drawing from the same
        // total budget (a hung agent must not eat another 2×320s here).
        const healTimeout = () => Math.min(BROWSER_SELFHEAL_TIMEOUT_MS, budgetLeftMs());
        await fetch(`${base}/api/plugins/playwright/start`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(healTimeout()),
        });
        await fetch(`${base}/api/tools/mcp_client_connect`, {
          method: "POST",
          headers,
          body: "{}",
          signal: AbortSignal.timeout(healTimeout()),
        });
        out = await invoke();
      }
      if (out && out.ok === false) {
        throw new Error(String(out.error || "mcp_client_call failed"));
      }
    }
    return out;
  };
  return withBrowserSlot(slot, run);
}
