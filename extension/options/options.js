// Options — Studio Links settings live in chrome.storage.local.
const $ = (id) => document.getElementById(id);

async function load() {
  const st = await chrome.storage.local.get(["studioOrigin", "studioToken", "studioLinksEnabled"]);
  $("studioOrigin").value = st.studioOrigin || DEFAULT_STUDIO_ORIGIN;
  $("studioToken").value = st.studioToken || "";
  $("studioLinksEnabled").checked = st.studioLinksEnabled !== false;
}

// Trust-but-verify: probe /api/roots with the credentials just saved so a
// typo'd origin or token surfaces here, instead of as silently missing links
// in the DSH panel (the same call the content script makes). Saving stays
// offline-first — the result is advice only, never a save blocker.
async function checkStudio(origin, token) {
  const el = $("check");
  el.classList.remove("hidden");
  el.style.color = "";
  el.textContent = "checking Studio connection…";
  let r;
  try {
    r = await fetch(origin + "/api/roots", { headers: studioAuthHeaders(origin, token) });
  } catch {
    el.textContent = "unreachable (network error) — saved anyway; check the origin or network.";
    el.style.color = "var(--danger)";
    return;
  }
  if (r.status === 401) {
    el.textContent = "401 — token rejected; check the Studio token.";
    el.style.color = "var(--danger)";
    return;
  }
  if (!r.ok) {
    el.textContent = `Studio answered HTTP ${r.status} — saved anyway.`;
    el.style.color = "var(--danger)";
    return;
  }
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* malformed body */
  }
  if (!data || !Array.isArray(data.roots)) {
    el.textContent = "Studio answered but the response was malformed — saved anyway.";
    el.style.color = "var(--danger)";
    return;
  }
  const n = data.roots.length;
  el.textContent = `token OK (${n} root${n === 1 ? "" : "s"})`;
  el.style.color = "var(--accent)";
}

$("save").addEventListener("click", async () => {
  const raw = ($("studioOrigin").value.trim() || DEFAULT_STUDIO_ORIGIN).replace(/\/+$/, "");
  // https-only + strip to the bare origin (canonical guard in shared.js): the
  // studio token is sent as a Bearer credential — an http:// origin would leak
  // it to a MITM over cleartext.
  const studio = httpsOrigin(raw);
  const s = $("saved");
  if (!studio) {
    s.textContent = "studio origin must use an https:// URL";
    s.classList.remove("hidden");
    s.style.color = "var(--danger)";
    $("check").classList.add("hidden");
    setTimeout(() => { s.classList.add("hidden"); s.style.color = ""; }, 3000);
    return;
  }
  const token = $("studioToken").value.trim();
  await chrome.storage.local.set({
    studioOrigin: studio,
    studioToken: token,
    studioLinksEnabled: $("studioLinksEnabled").checked,
  });
  s.textContent = "Saved";
  s.classList.remove("hidden");
  s.style.color = "";
  setTimeout(() => s.classList.add("hidden"), 1500);
  checkStudio(studio, token); // fire-and-forget; result lands in #check
});

load();
