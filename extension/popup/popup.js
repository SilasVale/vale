// Popup — talks to background.js via chrome.runtime messages.
const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  const pill = $("wsState");
  pill.textContent = s.wsState;
  pill.className = `pill ${s.wsState}`;
  if (s.device) {
    $("pairedCard").classList.remove("hidden");
    $("pairCard").classList.add("hidden");
    $("device").textContent = s.device;
    $("tabCount").textContent = String(s.controlledTabs?.length || 0);
    // Browser restart lost the session token — pairing must be redone (was
    // a silent un-pair with no explanation).
    const repair = $("needsRepair");
    if (repair) repair.classList.toggle("hidden", !s.needsRepair);
  } else {
    $("pairedCard").classList.add("hidden");
    $("pairCard").classList.remove("hidden");
  }
  showError(s.error || "");
}

function showError(msg) {
  $("error").textContent = msg;
  $("error").classList.toggle("hidden", !msg);
}

$("pair").addEventListener("click", async () => {
  const code = $("code").value.trim();
  if (!code) return;
  const r = await chrome.runtime.sendMessage({ type: "pair", code });
  if (r?.ok) { $("code").value = ""; await refresh(); }
  else showError(r?.error || "pair failed");
});

$("openTab").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "openTab" });
  if (!r?.ok) showError(r?.error || "open failed");
});

$("openTerminal").addEventListener("click", () => {
  // The terminal panel is served through the GATEWAY proxy
  // (/api/devices/<name>/proxy/panel/) — the console origin + /panel/ was a
  // dead link (gateway has no /panel route) and the device's own hostname is
  // never stored. The gateway authenticates proxied API calls with the
  // PLUGIN TOKEN (session storage, not local): browser navigation cannot
  // carry an Authorization header, so the token goes in the URL as ?token=
  // (the panel reads it and sends Bearer on every fetch; gateway accepts
  // ?token= only for this top-level navigation).
  chrome.storage.local.get(["consoleOrigin", "valePlugin"]).then(({ consoleOrigin, valePlugin }) => {
    const device = valePlugin?.device;
    const base = (consoleOrigin || "https://api.saisi.online").replace(/\/+$/, "");
    if (device) {
      chrome.storage.session.get("valePluginToken").then(({ valePluginToken }) => {
        const q = valePluginToken ? `?token=${encodeURIComponent(valePluginToken)}` : "";
        // A tokenless navigation still works: the persistent per-device
        // vale_pt_<device> cookie (30-day, HttpOnly) survives restarts and
        // authenticates the panel; if the cookie is also gone, the gateway
        // serves a readable re-pair page (not a raw 401) — never block the
        // Terminal button on a missing session token.
        chrome.tabs.create({ url: `${base}/api/devices/${device}/proxy/panel/${q}` });
      });
      return;
    }
    chrome.tabs.create({ url: `${base}/` });
  });
});

$("unpair").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "unpair" });
  if (r?.ok) { showError(""); await refresh(); }
  else showError(r?.error || "unpair failed");
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 2000);
