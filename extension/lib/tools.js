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
  const resp = await send(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
  // round-94: CDP puts exceptionDetails at the TOP level of the
  // Runtime.evaluate response, not inside `result` — the old check on
  // result.exceptionDetails never fired, so page exceptions were silently
  // treated as success (a broken snapshot/click script returned undefined
  // instead of an error).
  if (resp?.exceptionDetails) throw new Error(`page evaluate failed: ${resp.exceptionDetails.text || "exception"}`);
  return resp?.result?.value;
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
  // round-84: refs are ordinal positions — after a navigation the same ref
  // may silently point at a DIFFERENT element (the old code clicked/typed
  // the wrong target with no error). Verify the snapshot's rect still
  // matches what's on screen; a mismatch means the DOM changed.
  const live = await evaluate(tabId, `(() => {
    const chain = ${JSON.stringify(el.path ? [el.path, ...(el.shadowPath || [])] : (el.shadowPath || []))};
    let target = null;
    for (let i = 0; i < chain.length; i++) {
      target = i === 0 ? document.querySelector(chain[i]) : target && target.shadowRoot ? target.shadowRoot.querySelector(chain[i]) : null;
      if (!target) break;
    }
    if (!target) return { gone: true };
    const r = target.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (live?.gone) throw new Error(`element ref ${ref} is gone — DOM changed, re-snapshot`);
  const s = el.rect, l = live;
  if (l) {
    // round-88: a strict 4px comparison false-positived on animating /
    // layout-shifting elements (spinners, expanding panels) — every click
    // failed with 'moved'. Only treat a CENTER displacement larger than the
    // element's own size as a real DOM change (a navigation replaces the
    // element wholesale; an animation stays within its box).
    const scx = s.x + s.w / 2, scy = s.y + s.h / 2;
    const lcx = l.x + l.w / 2, lcy = l.y + l.h / 2;
    const dx = Math.abs(scx - lcx), dy = Math.abs(scy - lcy);
    const size = Math.max(s.w, s.h, 1);
    if (dx > size / 2 || dy > size / 2) {
      throw new Error(`element ref ${ref} moved — DOM changed, re-snapshot`);
    }
  }
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
    : mode === "hit"
      ? "return _el;" // element ref for hit-testing (shadow-chain aware)
      : "const r = _el.getBoundingClientRect();\n    return { x: r.x, y: r.y, width: r.width, height: r.height };";
  return `(() => {\n  try {\n    ${steps}\n  } catch { return ${miss}; }\n})()`;
}

async function clickByPath(tabId, el) {
  // Re-resolve the path in-page; if it fails, DOM changed → re-snapshot.
  // Scroll the element into view FIRST: an off-viewport element's rect lands
  // the click on whatever is at those page coords (silently wrong action).
  // round-88: scroll through the shadow chain too — the old document
  // .querySelector(el.path) was null for shadow elements (path:null), so
  // below-the-fold shadow targets were never scrolled and the click silently
  // hit whatever was at those page coords.
  await evaluate(tabId, `(() => {
    const chain = ${JSON.stringify(el.path ? [el.path, ...(el.shadowPath || [])] : (el.shadowPath || []))};
    let t = null;
    for (let i = 0; i < chain.length; i++) {
      t = i === 0 ? document.querySelector(chain[i]) : t && t.shadowRoot ? t.shadowRoot.querySelector(chain[i]) : null;
      if (!t) break;
    }
    if (t) t.scrollIntoView({block:"center"});
    return true;
  })()`);
  const found = await evaluate(tabId, reResolveExpr(el, "rect"));
  if (!found) throw new Error("DOM changed — please re-snapshot");
  // getBoundingClientRect() returns VIEWPORT coords — after scrollIntoView the
  // element is on-screen, so these are directly usable by dispatchMouseEvent.
  const x = found.x + found.width / 2, y = found.y + found.height / 2;
  // Hit-test: a fixed overlay/modal at this point would intercept the click —
  // elementFromPoint tells us what is ACTUALLY at the target coords.
  // round-84: resolve the target through the shadow chain (el.path is null
  // for shadow elements — document.querySelector(null) matched nothing and
  // every shadow click falsely threw 'click intercepted').
  const hit = await evaluate(tabId, `(() => {
    const e = document.elementFromPoint(${x}, ${y});
    if (!e) return null;
    const chain = ${JSON.stringify(el.path ? [el.path, ...(el.shadowPath || [])] : (el.shadowPath || []))};
    let target = null;
    for (let i = 0; i < chain.length; i++) {
      target = i === 0 ? document.querySelector(chain[i]) : target && target.shadowRoot ? target.shadowRoot.querySelector(chain[i]) : null;
      if (!target) break;
    }
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
      let clipped = false;
      if (params.full_page) {
        const dims = await evaluate(tabId, `(() => { const s = document.scrollingElement || document.documentElement; return { w: s.clientWidth, h: s.scrollHeight }; })()`);
        if (dims && dims.h > 8000) {
          // round-84: a full_page capture over 8000px tall produced images
          // the model API rejects — clamp to viewport, but TELL the caller
          // (the old code silently returned a viewport-only image that
          // looked like a full capture).
          shotParams.captureBeyondViewport = false;
          clipped = true;
        }
      }
      const { data } = await send(tabId, "Page.captureScreenshot", shotParams);
      const img = { type: "image", data, mimeType: "image/png" };
      if (clipped) (img as any).note = "full_page clipped to viewport (page >8000px tall)";
      return { image: img };
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
      // round-84: resolve through the shadow chain (el.path is null for
      // shadow elements — the old document.querySelector(null) comparison
      // always threw 'type target not focused').
      const ok = await evaluate(tabId, `(() => {
        const chain = ${JSON.stringify(el.path ? [el.path, ...(el.shadowPath || [])] : (el.shadowPath || []))};
        let target = null;
        for (let i = 0; i < chain.length; i++) {
          target = i === 0 ? document.querySelector(chain[i]) : target && target.shadowRoot ? target.shadowRoot.querySelector(chain[i]) : null;
          if (!target) break;
        }
        if (!target) return { gone: true };
        // round-84: typing into a readonly/disabled field silently did
        // nothing — fail loudly instead so the agent knows to pick another
        // element (the snapshot never exposed readonly).
        if ((target as any).readOnly || (target as any).disabled || (target as any).ariaDisabled === "true") {
          return { readonly: true };
        }
        return document.activeElement === target ? true : { active: (document.activeElement?.tagName || '') + '#' + (document.activeElement?.id || '') };
      })()`);
      if (ok !== true) {
        if (ok?.gone) throw new Error("type target gone — DOM changed, re-snapshot");
        if (ok?.readonly) throw new Error("type target is read-only/disabled — cannot type into it");
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
    // round-84: Page.loadEventFired has NO frameId/loaderId params (only
    // timestamp), so the old `params?.frameId === params?.loaderId` filter
    // was `undefined === undefined` — always true, and any subframe's load
    // (ads, iframes) resolved the wait early. Page.frameStoppedLoading DOES
    // carry a frameId: resolve only when it is the top frame's loaderId.
    let loaderId = null;
    const onEvent = (source, method, params) => {
      if (source.tabId !== tabId) return;
      if (method === "Page.frameStartedLoading") {
        // The top frame's loaderId is reported on the FIRST frame event;
        // capture it so a later frameStoppedLoading for the SAME loaderId is
        // the main document's load.
        if (!loaderId && params?.frameId) loaderId = params.frameId;
      } else if (method === "Page.frameStoppedLoading" && params?.frameId === loaderId) {
        chrome.debugger.onEvent.removeListener(onEvent);
        resolve();
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    setTimeout(() => { chrome.debugger.onEvent.removeListener(onEvent); resolve(); }, timeoutMs);
  });
}
