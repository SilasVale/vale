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
  // The terminal panel is served by the DEVICE (vale-agent at
  // https://dN.agent.saisi.online/panel/), not the gateway console — the
  // console origin + /panel/ was a dead link (gateway has no /panel route).
  // Open the paired device's panel directly; fall back to the console's
  // device list (where each device links its panel).
  chrome.storage.local.get(["consoleOrigin", "valePlugin"]).then(({ consoleOrigin, valePlugin }) => {
    // pairedDevice.hostname NEVER exists (pairing stores {device, token} only)
    // — this branch was dead. Route through the gateway proxy like openTab.
    const device = valePlugin?.device;
    const base = (consoleOrigin || "https://api.saisi.online").replace(/\/+$/, "");
    if (device) {
      chrome.tabs.create({ url: `${base}/api/devices/${device}/proxy/panel/` });
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
