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
  // CSS path for el. Returns { light, shadows }: "light" is a selector
  // resolvable from document (in the light DOM, ending at the outermost
  // shadow host when el is inside a shadow tree); "shadows" are per-level
  // selectors, each resolved via the previous level's shadowRoot — no :host
  // (document.querySelector cannot match it; re-resolution walks the host
  // chain instead).
  function cssPath(el) {
    const segs = []; // selectors from el upward, "@" marks a shadow boundary
    let node = el;
    while (node && node.nodeType === 1) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel += "#" + CSS.escape(node.id); }
      else {
        const cls = [...node.classList].slice(0, 2).map(c => "." + CSS.escape(c)).join("");
        if (cls) sel += cls;
        const parent = node.parentNode;
        if (parent && parent.nodeType === 1) { // siblings within the same tree
          const siblings = [...parent.children].filter(c => c.tagName === node.tagName);
          if (siblings.length > 1) sel += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
      }
      segs.push(sel);
      const parent = node.parentNode;
      if (parent && parent.nodeType === 11 && parent.host) {
        segs.push("@"); // parent is a shadow root — continue from its host
        node = parent.host;
      } else {
        node = parent && parent.nodeType === 1 ? parent : null;
      }
    }
    // Split the bottom-up selector list at each shadow boundary: the first
    // level is the light-DOM path, each following level sits in the previous
    // level's shadow root.
    const levels = [];
    let cur = [];
    for (const s of segs.reverse()) {
      if (s === "@") { levels.push(cur); cur = []; }
      else cur.push(s);
    }
    levels.push(cur);
    return { light: levels[0].join(" > "), shadows: levels.slice(1).map(l => l.join(" > ")) };
  }
  function walk(root) {
    const els = root.querySelectorAll("*");
    for (const el of els) {
      if (out.length >= 120) return;
      if (seen.has(el)) continue; seen.add(el);
      // Open shadow roots aren't in querySelectorAll — recurse into them
      // before the filters: hosts are usually non-interactive wrappers, and
      // their visibility says nothing about the shadow content's.
      if (el.shadowRoot) walk(el.shadowRoot);
      const tag = el.tagName;
      const role = el.getAttribute("role");
      // round-84: contenteditable="" and contenteditable="plaintext-only"
      // are editable too — the old `=== "true"` filter dropped them, so the
      // agent could never type into contenteditable editors.
      const editable = el.getAttribute("contenteditable");
      if (!INTERACTIVE.has(tag) && !(role && /button|link|tab|menuitem|checkbox|radio|switch/.test(role)) && !el.getAttribute("onclick") && !(editable === "true" || editable === "" || editable === "plaintext-only")) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      let value = "";
      if (tag === "INPUT" || tag === "TEXTAREA") {
        value = (el.type === "password" || el.type === "hidden") ? "******" : (el.value || "");
      }
      const { light, shadows } = cssPath(el);
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
        // path is the light-DOM selector; elements inside open shadow roots
        // get path: null plus shadowPath ([light selector, shadow selectors…]).
        path: shadows.length ? null : light,
        ...(shadows.length ? { shadowPath: [light, ...shadows] } : {}),
      });
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
