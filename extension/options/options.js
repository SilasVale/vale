// options.js — origin + toggle for the DSH path rewriter. code-server is
// authenticated at the app layer (Cloudflare Access + the code-server
// password), so there is no per-extension token any more (ADR 0006).

const $ = (id) => document.getElementById(id);

async function load() {
  const st = await chrome.storage.local.get(["studioOrigin", "studioLinksEnabled"]);
  $("studioOrigin").value = st.studioOrigin || DEFAULT_STUDIO_ORIGIN;
  $("studioLinksEnabled").checked = st.studioLinksEnabled !== false;
}

async function save() {
  const raw = ($("studioOrigin").value.trim() || DEFAULT_STUDIO_ORIGIN).replace(/\/+$/, "");
  const origin = httpsOrigin(raw) || DEFAULT_STUDIO_ORIGIN;
  await chrome.storage.local.set({
    studioOrigin: origin,
    studioLinksEnabled: $("studioLinksEnabled").checked,
  });
  const el = $("status");
  el.textContent = `已保存: ${origin}`;
  setTimeout(() => (el.textContent = ""), 2500);
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
  $("studioLinksEnabled").addEventListener("change", (e) =>
    chrome.storage.local.set({ studioLinksEnabled: e.target.checked }),
  );
});
