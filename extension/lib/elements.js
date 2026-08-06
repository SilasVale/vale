// Injected via Runtime.evaluate: walk the DOM (incl. open shadow roots), collect
// interactive elements with a stable CSS path per element. Returns JSON.
export const ELEMENTS_SCRIPT = `
(() => {
  const out = [];
  const seen = new Set();
  const INTERACTIVE = new Set(["A","BUTTON","INPUT","SELECT","TEXTAREA","SUMMARY","LABEL"]);
  function visible(el) {
    if (el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.opacity !== "0" && s.display !== "none";
  }
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel += "#" + CSS.escape(node.id); }
      else {
        const cls = [...node.classList].slice(0, 2).map(c => "." + CSS.escape(c)).join("");
        if (cls) sel += cls;
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(c => c.tagName === node.tagName);
          if (siblings.length > 1) sel += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(sel);
      if (node.parentElement && node.parentElement.host) {
        parts.unshift(":host");
        node = node.parentElement.host;
      } else {
        node = node.parentElement;
      }
    }
    return parts.join(" > ");
  }
  function walk(root) {
    const els = root.querySelectorAll("*");
    for (const el of els) {
      if (seen.has(el)) continue; seen.add(el);
      const tag = el.tagName;
      const role = el.getAttribute("role");
      if (!INTERACTIVE.has(tag) && !(role && /button|link|tab|menuitem|checkbox|radio|switch/.test(role)) && !el.getAttribute("onclick") && !(el.getAttribute("contenteditable") === "true")) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      let value = "";
      if (tag === "INPUT" || tag === "TEXTAREA") {
        value = (el.type === "password" || el.type === "hidden") ? "******" : (el.value || "");
      }
      out.push({
        ref: out.length,
        tag: tag.toLowerCase(),
        role: role || "",
        text: (el.innerText || el.textContent || "").trim().slice(0, 120),
        name: el.getAttribute("name") || el.getAttribute("aria-label") || "",
        type: el.getAttribute("type") || "",
        value,
        href: el.getAttribute("href") || "",
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: true,
        path: cssPath(el),
      });
      if (out.length >= 120) return;
    }
    if (root.shadowRoot) walk(root.shadowRoot);
  }
  walk(document);
  return JSON.stringify({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    elements: out,
  });
})()
`;
