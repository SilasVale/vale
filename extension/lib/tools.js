import { ensureTab, send } from "./cdp.js";
import { ELEMENTS_SCRIPT } from "./elements.js";
import { state, setStateError } from "./state.js";

// consoleOrigin is read async in background.js and injected into this module.
export let CONSOLE_ORIGIN = "";
export function setConsoleOrigin(o) { CONSOLE_ORIGIN = o; }

function proxyUrl(device) {
  // The gateway proxy requires an admin session cookie OR a plugin token;
  // a top-level navigation can't carry an Authorization header, so pass the
  // plugin token as ?token= (gateway accepts it for proxy top-level nav and
  // sets Cache-Control: no-store). The plugin token is scoped to this device.
  const t = state.pairedDevice?.token || "";
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  return `${CONSOLE_ORIGIN}/api/devices/${device}/proxy/${q}`;
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
// Build an in-page expression that re-resolves a snapshot element by its
// path. chain[0] is resolved via document.querySelector (light DOM), each
// following selector via the previous level's shadowRoot — document.querySelector
// cannot match :host, so shadow elements walk the host chain instead. `path`
// is the light-DOM selector, or null when the element lives in an open shadow
// root — then the full chain (light-DOM selector first) is in `shadowPath`.
// mode "rect" returns the element's rect (or null), mode "focus" focuses it
// and returns true (or false) — the caller throws on null/false.
export function reResolveExpr(el, mode) {
  const chain = el.path ? [el.path, ...(el.shadowPath || [])] : (el.shadowPath || []);
  const miss = mode === "focus" ? "false" : "null";
  if (!chain.length) return `(() => ${miss})()`;
  let steps = "";
  for (let i = 0; i < chain.length; i++) {
    const q = i === 0
      ? `document.querySelector(${JSON.stringify(chain[i])})`
      : `_el.shadowRoot.querySelector(${JSON.stringify(chain[i])})`;
    steps += `${i === 0 ? "let " : ""}_el = ${q};\n    if (!_el) return ${miss};\n    `;
  }
  // Return a plain object, not the DOMRect itself — CDP `returnByValue`
  // serializes plain objects but drops DOMRect's read-only props, which made
  // `Input.dispatchMouseEvent` fail with "params.x: mandatory field missing".
  steps += mode === "focus"
    ? "_el.focus();\n    return true;"
    : "const r = _el.getBoundingClientRect();\n    return { x: r.x, y: r.y, width: r.width, height: r.height };";
  return `(() => {\n  try {\n    ${steps}\n  } catch { return ${miss}; }\n})()`;
}

async function clickByPath(tabId, el) {
  // Re-resolve the path in-page; if it fails, DOM changed → re-snapshot.
  // Scroll the element into view FIRST: an off-viewport element's rect lands
  // the click on whatever is at those page coords (silently wrong action).
  await evaluate(tabId, `(() => { const _p = ${JSON.stringify(el.path)}; const e = _p ? document.querySelector(_p) : null; if (e) e.scrollIntoView({block:"center"}); return true; })()`);
  const found = await evaluate(tabId, reResolveExpr(el, "rect"));
  if (!found) throw new Error("DOM changed — please re-snapshot");
  // getBoundingClientRect() returns VIEWPORT coords — after scrollIntoView the
  // element is on-screen, so these are directly usable by dispatchMouseEvent.
  const x = found.x + found.width / 2, y = found.y + found.height / 2;
  // Hit-test: a fixed overlay/modal at this point would intercept the click —
  // elementFromPoint tells us what is ACTUALLY at the target coords.
  const hit = await evaluate(tabId, `(() => {
    const e = document.elementFromPoint(${x}, ${y});
    if (!e) return null;
    const target = document.querySelector(${JSON.stringify(el.path)});
    return (e === target || target?.contains(e) || e?.contains(target)) ? true : { tag: e.tagName, text: (e.textContent || '').slice(0, 40) };
  })()`);
  if (hit && hit !== true) {
    throw new Error(`click intercepted by ${hit.tag || "element"} ("${hit.text || ""}") — an overlay is covering the target`);
  }
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function runTool(tool, params) {
  const device = params.device;
  const tabId = await ensureTab(device, proxyUrl(device));
  switch (tool) {
    case "browser_open": {
      // Scheme allowlist: file:// would let CDP navigate to and screenshot
      // local files; chrome:// and others are internal. Only http(s) is a
      // legit target for a browsing agent.
      let u;
      try { u = new URL(params.url); } catch { throw new Error(`invalid URL: ${params.url}`); }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error(`unsupported URL scheme: ${u.protocol} — only http(s) allowed`);
      }
      await send(tabId, "Page.navigate", { url: u.href });
      // 5s cap: SPA/fragment navigations never fire loadEventFired, so the
      // full 30s stall was the norm for them; 5s is enough for a real load.
      await waitLoad(tabId, 5_000);
      return snapshot(tabId);
    }
    case "browser_snapshot": return snapshot(tabId);
    case "browser_screenshot": {
      // full_page on a very long page produced images the model API rejects —
      // clamp the capture to 8000px tall (viewport width).
      const shotParams = { format: "png", captureBeyondViewport: !!params.full_page };
      if (params.full_page) {
        const dims = await evaluate(tabId, `(() => { const s = document.scrollingElement || document.documentElement; return { w: s.clientWidth, h: s.scrollHeight }; })()`);
        if (dims && dims.h > 8000) {
          shotParams.captureBeyondViewport = false;
        }
      }
      const { data } = await send(tabId, "Page.captureScreenshot", shotParams);
      return { image: { type: "image", data, mimeType: "image/png" } };
    }
    case "browser_click": {
      const { el } = await resolveRef(tabId, params.element_ref);
      await clickByPath(tabId, el);
      return snapshot(tabId);
    }
    case "browser_type": {
      const { el } = await resolveRef(tabId, params.element_ref);
      const focused = await evaluate(tabId, reResolveExpr(el, "focus"));
      if (!focused) throw new Error("DOM changed — please re-snapshot");
      // Element.focus() is a silent no-op on disabled/non-focusable elements —
      // verify the ACTIVE element really is the target before typing, or the
      // text goes nowhere (or into a different field).
      const ok = await evaluate(tabId, `(() => {
        const target = document.querySelector(${JSON.stringify(el.path)});
        return document.activeElement === target ? true : { active: (document.activeElement?.tagName || '') + '#' + (document.activeElement?.id || '') };
      })()`);
      if (ok !== true) {
        throw new Error(`type target not focused (active: ${ok?.active || "?"}) — click it first`);
      }
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
      setStateError(null); // a stale detach error must not survive a clean close
      return { closed: true };
    }
    default: throw new Error(`unknown browser tool: ${tool}`);
  }
}

async function waitLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    // Page.loadEventFired fires PER FRAME with a frameId — a subframe's load
    // (ads, iframes) previously resolved the wait early, long before the main
    // document finished. Only resolve on the MAIN frame (frameId === loaderId
    // is the CDP marker for the top document's load).
    const onEvent = (source, method, params) => {
      if (source.tabId === tabId && method === "Page.loadEventFired" && params?.frameId === params?.loaderId) {
        chrome.debugger.onEvent.removeListener(onEvent);
        resolve();
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    setTimeout(() => { chrome.debugger.onEvent.removeListener(onEvent); resolve(); }, timeoutMs);
  });
}
