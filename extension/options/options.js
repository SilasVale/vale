// Options — Studio Links settings live in chrome.storage.local.
const $ = (id) => document.getElementById(id);
const DEFAULT_STUDIO_ORIGIN = "https://code.saisi.online";

async function load() {
  const st = await chrome.storage.local.get(["studioOrigin", "studioToken", "studioLinksEnabled"]);
  $("studioOrigin").value = st.studioOrigin || DEFAULT_STUDIO_ORIGIN;
  $("studioToken").value = st.studioToken || "";
  $("studioLinksEnabled").checked = st.studioLinksEnabled !== false;
}

$("save").addEventListener("click", async () => {
  let studio = ($("studioOrigin").value.trim() || DEFAULT_STUDIO_ORIGIN).replace(/\/+$/, "");
  // https-only: the studio token is sent as a Bearer credential — an
  // http:// origin would leak it to a MITM over cleartext.
  try {
    const u = new URL(studio);
    if (u.protocol !== "https:") throw new Error("must be https://");
    studio = u.origin; // strip path/query — only the origin is used
  } catch {
    const s = $("saved");
    s.textContent = "studio origin must use an https:// URL";
    s.classList.remove("hidden");
    s.style.color = "var(--danger)";
    setTimeout(() => { s.classList.add("hidden"); s.style.color = ""; }, 3000);
    return;
  }
  await chrome.storage.local.set({
    studioOrigin: studio,
    studioToken: $("studioToken").value.trim(),
    studioLinksEnabled: $("studioLinksEnabled").checked,
  });
  const s = $("saved");
  s.textContent = "Saved";
  s.classList.remove("hidden");
  s.style.color = "";
  setTimeout(() => s.classList.add("hidden"), 1500);
});

load();
