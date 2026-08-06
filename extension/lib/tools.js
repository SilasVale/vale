import { ensureTab, send } from "./cdp.js";
import { ELEMENTS_SCRIPT } from "./elements.js";
import { state } from "./state.js";

// consoleOrigin is read async in background.js and injected into this module.
export let CONSOLE_ORIGIN = "";
export function setConsoleOrigin(o) { CONSOLE_ORIGIN = o; }

function proxyUrl(device) {
  return `${CONSOLE_ORIGIN}/api/devices/${device}/proxy/`;
}

async function evaluate(tabId, expr) {
  const { result } = await send(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
  if (result?.exceptionDetails) throw new Error(`page evaluate failed: ${result.exceptionDetails.text || "exception"}`);
  return result?.value;
}
async function snapshot(tabId) {
  const json = await evaluate(tabId, ELEMENTS_SCRIPT);
  if (typeof json !== "string") throw new Error("page evaluate returned no snapshot — is the tab still alive?");
  return JSON.parse(json);
}
async function resolveRef(tabId, ref) {
  const snap = await snapshot(tabId);
  const el = snap.elements.find((e) => e.ref === ref);
  if (!el) throw new Error(`element ref ${ref} not found — re-snapshot`);
  return { el, snap };
}
async function clickByPath(tabId, path) {
  // Re-resolve the path in-page; if it fails, DOM changed → re-snapshot.
  const found = await evaluate(tabId, `(() => {
    try { const el = document.querySelector(${JSON.stringify(path)}); return el ? el.getBoundingClientRect() : null; }
    catch { return null; }
  })()`);
  if (!found) throw new Error("DOM changed — please re-snapshot");
  const x = found.x + found.width / 2, y = found.y + found.height / 2;
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function runTool(tool, params) {
  const device = params.device;
  const tabId = await ensureTab(device, proxyUrl(device));
  switch (tool) {
    case "browser_open": {
      await send(tabId, "Page.navigate", { url: params.url });
      await waitLoad(tabId, 30_000);
      return snapshot(tabId);
    }
    case "browser_snapshot": return snapshot(tabId);
    case "browser_screenshot": {
      const { data } = await send(tabId, "Page.captureScreenshot", { format: "png", captureBeyondViewport: !!params.full_page });
      return { image: { type: "image", data, mimeType: "image/png" } };
    }
    case "browser_click": {
      const { el } = await resolveRef(tabId, params.element_ref);
      await clickByPath(tabId, el.path);
      return snapshot(tabId);
    }
    case "browser_type": {
      const { el } = await resolveRef(tabId, params.element_ref);
      await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(el.path)}); el?.focus(); return true; })()`);
      await send(tabId, "Input.insertText", { text: String(params.text) });
      return snapshot(tabId);
    }
    case "browser_wait": {
      const deadline = Date.now() + (params.timeout_s || 15) * 1000;
      while (Date.now() < deadline) {
        const snap = await snapshot(tabId);
        const text = snap.title + " " + JSON.stringify(snap.elements);
        if (params.condition && text.includes(params.condition)) return snap;
        await new Promise((r) => setTimeout(r, 300));
      }
      return snapshot(tabId);
    }
    case "browser_close": {
      await chrome.tabs.remove(tabId);
      delete state.controlledTabs[device];
      return { closed: true };
    }
    default: throw new Error(`unknown browser tool: ${tool}`);
  }
}

async function waitLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const onEvent = (source, method) => {
      if (source.tabId === tabId && method === "Page.loadEventFired") {
        chrome.debugger.onEvent.removeListener(onEvent);
        resolve();
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    setTimeout(() => { chrome.debugger.onEvent.removeListener(onEvent); resolve(); }, timeoutMs);
  });
}
